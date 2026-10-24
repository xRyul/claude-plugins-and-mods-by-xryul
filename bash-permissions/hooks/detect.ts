import { inlineCode, scriptsInCode } from "./code";
import { DANGER_RULES, type DangerRule, type Dialect } from "./rules";
import { expandVariables, findStartPaths, resolveTarget } from "./rules/paths";
import { parseScript, type SimpleCommand } from "./shell";

export interface DangerMatch {
	rule: DangerRule;
	/** argv the rule matched, wrappers removed. */
	words: string[];
}

/** Where the command runs, so rules about paths can tell the project from the rest of the disk. */
export interface DetectContext {
	/** The shell's working directory. */
	cwd?: string;
	/** The directory the Claude Code session runs in. */
	project?: string;
	home?: string;
}

/** Where one script runs: its directory changes with each `cd`, and it may run remotely or under Windows. */
type Scope = DetectContext & { dialect: Dialect; isRemote: boolean; variables?: Record<string, string> };

const MAX_DEPTH = 8;
const RULE_BY_ID = new Map(DANGER_RULES.map((rule) => [rule.id, rule]));
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);

/** Words that may lead a command without being it (`do git push`, `! rm -rf x`). */
const LEADING_RESERVED = new Set(["!", "{", "}", "if", "then", "else", "elif", "do", "while", "until", "fi", "done", "esac"]);
/** Commands that list words and run none of them (`for f in a b`, `case $x in`). */
const LISTING_ONLY = new Set(["for", "select", "case", "function"]);

/** Global options that take a separate value, per tool, so `git -C dir push` reads as `git push`. */
const GLOBAL_OPTIONS_WITH_VALUE: Record<string, ReadonlySet<string>> = {
	git: new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env"]),
	gt: new Set(["--cwd"]),
	kubectl: new Set(["-n", "--namespace", "--context", "--kubeconfig", "--cluster", "--user", "-s", "--server"]),
	pscale: new Set(["--org", "--config", "--api-token", "--api-url", "--service-token", "--service-token-id"]),
	pnpm: new Set(["-C", "--dir", "--filter", "-F", "--reporter", "--loglevel", "--workspace-concurrency"]),
	npm: new Set(["-w", "--workspace", "--prefix", "--loglevel", "--registry", "--userconfig"]),
	yarn: new Set(["--cwd"]),
	bun: new Set(["--cwd", "-c", "--config", "--filter", "-F"]),
	wrangler: new Set(["-c", "--config", "-e", "--env", "--cwd", "--env-file"]),
	stripe: new Set(["--api-key", "--project-name", "-p", "--config", "--device-name", "--log-level", "--color"]),
	docker: new Set(["-H", "--host", "-c", "--context", "--config", "-l", "--log-level"]),
	helm: new Set(["-n", "--namespace", "--kube-context", "--kubeconfig"]),
	pulumi: new Set(["-C", "--cwd"]),
};

/** Tools a package runner starts by name (`pnpm wrangler deploy`, `npx drizzle-kit push`). */
const PACKAGE_BINS = new Set([
	"wrangler", "drizzle-kit", "prisma", "vercel", "stripe", "clerk", "resend", "upstash", "pulumi", "fly", "flyctl",
	"helm", "terraform", "kubectl", "gt", "pscale", "ntn", "obsidian", "gh", "redis-cli",
]);
const RUNNER_EXEC_OPTIONS = new Set(["-p", "--package", "-c", "--call", "--shell-mode"]);

/**
 * A script that is nothing but a download (`"$(curl …)"`, `<(wget …)`), so nobody has read it.
 * `out=$(curl …)` inside a longer script only stores a response.
 */
const DOWNLOAD = /^\s*\$\(\s*(?:[\w./-]*\/)?(curl|wget|xh|https?|aria2c|fetch)\b[\s\S]*\)\s*$/;

const SCRIPT_VALUE_OPTIONS = new Set(["-E", "--echo", "-I", "--log-in", "-O", "--log-out", "-B", "--log-io", "-T", "--log-timing", "-m", "--logging-format", "-o", "--output-limit"]);
const PARALLEL_VALUE_OPTIONS = new Set([
	"-j", "--jobs", "-P", "--max-procs", "-S", "--sshlogin", "--halt", "-N", "-n", "--max-args", "-L", "--max-lines",
	"--delay", "--timeout", "--tag-string", "--env", "--joblog", "--results", "--tmpdir", "--workdir", "--wd", "-I",
	"--replace", "--colsep", "-C", "-a", "--arg-file", "-d", "--delimiter",
]);
/** Combinations of `:::` inputs to check run by run; past this, each input is checked on its own. */
const MAX_PARALLEL_RUNS = 500;
/** An input only run time knows. Its `$(…)` resolves to no path, so path rules count it as risky. */
const UNKNOWN_INPUT = "$(…)";
const SSH_VALUE_OPTIONS = new Set(["-B", "-b", "-c", "-D", "-E", "-e", "-F", "-I", "-i", "-J", "-L", "-l", "-m", "-O", "-o", "-p", "-Q", "-R", "-S", "-W", "-w"]);
const WSL_VALUE_OPTIONS = new Set(["-d", "--distribution", "-u", "--user", "--cd", "--shell-type"]);
const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * The words a wrapper hands on as one script (`ssh host …`, `wsl …`, `powershell -c …`). A lone
 * word is the script as written; several are joined, quoting those with spaces so
 * `wsl -- bash -c 'git push --force'` still reads as one `-c` string.
 */
function joinWords(words: string[]): string {
	if (words.length === 1) return words[0] ?? "";
	return words.map(quoteWord).join(" ");
}

function quoteWord(word: string): string {
	return /[\s'"]/.test(word) ? `'${word.replace(/'/g, `'\\''`)}'` : word;
}

function basename(executable: string): string {
	return executable.includes("/") ? executable.slice(executable.lastIndexOf("/") + 1) : executable;
}

/** The command's words with each substitution written back as `$(…)`, so later steps know a word is built at run time. */
function markWords(command: SimpleCommand): string[] {
	return command.words.map((word, i) => word + (command.substitutions[i] ?? []).map((inner) => `$(${inner})`).join(""));
}

/** Where the command's own name is: past `FOO=bar` assignments and reserved words. */
function nameIndex(words: string[]): number {
	let start = 0;
	while (start < words.length) {
		const word = words[start] ?? "";
		if (!LEADING_RESERVED.has(word) && !/^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(word)) break;
		start++;
	}
	return start;
}

/** Drops `FOO=bar` assignments and reserved words before the command, and reduces `/usr/bin/git` to `git`. */
function normalize(words: string[]): string[] {
	const rest = words.slice(nameIndex(words));
	if (rest.length === 0 || LISTING_ONLY.has(rest[0] ?? "")) return [];
	return [basename(rest[0] ?? ""), ...rest.slice(1)];
}

/**
 * A command name the script set in a variable (`g=git; $g push`). Unquoted it
 * splits on spaces as the shell does (`c='git push'; $c`); `"$c"` stays one word.
 */
function expandName(words: string[], quoted: boolean[], scope: Scope): string[] {
	const index = nameIndex(words);
	const name = /^\$\{?([A-Za-z_]\w*)\}?$/.exec(words[index] ?? "")?.[1];
	const value = name === undefined ? undefined : scope.variables?.[name];
	if (value === undefined) return words;
	const replacement = quoted[index] ? [value] : value.split(/\s+/).filter(Boolean);
	return [...words.slice(0, index), ...replacement, ...words.slice(index + 1)];
}

function stripGlobalOptions(words: string[]): string[] {
	const withValue = GLOBAL_OPTIONS_WITH_VALUE[words[0] ?? ""];
	if (!withValue) return words;
	let i = 1;
	while (i < words.length && (words[i] ?? "").startsWith("-") && words[i] !== "--") {
		i += withValue.has(words[i] ?? "") ? 2 : 1;
	}
	return [words[0] ?? "", ...words.slice(i)];
}

/**
 * Skips a wrapper's options and returns what follows: `withValue` options take
 * the next word, `--` ends the options, and the first other word is the command.
 */
function afterOptions(words: string[], withValue: ReadonlySet<string>, from = 1): string[] {
	let i = from;
	while (i < words.length) {
		const word = words[i] ?? "";
		if (word === "--") return words.slice(i + 1);
		if (!word.startsWith("-") || word === "-") break;
		i += withValue.has(word) ? 2 : 1;
	}
	return words.slice(i);
}

interface Unwrapped {
	/** The command the wrapper runs, still to be matched. */
	next?: string[];
	/** Scripts the wrapper runs, read like the top-level command. */
	scripts?: string[];
	/** Where those scripts run, when not where the wrapper does (`ssh`, `powershell.exe`). */
	scope?: Partial<Scope>;
	/** Further commands it runs (`find -exec`). */
	commands?: string[][];
	/** True when it runs a script nobody can read first. */
	runsUnseenScript?: boolean;
}

/** `find -exec cmd {} ;`: `{}` stands for each path found, a child of where find starts. */
function findExecs(words: string[]): string[][] {
	const start = (findStartPaths(words)[0] ?? ".").replace(/\/+$/, "");
	const commands: string[][] = [];
	for (let i = 1; i < words.length; i++) {
		if (!["-exec", "-execdir", "-ok", "-okdir"].includes(words[i] ?? "")) continue;
		const end = words.findIndex((word, index) => index > i && (word === ";" || word === "+"));
		const stop = end === -1 ? words.length : end;
		commands.push(words.slice(i + 1, stop).map((word) => (word === "{}" ? `${start}/{}` : word)));
		i = stop;
	}
	return commands;
}

/**
 * The words `xargs` appends to its command. Written out in the command, they are
 * read as written: `echo a b |`, a here-string, a heredoc. Read at run time
 * (`ls |`, `< list.txt`, `-a list.txt`), they are unknown, so path rules ask.
 */
function xargsInputs(words: string[], command: SimpleCommand): string[] {
	if (words.some((word) => /^-a./.test(word) || word === "-a" || word.startsWith("--arg-file"))) return [UNKNOWN_INPUT];
	if (command.pipedFrom) {
		const [name, ...args] = normalize(markWords(command.pipedFrom));
		return name === "echo" || name === "printf" ? args.filter((word) => !word.startsWith("-")) : [UNKNOWN_INPUT];
	}
	const hereString = command.redirects.find((redirect) => redirect.operator === "<<<");
	if (hereString) return hereString.target.split(/\s+/).filter(Boolean);
	if (command.heredocs.length > 0) return command.heredocs.join("\n").split(/\s+/).filter(Boolean);
	return command.hasStdinRedirect ? [UNKNOWN_INPUT] : [];
}

/** The script text `echo`/`printf`/`cat <<EOF` pipes into a shell. */
function pipedScripts(source: SimpleCommand): string[] {
	const [name, ...args] = normalize(markWords(source));
	if (name === "cat") return source.heredocs;
	if (name !== "echo" && name !== "printf") return [];
	return [args.filter((w) => !/^-[neE]+$/.test(w)).join(" ").replace(/\\n/g, "\n")];
}

/** What a shell runs: its `-c` string, a heredoc, or what is piped in. A script file it reads stays unread. */
function shellCall(words: string[], command: SimpleCommand): Unwrapped | undefined {
	let readsInline = false;
	let readsStdin = false;
	let operand: string | undefined;
	for (let i = 1; i < words.length; i++) {
		const word = words[i] ?? "";
		if (word === "--") {
			operand = words[i + 1];
			break;
		}
		if (word.startsWith("--")) continue;
		if (word.length > 1 && (word.startsWith("-") || word.startsWith("+"))) {
			readsInline ||= word.includes("c");
			readsStdin ||= word.includes("s");
			// `-o pipefail`, `-euo pipefail`: the option name is the next word.
			if (word.endsWith("o")) i++;
			continue;
		}
		operand = word;
		break;
	}

	if (readsInline) return operand === undefined ? undefined : { scripts: [operand], runsUnseenScript: DOWNLOAD.test(operand) };
	if (operand !== undefined && operand !== "-" && !readsStdin) {
		// A script file: unreadable here, and unseen when it is a download (`bash <(curl …)`).
		return DOWNLOAD.test(operand) ? { runsUnseenScript: true } : undefined;
	}
	if (command.pipedFrom) return { scripts: pipedScripts(command.pipedFrom), runsUnseenScript: true };
	return command.heredocs.length > 0 ? { scripts: command.heredocs } : undefined;
}

/** `script -qc 'cmd' log` (util-linux) reads its `-c` string as a script; `script -q log cmd …` (BSD) runs the rest. */
function scriptCall(words: string[]): Unwrapped {
	for (let i = 1; i < words.length && (words[i] ?? "").startsWith("-"); i++) {
		const word = words[i] ?? "";
		if (word.startsWith("--command=")) return { scripts: [word.slice("--command=".length)] };
		if (word === "--command" || /^-[a-zA-Z]*c$/.test(word)) return { scripts: [words[i + 1] ?? ""] };
		if (SCRIPT_VALUE_OPTIONS.has(word)) i++;
	}
	const [, ...command] = afterOptions(words, SCRIPT_VALUE_OPTIONS);
	return { next: command };
}

/** The input groups of `parallel`'s arguments: each `:::` group as written, `::::` (from files) as unknown. */
function parallelInputs(args: string[]): string[][] {
	const groups: string[][] = [];
	let readsFiles = false;
	for (const word of args) {
		if (/^::::?\+?$/.test(word)) {
			readsFiles = word.startsWith("::::");
			groups.push(readsFiles ? [UNKNOWN_INPUT] : []);
		} else if (!readsFiles) {
			groups.at(-1)?.push(word);
		}
	}
	return groups.filter((group) => group.length > 0);
}

/** `{}` takes the run's inputs, `{1}` its first; `{.}`, `{/}`, `{//}` and `{/.}` stand for the input too. */
function fillPlaceholders(text: string, inputs: string[]): string {
	return text.replace(/\{(\d*)[./]*\}/g, (_, n: string) => (n ? (inputs[Number(n) - 1] ?? "") : inputs.join(" ")));
}

/**
 * `parallel cmd ::: a b` runs `cmd a` and `cmd b`, or puts the inputs where `{}`
 * stands; several `:::` groups run every combination. A quoted `'cmd {}'` runs
 * through the shell, and with no command the inputs are the commands. Inputs
 * from files (`::::`) or stdin (no `:::`) are unknown, so path rules ask.
 *
 * Every input is checked: each run up to MAX_PARALLEL_RUNS, past that each
 * input on its own, so padding the list cannot hide a risky one.
 */
function parallelCall(words: string[]): Unwrapped {
	const rest = afterOptions(words, PARALLEL_VALUE_OPTIONS);
	const first = rest.findIndex((word) => /^::::?\+?$/.test(word));
	const template = first === -1 ? rest : rest.slice(0, first);
	const groups = first === -1 ? [[UNKNOWN_INPUT]] : parallelInputs(rest.slice(first));

	if (template.length === 0) {
		const commands = groups.flat();
		return { scripts: commands.filter((script) => script !== UNKNOWN_INPUT), runsUnseenScript: commands.includes(UNKNOWN_INPUT) };
	}

	const combinations = groups.reduce((count, group) => count * group.length, 1);
	const runs =
		combinations <= MAX_PARALLEL_RUNS
			? groups.reduce<string[][]>((partial, group) => partial.flatMap((run) => group.map((input) => [...run, input])), [[]])
			: groups.flat().map((input) => [input]);
	const hasPlaceholder = (text: string) => /\{\d*[./]*\}/.test(text);

	if (template.length === 1) {
		const script = template[0] ?? "";
		const fill = (inputs: string[]) => {
			const quoted = inputs.map(quoteWord);
			return hasPlaceholder(script) ? fillPlaceholders(script, quoted) : [script, ...quoted].join(" ");
		};
		return { scripts: runs.map(fill) };
	}
	const fill = (inputs: string[]) =>
		template.some(hasPlaceholder) ? template.map((word) => fillPlaceholders(word, inputs)) : [...template, ...inputs];
	return { commands: runs.map(fill) };
}

/** `chrt -f 10 cmd` runs cmd at a priority; `chrt -p 1234` changes a running process. */
function chrtCall(words: string[]): Unwrapped {
	const rest = afterOptions(words, new Set(["-T", "--sched-runtime", "-P", "--sched-period", "-D", "--sched-deadline"]));
	const options = words.slice(1, words.length - rest.length);
	if (options.some((word) => word === "-p" || word === "--pid")) return { next: [] };
	return { next: rest.slice(1) };
}

/** `flock lockfile cmd …` runs cmd holding the lock; `flock lockfile -c 'cmd'` runs a script. */
function flockCall(words: string[]): Unwrapped {
	const [, ...command] = afterOptions(words, new Set(["-w", "--wait", "--timeout", "-E", "--conflict-exit-code"]));
	const scriptFlag = command.findIndex((word) => word === "-c" || word === "--command");
	return scriptFlag === -1 ? { next: command } : { scripts: [command[scriptFlag + 1] ?? ""] };
}

function sshCall(words: string[]): Unwrapped {
	const [, ...remote] = afterOptions(words, SSH_VALUE_OPTIONS);
	return remote.length > 0 ? { scripts: [joinWords(remote)], scope: { isRemote: true, cwd: undefined } } : { next: [] };
}

function wslCall(words: string[]): Unwrapped {
	for (let i = 1; i < words.length; i++) {
		const word = words[i] ?? "";
		if (word === "-e" || word === "--exec") return { next: words.slice(i + 1) };
		if (word === "--") return { scripts: [joinWords(words.slice(i + 1))] };
		if (!word.startsWith("-")) return { scripts: [joinWords(words.slice(i))] };
		if (WSL_VALUE_OPTIONS.has(word)) i++;
	}
	return { next: [] };
}

/** `powershell -EncodedCommand` takes base64 of UTF-16LE text. */
function decodeEncodedCommand(encoded: string): string | undefined {
	const clean = encoded.replace(/=+$/, "");
	if (!/^[A-Za-z0-9+/]+$/.test(clean)) return undefined;
	const bytes = new Uint8Array(Math.floor((clean.length * 3) / 4));
	let value = 0;
	let bits = 0;
	let length = 0;
	for (const char of clean) {
		value = ((value << 6) | BASE64.indexOf(char)) & 0xffffff;
		bits += 6;
		if (bits >= 8) {
			bits -= 8;
			bytes[length++] = (value >> bits) & 0xff;
		}
	}
	// By hand: the hooks runtime's TextDecoder knows no UTF-16.
	let text = "";
	for (let i = 0; i + 1 < length; i += 2) text += String.fromCharCode((bytes[i] ?? 0) | ((bytes[i + 1] ?? 0) << 8));
	return text;
}

/** True when `word` is `-<name>` or an unambiguous prefix of it at least `minimum` characters long. */
function isParameter(word: string, name: string, minimum: number): boolean {
	const lower = word.toLowerCase();
	return lower.length >= minimum && `-${name}`.startsWith(lower);
}

function powershellCall(words: string[]): Unwrapped | undefined {
	const windows = (script: string): Unwrapped => ({ scripts: [script], scope: { dialect: "powershell" } });
	for (let i = 1; i < words.length; i++) {
		const word = words[i] ?? "";
		if (isParameter(word, "command", 2)) return windows(joinWords(words.slice(i + 1)));
		if (["-ex", "-ep"].includes(word.toLowerCase()) || isParameter(word, "executionpolicy", 4)) {
			i++;
			continue;
		}
		if (["-e", "-ec"].includes(word.toLowerCase()) || isParameter(word, "encodedcommand", 3)) {
			const script = decodeEncodedCommand(words[i + 1] ?? "");
			return script === undefined ? undefined : windows(script);
		}
		// A script file stays unread.
		if (isParameter(word, "file", 2)) return undefined;
		if (["-windowstyle", "-w", "-workingdirectory", "-wd", "-outputformat", "-of", "-inputformat", "-if", "-configurationname", "-settingsfile", "-version", "-v"].includes(word.toLowerCase())) {
			i++;
			continue;
		}
		if (word.startsWith("-")) continue;
		return windows(joinWords(words.slice(i)));
	}
	return undefined;
}

function cmdCall(words: string[]): Unwrapped | undefined {
	const index = words.findIndex((word, i) => i > 0 && /^\/[ck]$/i.test(word));
	return index === -1 ? undefined : { scripts: [joinWords(words.slice(index + 1))], scope: { dialect: "cmd" } };
}

function packageRunner(words: string[]): Unwrapped | undefined {
	const rest = afterOptions(words, GLOBAL_OPTIONS_WITH_VALUE[words[0] ?? ""] ?? new Set());
	const [action = "", ...args] = rest;
	if (["exec", "dlx", "x"].includes(action)) return { next: afterOptions([action, ...args], RUNNER_EXEC_OPTIONS) };
	if (action === "run" && PACKAGE_BINS.has(args[0] ?? "")) return { next: args };
	return PACKAGE_BINS.has(action) ? { next: rest } : undefined;
}

function unwrap(words: string[], command: SimpleCommand): Unwrapped | undefined {
	const [name = "", ...args] = words;

	const code = inlineCode(words);
	if (code !== undefined) return { scripts: scriptsInCode(code) };

	switch (name.toLowerCase().replace(/\.exe$/, "")) {
		case "powershell":
		case "pwsh":
			return powershellCall(words);
		case "cmd":
			return cmdCall(words);
		case "wsl":
			return wslCall(words);
	}

	switch (name) {
		case "sudo":
			return { next: afterOptions(words, new Set(["-u", "-g", "-h", "-p", "-r", "-t", "-C", "-D", "-U", "-T", "--user", "--group", "--host", "--prompt", "--chdir"])) };
		case "doas":
			return { next: afterOptions(words, new Set(["-u", "-C"])) };
		case "env": {
			const splitAt = args.findIndex((word) => word === "-S" || word.startsWith("--split-string"));
			if (splitAt !== -1) {
				const word = args[splitAt] ?? "";
				const script = word.includes("=") ? word.slice(word.indexOf("=") + 1) : args.slice(splitAt + 1).join(" ");
				return { scripts: [script] };
			}
			const rest = afterOptions(words, new Set(["-u", "--unset", "-C", "--chdir"]));
			const start = rest.findIndex((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word));
			return { next: start === -1 ? [] : rest.slice(start) };
		}
		case "command":
			// `command -v git` looks a command up and runs nothing.
			return args.some((word) => word === "-v" || word === "-V") ? { next: [] } : { next: afterOptions(words, new Set()) };
		case "builtin":
		case "nohup":
			return { next: args };
		case "setsid":
		case "unbuffer":
			return { next: afterOptions(words, new Set()) };
		case "chrt":
			return chrtCall(words);
		case "flock":
			return flockCall(words);
		case "script":
			return scriptCall(words);
		case "parallel":
			return parallelCall(words);
		case "exec":
			return { next: afterOptions(words, new Set(["-a"])) };
		case "time":
			return { next: afterOptions(words, new Set(["-f", "-o", "--format", "--output"])) };
		case "nice":
			return { next: afterOptions(words, new Set(["-n", "--adjustment"])) };
		case "ionice":
			return { next: afterOptions(words, new Set(["-c", "-n", "--class", "--classdata"])) };
		case "stdbuf":
			return { next: afterOptions(words, new Set(["-i", "-o", "-e"])) };
		case "timeout": {
			const rest = afterOptions(words, new Set(["-s", "-k", "--signal", "--kill-after"]));
			return { next: rest.slice(1) };
		}
		case "xargs": {
			const xargsOptions = ["-n", "-I", "-L", "-P", "-d", "-E", "-s", "-a", "--max-args", "--replace", "--max-lines", "--max-procs", "--delimiter", "--eof", "--arg-file", "--max-chars"];
			return { next: [...afterOptions(words, new Set(xargsOptions)), ...xargsInputs(words, command)] };
		}
		case "watch":
			return { scripts: [afterOptions(words, new Set(["-n", "--interval", "-d"])).join(" ")] };
		case "eval": {
			const script = args.join(" ");
			return { scripts: [script], runsUnseenScript: DOWNLOAD.test(script) };
		}
		case "source":
		case ".":
			return DOWNLOAD.test(args[0] ?? "") ? { runsUnseenScript: true } : undefined;
		case "find":
			return { commands: findExecs(words) };
		case "ssh":
			return sshCall(words);
		// Secret injectors: `infisical run --env prod -- pnpm wrangler deploy`.
		case "infisical":
		case "doppler":
		case "op":
		case "dotenvx":
			return args[0] === "run" && args.includes("--") ? { next: args.slice(args.indexOf("--") + 1) } : undefined;
		case "dotenv":
			return args.includes("--") ? { next: args.slice(args.indexOf("--") + 1) } : undefined;
		case "npx":
		case "bunx":
			return { next: afterOptions(words, RUNNER_EXEC_OPTIONS) };
		case "npm":
		case "pnpm":
		case "yarn":
		case "bun":
			return packageRunner(words);
		default:
			return SHELLS.has(name) ? shellCall(words, command) : undefined;
	}
}

function matchCommand(command: SimpleCommand, words: string[], depth: number, found: Map<string, DangerMatch>, scope: Scope) {
	const stages = [normalize(words)];
	let current = stages[0] ?? [];
	let runsUnseenScript = false;

	for (let step = 0; step < MAX_DEPTH && current.length > 0; step++) {
		const unwrapped = unwrap(current, command);
		if (!unwrapped) break;
		runsUnseenScript ||= unwrapped.runsUnseenScript === true;
		for (const script of unwrapped.scripts ?? []) matchScript(script, depth + 1, found, { ...scope, ...unwrapped.scope });
		for (const inner of unwrapped.commands ?? []) matchCommand(command, inner, depth + 1, found, scope);
		if (!unwrapped.next) break;
		current = normalize(unwrapped.next);
		stages.push(current);
	}

	const effective = stripGlobalOptions(current);
	// `gt modify --help` and `mysql --version` only print.
	if (effective.includes("--help") || effective.includes("--version")) return;
	const writesTo = command.redirects.filter((redirect) => redirect.operator.includes(">")).map((redirect) => redirect.target);
	const context = { ...scope, effective, writesTo, runsUnseenScript };
	for (const rule of DANGER_RULES) {
		if (found.has(rule.id)) continue;
		if (stages.some((raw) => rule.match({ ...context, raw }))) found.set(rule.id, { rule, words: effective });
	}

	const scriptInput = RULE_BY_ID.get("mysql-script-input");
	const isClassicClient = effective[0] === "mysql" || effective[0] === "mariadb";
	if (scriptInput && isClassicClient && command.hasStdinRedirect && !found.has(scriptInput.id)) {
		found.set(scriptInput.id, { rule: scriptInput, words: effective });
	}
}

/**
 * The scope after one command: `cd dir` and `pushd dir` move it, and `NAME=value`
 * or `export NAME=value` on its own sets a variable. Other commands leave it as it was.
 */
function advance(command: SimpleCommand, scope: Scope): Scope {
	const words = markWords(command);
	const assignments = words[0] === "export" ? words.slice(1) : words;
	if (assignments.length > 0 && assignments.every((word) => /^[A-Za-z_]\w*=/.test(word))) {
		const variables = { ...scope.variables };
		for (const assignment of assignments) {
			const name = assignment.slice(0, assignment.indexOf("="));
			const value = expandVariables(assignment.slice(name.length + 1), scope);
			// A value only run time knows (`$(…)`, an unknown `$X`) leaves the variable unknown.
			if (/[$`]/.test(value)) delete variables[name];
			else variables[name] = value;
		}
		return { ...scope, variables };
	}

	const [name, ...args] = normalize(words);
	if (name !== "cd" && name !== "pushd") return scope;
	const target = args.find((word) => !word.startsWith("-") || word === "-");
	if (target === undefined) return { ...scope, cwd: scope.home };
	if (target === "-") return { ...scope, cwd: undefined };
	return { ...scope, cwd: resolveTarget(target, scope) };
}

function matchScript(script: string, depth: number, found: Map<string, DangerMatch>, scope: Scope) {
	if (depth > MAX_DEPTH) return;
	const parsed = parseScript(script);
	let current = scope;
	for (const command of parsed.commands) {
		matchCommand(command, expandName(markWords(command), command.quoted, current), depth, found, current);
		current = advance(command, current);
	}
	for (const nested of parsed.nested) matchScript(nested, depth + 1, found, scope);
}

/** Every rule the command matches, most severe first. */
export function findDangerousMatches(command: string, context: DetectContext = {}): DangerMatch[] {
	const found = new Map<string, DangerMatch>();
	matchScript(command, 0, found, { ...context, dialect: "sh", isRemote: false });
	return [...found.values()].sort((a, b) => b.rule.severity - a.rule.severity);
}
