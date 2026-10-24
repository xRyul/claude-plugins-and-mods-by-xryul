import type { MatchContext } from "./types";

/** Deleting inside these is routine. */
const TEMP_DIRS = ["/tmp", "/var/tmp", "/private/tmp", "/private/var/folders"];

function normalize(path: string): string {
	const parts: string[] = [];
	for (const part of path.split("/")) {
		if (part === "" || part === ".") continue;
		if (part === "..") parts.pop();
		else parts.push(part);
	}
	return `/${parts.join("/")}`;
}

/** True when `path` lies strictly inside `dir`. */
function isInside(path: string, dir: string): boolean {
	return dir === "/" ? path !== "/" : path.startsWith(`${dir}/`);
}

/** `$NAME` and `${NAME}` replaced by what the script set them to (and `$HOME`); unknown ones are left as written. */
export function expandVariables(text: string, context: Pick<MatchContext, "home" | "variables">): string {
	return text.replace(/\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)/g, (written, braced?: string, bare?: string) => {
		const name = braced ?? bare ?? "";
		return context.variables?.[name] ?? (name === "HOME" ? context.home : undefined) ?? written;
	});
}

/**
 * The absolute path `target` names, or undefined when only run time knows it:
 * an unknown variable or a substitution, `~user`, or a relative path in an unknown directory.
 */
export function resolveTarget(target: string, context: Pick<MatchContext, "cwd" | "home" | "variables">): string | undefined {
	let path = expandVariables(target, context);
	if (path === "" || /[$`]/.test(path)) return undefined;
	if (path === "~" || path.startsWith("~/")) {
		if (!context.home) return undefined;
		path = context.home + path.slice(1);
	} else if (path.startsWith("~")) {
		return undefined;
	}
	if (!path.startsWith("/")) {
		if (!context.cwd) return undefined;
		path = `${context.cwd}/${path}`;
	}
	return normalize(path);
}

/** A last path part made only of `*`, `?` and `[…]` (`*`, `.*`, `?*`, `[a-z]*`, `.[!.]*`): it names everything there. */
const EVERY_NAME = /(^|\/)\.?(?:\*|\?|\[[^\]/]*\])+$/;
/** Brace groups past this many words are left unexpanded. */
const MAX_BRACE_WORDS = 64;

/** `dir/*` and `dir/[a-z]*` empty `dir`, so they count as `dir` itself; `*` and `?*` as the current directory. */
function emptiedDirectory(target: string): string {
	const directory = target.replace(EVERY_NAME, "$1");
	return directory === "" ? "." : directory;
}

/** The first `{a,b}` group in `word`, by its braces' positions and the options between its commas. `${VAR}` is no group. */
function braceGroup(word: string): { start: number; end: number; options: string[] } | undefined {
	for (let start = word.indexOf("{"); start !== -1; start = word.indexOf("{", start + 1)) {
		if (word[start - 1] === "$") continue;
		const commas: number[] = [];
		let depth = 0;
		for (let i = start; i < word.length; i++) {
			if (word[i] === "{") depth++;
			else if (word[i] === "," && depth === 1) commas.push(i);
			else if (word[i] === "}" && --depth === 0) {
				if (commas.length === 0) break;
				const bounds = [start, ...commas, i];
				return { start, end: i, options: bounds.slice(1).map((bound, k) => word.slice((bounds[k] ?? start) + 1, bound)) };
			}
		}
	}
	return undefined;
}

/** The words a brace group writes out, as the shell does before anything else: `{*,.*}` is `*` and `.*`. */
export function expandBraces(word: string): string[] {
	const words: string[] = [];
	const pending = [word];
	while (pending.length > 0 && words.length + pending.length <= MAX_BRACE_WORDS) {
		const current = pending.shift() ?? "";
		const group = braceGroup(current);
		if (!group) words.push(current);
		else pending.push(...group.options.map((option) => current.slice(0, group.start) + option + current.slice(group.end + 1)));
	}
	return [...words, ...pending];
}

/**
 * True when deleting `target` is out of the ordinary: it is `/`, the home
 * directory, the project or a parent of either, or everything in one of them
 * (`*`, `?*`); it climbs with `..`; it lies outside the project and the temp
 * directories; or only run time knows it. A brace group counts when any of its
 * words does. Anything on another machine or under a Windows shell counts as risky.
 */
export function isRiskyTarget(target: string, context: MatchContext, options: { isProjectRootRisky?: boolean } = {}): boolean {
	if (context.isRemote || (context.dialect ?? "sh") !== "sh") return true;
	return expandBraces(expandVariables(target, context)).some((word) => isRiskyPath(emptiedDirectory(word), context, options));
}

function isRiskyPath(written: string, context: MatchContext, { isProjectRootRisky = true }: { isProjectRootRisky?: boolean }): boolean {
	if (written.split("/").includes("..")) return true;

	const path = resolveTarget(written, context);
	if (path === undefined || path === "/") return true;
	const { home, project } = context;
	if (home && (path === home || isInside(home, path))) return true;
	if (project && isInside(project, path)) return true;
	if (project && path === project) return isProjectRootRisky;
	if (project && isInside(path, project)) return false;
	return !TEMP_DIRS.some((dir) => isInside(path, dir));
}

/** The operands of a command whose options start with `-`: everything after `--`, and every other word. */
export function operands(words: string[]): string[] {
	const end = words.indexOf("--");
	const before = (end === -1 ? words.slice(1) : words.slice(1, end)).filter((word) => !word.startsWith("-"));
	return end === -1 ? before : [...before, ...words.slice(end + 1)];
}

/** Where `find`'s start paths begin and end: past its own options, up to its first test, action or bracket. */
function findStartRange(words: string[]): { start: number; end: number } {
	let start = 1;
	while (["-H", "-L", "-P"].includes(words[start] ?? "") || /^-O\d$/.test(words[start] ?? "")) start++;
	if (words[start] === "-D") start += 2;
	let end = start;
	while (end < words.length && !/^[-(!,]/.test(words[end] ?? "")) end++;
	return { start, end };
}

/** The directories `find` starts from, `.` when there are none. */
export function findStartPaths(words: string[]): string[] {
	const { start, end } = findStartRange(words);
	return end > start ? words.slice(start, end) : ["."];
}

/** `find`'s expression: its tests, actions and operators after the start paths. */
export function findExpression(words: string[]): string[] {
	return words.slice(findStartRange(words).end);
}
