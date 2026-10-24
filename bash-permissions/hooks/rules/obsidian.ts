import type { DangerRule } from "./types";

const WRITE_COMMANDS = new Set(["create", "base:create", "daily"]);
const EDIT_COMMANDS = new Set([
	"append",
	"prepend",
	"daily:append",
	"daily:prepend",
	"property:set",
	"property:remove",
	"template:insert",
	"history:restore",
]);
const DELETE_COMMANDS = new Set(["delete"]);
const MOVE_COMMANDS = new Set(["move", "rename"]);
const INDIRECT_WRITE_COMMANDS = new Set(["command", "quickadd", "quickadd:run", "eval", "dev:cdp"]);
const TASK_MUTATION_ARGUMENTS = new Set(["toggle", "done", "todo"]);

interface ObsidianInvocation {
	command: string;
	args: string[];
}

function executableBasename(executable: string): string {
	const normalized = executable.replace(/\\/g, "/");
	return (normalized.slice(normalized.lastIndexOf("/") + 1) || normalized).toLowerCase();
}

function isObsidianExecutable(executable: string): boolean {
	return ["obsidian", "obsidian.com", "obsidian.exe"].includes(executableBasename(executable));
}

function getObsidianInvocation(words: string[]): ObsidianInvocation | undefined {
	if (!isObsidianExecutable(words[0] ?? "")) return undefined;

	for (let i = 1; i < words.length; i++) {
		const word = words[i] ?? "";
		// The CLI accepts global parameters such as vault=<name> before the
		// command, and global flags such as --copy may also appear there.
		if (!word || word.startsWith("-") || word.includes("=")) continue;
		return { command: word.toLowerCase(), args: words.slice(i + 1) };
	}

	return undefined;
}

function isTaskMutation(invocation: ObsidianInvocation): boolean {
	if (invocation.command !== "task") return false;
	return invocation.args.some(
		(arg) => TASK_MUTATION_ARGUMENTS.has(arg.toLowerCase()) || arg.toLowerCase().startsWith("status="),
	);
}

function matchesCommand(words: string[], commands: ReadonlySet<string>): boolean {
	const invocation = getObsidianInvocation(words);
	return invocation !== undefined && commands.has(invocation.command);
}

// Keep these above the wrapper-only sudo rule (80) so `sudo obsidian …` is
// classified by its Obsidian effect rather than by the wrapper.
export const obsidianRules: DangerRule[] = [
	{
		id: "obsidian-indirect-write",
		description: "Obsidian indirect write (command / QuickAdd / eval / dev:cdp)",
		severity: 85,
		match: ({ effective: words }) => matchesCommand(words, INDIRECT_WRITE_COMMANDS),
	},
	{
		id: "obsidian-delete",
		description: "Obsidian note delete",
		severity: 84,
		match: ({ effective: words }) => matchesCommand(words, DELETE_COMMANDS),
	},
	{
		id: "obsidian-move",
		description: "Obsidian note move or rename",
		severity: 83,
		match: ({ effective: words }) => matchesCommand(words, MOVE_COMMANDS),
	},
	{
		id: "obsidian-write",
		description: "Obsidian note write or create",
		severity: 82,
		match: ({ effective: words }) => matchesCommand(words, WRITE_COMMANDS),
	},
	{
		id: "obsidian-edit",
		description: "Obsidian note edit",
		severity: 81,
		match: ({ effective: words }) => {
			const invocation = getObsidianInvocation(words);
			return invocation !== undefined && (EDIT_COMMANDS.has(invocation.command) || isTaskMutation(invocation));
		},
	},
];
