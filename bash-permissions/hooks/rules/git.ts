import type { DangerRule } from "./types";

function isGit(words: string[], subcommand: string): boolean {
	return words[0] === "git" && words[1] === subcommand;
}

function hasLongFlag(words: string[], flag: string): boolean {
	return words.some((w) => w === flag || w.startsWith(`${flag}=`));
}

function hasShortFlagLetter(words: string[], letter: string): boolean {
	// Handle combined short flags like -fdx
	return words.some(
		(w) => w.startsWith("-") && !w.startsWith("--") && w.includes(letter),
	);
}

function isDryRun(words: string[]): boolean {
	return hasLongFlag(words, "--dry-run") || hasShortFlagLetter(words, "n");
}

/** The words after the subcommand that are not options: remotes, branches, refspecs, paths. */
function positionals(words: string[]): string[] {
	return words.slice(2).filter((w) => !w.startsWith("-"));
}

export const gitRules: DangerRule[] = [
	{
		id: "git-push-force",
		description: "git push --force / --force-with-lease / +refspec",
		severity: 85,
		match: ({ effective: words }) => {
			if (!isGit(words, "push")) return false;
			return words.some(
				(w) =>
					w === "--force" ||
					w.startsWith("--force-with-lease") ||
					(w.startsWith("-") && !w.startsWith("--") && w.includes("f")),
			) || positionals(words).some((w) => w.length > 1 && w.startsWith("+"));
		},
	},
	{
		id: "git-push-delete",
		description: "delete a remote branch or tag (git push --delete, git push origin :branch)",
		severity: 80,
		match: ({ effective: words }) => {
			if (!isGit(words, "push")) return false;
			return words.includes("--delete") || words.includes("-d") || positionals(words).some((w) => w.length > 1 && w.startsWith(":"));
		},
	},
	{
		id: "git-push",
		description: "git push",
		severity: 70,
		match: ({ effective: words }) => isGit(words, "push"),
	},
	{
		id: "git-clean-fdx",
		description: "git clean -fdx (remove untracked + ignored files)",
		severity: 84,
		match: ({ effective: words }) => {
			if (!isGit(words, "clean")) return false;
			if (isDryRun(words)) return false;

			const force = hasLongFlag(words, "--force") || hasShortFlagLetter(words, "f");
			const dirs = hasShortFlagLetter(words, "d") || hasLongFlag(words, "--directories");
			const ignored = hasShortFlagLetter(words, "x") || hasShortFlagLetter(words, "X");

			return force && dirs && ignored;
		},
	},
	{
		id: "git-clean-fd",
		description: "git clean -fd (remove untracked files/directories)",
		severity: 75,
		match: ({ effective: words }) => {
			if (!isGit(words, "clean")) return false;
			if (isDryRun(words)) return false;

			const force = hasLongFlag(words, "--force") || hasShortFlagLetter(words, "f");
			const dirs = hasShortFlagLetter(words, "d") || hasLongFlag(words, "--directories");
			return force && dirs;
		},
	},
	{
		// --soft and --mixed keep your changes, and the reflog keeps the commits.
		id: "git-reset-hard",
		description: "git reset --hard / --keep (discard local changes)",
		severity: 80,
		match: ({ effective: words }) => isGit(words, "reset") && (words.includes("--hard") || words.includes("--keep")),
	},
	{
		id: "git-restore-discard",
		description: "git restore (discard working tree changes)",
		severity: 65,
		match: ({ effective: words }) => {
			if (!isGit(words, "restore")) return false;

			const stagedOnly = words.includes("--staged") && !words.includes("--worktree");
			return !stagedOnly;
		},
	},
	{
		id: "git-checkout-discard",
		description: "discard uncommitted changes (git checkout -- <paths> / . / -f, git switch -f)",
		severity: 60,
		match: ({ effective: words }) => {
			const isForced = hasLongFlag(words, "--force") || words.slice(2).some((w) => /^-[a-zA-Z]*f/.test(w));
			if (isGit(words, "checkout")) return words.includes("--") || words.includes(".") || isForced;
			if (isGit(words, "switch")) return words.includes("--discard-changes") || isForced;
			return false;
		},
	},
	{
		id: "git-stash-drop",
		description: "drop stashed work (git stash drop / clear)",
		severity: 72,
		match: ({ effective: words }) => isGit(words, "stash") && (words[2] === "drop" || words[2] === "clear"),
	},
	{
		id: "git-worktree-remove",
		description: "git worktree remove (loses uncommitted files in it)",
		severity: 70,
		match: ({ effective: words }) => isGit(words, "worktree") && words[2] === "remove",
	},
	{
		id: "git-branch-force-delete",
		description: "force-delete a local branch (git branch -D)",
		severity: 68,
		match: ({ effective: words }) => {
			if (!isGit(words, "branch")) return false;
			const short = words.slice(2).filter((w) => /^-[a-zA-Z]+$/.test(w));
			const deletes = words.includes("--delete") || short.some((w) => w.includes("d"));
			const forces = words.includes("--force") || short.some((w) => w.includes("f"));
			return short.some((w) => w.includes("D")) || (deletes && forces);
		},
	},
	{
		id: "git-config-global",
		description: "change your global git config (git config --global)",
		severity: 50,
		match: ({ effective: words }) => {
			if (!isGit(words, "config") || !(words.includes("--global") || words.includes("--system"))) return false;
			const subcommand = words[2] ?? "";
			if (["set", "unset", "edit", "rename-section", "remove-section"].includes(subcommand)) return true;
			if (["get", "list"].includes(subcommand)) return false;
			const writes = ["--unset", "--unset-all", "--add", "--replace-all", "--remove-section", "--rename-section", "--edit", "-e"];
			if (words.some((w) => writes.includes(w))) return true;
			const reads = ["--get", "--get-all", "--get-regexp", "--get-urlmatch", "--list", "-l"];
			if (words.some((w) => reads.includes(w))) return false;
			// `git config --global user.name` reads; `git config --global user.name Ada` writes.
			return positionals(words).length >= 2;
		},
	},
	{
		// Quiet by default: the reflog undoes a rebase, and the force push after it asks.
		id: "git-rebase",
		description: "git rebase (rewrite commit history)",
		severity: 55,
		match: ({ effective: words }) =>
			isGit(words, "rebase") && !words.some((w) => ["--abort", "--quit", "--show-current-patch", "--edit-todo"].includes(w)),
	},
	{
		id: "git-commit",
		description: "git commit",
		severity: 40,
		match: ({ effective: words }) => isGit(words, "commit"),
	},
];
