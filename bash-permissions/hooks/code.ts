/**
 * Commands hidden in interpreter one-liners (`python -c`, `node -e`, `perl -e`).
 * This is a partial reading: it finds string literals near calls that run
 * commands, and recursive deletes made through the language's own API.
 */

/** Calls that run a command; only code that has one has its strings read as commands. */
const RUNS_COMMANDS =
	/\b(os\.system|os\.popen|subprocess|pty\.spawn|child_process|execSync|execFileSync|spawnSync|execFile|spawn|exec|system|popen|Popen|Open3|Bun\.spawn|Bun\.\$)\b|\$`|%x|\bqx/;
const STRING_LITERAL = /(['"`])((?:\\.|(?!\1)[^\\\n])*)\1/g;
/** `shutil.rmtree("x")`, `fs.rmSync("x", { recursive: true })`, `rimraf("x")`. */
const RECURSIVE_DELETE =
	/\b(shutil\.rmtree|rimraf(?:Sync)?|(?:fs\.)?(?:promises\.)?(?:rmSync|rmdirSync|rm))\s*\(\s*(['"`])((?:\\.|(?!\2)[^\\])*)\2/g;

/** Value options, per interpreter, that come before its code flag. */
const VALUE_OPTIONS: Record<string, ReadonlySet<string>> = {
	python: new Set(["-W", "-X"]),
	node: new Set(["-r", "--require", "--import", "--loader", "-C", "--conditions", "--input-type", "--env-file"]),
	bun: new Set(["--cwd", "-c", "--config", "--env-file", "-r", "--preload"]),
};

function quote(word: string): string {
	return `'${word.replace(/'/g, `'\\''`)}'`;
}

function stringsIn(text: string): string[] {
	return [...text.matchAll(STRING_LITERAL)].map((match) => (match[2] ?? "").replace(/\\(.)/g, "$1"));
}

/** The word after the first option `isCodeFlag` accepts, looking only at the options before the first operand. */
function codeAfter(args: string[], isCodeFlag: (word: string) => boolean, valueOptions: ReadonlySet<string>): string | undefined {
	for (let i = 0; i < args.length; i++) {
		const word = args[i] ?? "";
		if (!word.startsWith("-") || word === "-" || word === "-m") return undefined;
		if (isCodeFlag(word)) return args[i + 1];
		if (word.startsWith("--eval=")) return word.slice("--eval=".length);
		if (valueOptions.has(word)) i++;
	}
	return undefined;
}

/** The code an interpreter runs from its own command line, if any. */
export function inlineCode(words: string[]): string | undefined {
	const [command = "", ...args] = words;
	if (/^python[\d.]*$/.test(command)) {
		return codeAfter(args, (w) => /^-[A-Za-z]*c$/.test(w), VALUE_OPTIONS.python ?? new Set());
	}
	if (command === "node" || command === "nodejs" || command === "bun") {
		const isEval = (w: string) => ["-e", "--eval", "-p", "--print"].includes(w);
		return codeAfter(args, isEval, VALUE_OPTIONS[command === "bun" ? "bun" : "node"] ?? new Set());
	}
	if (command === "perl" || command === "ruby") {
		const lines = args.flatMap((w, i) => (w === "-e" || w === "-E" ? [args[i + 1] ?? ""] : []));
		return lines.length > 0 ? lines.join("\n") : undefined;
	}
	if (command === "deno" && args[0] === "eval") return args.slice(1).find((w) => !w.startsWith("-"));
	return undefined;
}

/** Shell scripts the code may run, to be read like any other command line. */
export function scriptsInCode(code: string): string[] {
	const scripts: string[] = [];
	if (RUNS_COMMANDS.test(code)) {
		// A list of strings (`["git", "push"]`) is an argv; any other string may be a command line.
		for (const [, items = ""] of code.matchAll(/\[([^[\]]*)\]/g)) {
			const argv = stringsIn(items);
			if (argv.length > 1) scripts.push(argv.map(quote).join(" "));
		}
		scripts.push(...stringsIn(code));
	}
	for (const [call = "", fn = "", , path = ""] of code.matchAll(RECURSIVE_DELETE)) {
		const isRecursive = /rmtree|rimraf/.test(fn) || /recursive\s*:\s*true/.test(code);
		if (isRecursive && call) scripts.push(`rm -rf ${quote(path)}`);
	}
	return scripts;
}
