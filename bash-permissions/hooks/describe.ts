/**
 * A plain sentence naming what a delete would remove, built from the matched
 * commands rather than a model, so the prompt stays specific when the model
 * gives no explanation.
 */

import type { DangerMatch, MatchedCommand } from "./detect";
import { expandVariables, findStartPaths, operands, resolveTarget } from "./rules/paths";

/** Rules whose targets are paths this module can name. */
export const DELETE_RULE_IDS: ReadonlySet<string> = new Set(["rm-rf", "rm", "find-delete"]);

/** Long enough for a Claude Code project folder (`~/.claude/projects/-home-…`) to show whole. */
const MAX_PATH = 96;
/** What the detector reads `xargs` and `parallel` inputs as when only run time knows them. */
const UNKNOWN_INPUT = "$(…)";

/** `text` cut in the middle to at most `max` characters, so both its start and its end still show. */
function shorten(text: string, max: number): string {
	if (text.length <= max) return text;
	const keep = Math.floor((max - 1) / 2);
	return `${text.slice(0, keep)}…${text.slice(-keep)}`;
}

/** The path as the person would write it: the home directory as `~`, unknown parts as written. */
function displayPath(word: string, command: MatchedCommand, home: string | undefined): string {
	if (word === UNKNOWN_INPUT) return "paths read at run time";
	// The detector writes a substitution after the word's text (`"$(mktemp -d)/x"` reads `/x$(mktemp -d)`).
	const substitution = /\$\([\s\S]*\)$/.exec(word)?.[0];
	if (substitution) return `a path built by ${substitution}`;
	const path = resolveTarget(word, { cwd: command.cwd, home, variables: command.variables });
	if (path === undefined) return expandVariables(word, { home, variables: command.variables });
	return home && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path;
}

function joinAnd(parts: string[]): string {
	return parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

/** The paths, one group per directory: a lone path in full, several as `2 files in ~/dir`. */
function listPaths(paths: string[], plural: string): string {
	const groups = new Map<string, string[]>();
	for (const path of new Set(paths)) {
		const slash = path.includes("$(") ? -1 : path.lastIndexOf("/");
		const dir = slash > 0 ? path.slice(0, slash) : slash === 0 ? "/" : "";
		groups.set(dir, [...(groups.get(dir) ?? []), path]);
	}
	const parts = [...groups].flatMap(([dir, items]) =>
		items.length > 1 && dir ? [`${items.length} ${plural} in ${shorten(dir, MAX_PATH)}`] : items.map((item) => shorten(item, MAX_PATH)),
	);
	return joinAnd(parts);
}

function deletePhrase(match: DangerMatch, home: string | undefined): string | undefined {
	const paths = (pick: (command: MatchedCommand) => string[]) =>
		match.commands.flatMap((command) => pick(command).map((word) => displayPath(word, command, home)));
	switch (match.rule.id) {
		case "rm-rf": {
			const targets = paths((command) => operands(command.words));
			return targets.length > 0 ? `${listPaths(targets, "items")} with everything inside` : undefined;
		}
		case "rm": {
			const targets = paths((command) => operands(command.words));
			return targets.length > 0 ? listPaths(targets, "files") : undefined;
		}
		case "find-delete":
			return `what find matches under ${listPaths(paths((command) => findStartPaths(command.words)), "folders")}`;
		default:
			return undefined;
	}
}

/**
 * `Deletes 2 items in ~/.claude/session-env with everything inside, and 2 files in ~/notes.`
 * Undefined unless the most severe match is a delete with targets it can name.
 */
export function describeDeletes(matches: DangerMatch[], home?: string): string | undefined {
	if (!DELETE_RULE_IDS.has(matches[0]?.rule.id ?? "")) return undefined;
	const deletes = matches.filter((match) => DELETE_RULE_IDS.has(match.rule.id));
	const phrases = deletes.flatMap((match) => deletePhrase(match, home) ?? []);
	if (phrases.length === 0) return undefined;
	const remote = deletes.some((match) => match.commands.some((command) => command.isRemote)) ? " on another machine" : "";
	return `Deletes ${phrases.join(", and ")}${remote}.`;
}
