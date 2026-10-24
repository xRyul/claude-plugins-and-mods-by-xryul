import type { DangerRule } from "./types";

function isGhPr(words: string[], subcommand: string): boolean {
	return words[0] === "gh" && words[1] === "pr" && words[2] === subcommand;
}

/**
 * GitHub CLI rules related to pull request creation/updates.
 *
 * These are intentionally narrow (only gh pr create/edit/merge) to avoid prompting on
 * read-only commands like `gh pr view`.
 */
export const prRules: DangerRule[] = [
	{
		id: "gh-pr-merge",
		description: "gh pr merge (merge a pull request into its base)",
		severity: 85,
		match: ({ effective: words }) => isGhPr(words, "merge"),
	},
	{
		id: "gh-pr-create",
		description: "gh pr create (create a pull request)",
		severity: 65,
		match: ({ effective: words }) => isGhPr(words, "create"),
	},
	{
		id: "gh-pr-edit",
		description: "gh pr edit (update a pull request)",
		severity: 60,
		match: ({ effective: words }) => isGhPr(words, "edit"),
	},
];
