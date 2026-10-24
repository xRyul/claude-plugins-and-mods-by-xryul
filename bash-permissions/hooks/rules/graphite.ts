import type { DangerRule } from "./types";

function isGt(
	words: string[],
	topLevelSubcommands: readonly string[],
	branchSubcommands: readonly string[] = [],
): boolean {
	if (words[0] !== "gt") return false;
	if (words[1] === "branch") return branchSubcommands.includes(words[2] ?? "");
	return topLevelSubcommands.includes(words[1] ?? "");
}

function hasLongFlag(words: string[], flag: string): boolean {
	return words.some((w) => w === flag || w.startsWith(`${flag}=`));
}

function hasShortFlagLetter(words: string[], letter: string): boolean {
	return words.some(
		(w) => w.startsWith("-") && !w.startsWith("--") && w.includes(letter),
	);
}

export const graphiteRules: DangerRule[] = [
	{
		id: "gt-submit-force",
		description: "Graphite submit --force (gt submit / gt branch submit / aliases)",
		severity: 92,
		match: ({ effective: words }) => {
			if (!isGt(words, ["submit", "s", "ss"], ["submit", "s", "ss"])) return false;
			return hasLongFlag(words, "--force") || hasShortFlagLetter(words, "f");
		},
	},
	{
		id: "gt-submit-merge-when-ready",
		description: "Graphite submit --merge-when-ready (gt submit / gt branch submit / aliases)",
		severity: 86,
		match: ({ effective: words }) => {
			if (!isGt(words, ["submit", "s", "ss"], ["submit", "s", "ss"])) return false;
			return hasLongFlag(words, "--merge-when-ready") || hasShortFlagLetter(words, "m");
		},
	},
	{
		id: "gt-submit-publish",
		description: "Graphite submit --publish (gt submit / gt branch submit / aliases)",
		severity: 84,
		match: ({ effective: words }) => {
			if (!isGt(words, ["submit", "s", "ss"], ["submit", "s", "ss"])) return false;
			return hasLongFlag(words, "--publish") || hasShortFlagLetter(words, "p");
		},
	},
	{
		id: "gt-merge",
		description: "Graphite merge PRs (gt merge)",
		severity: 90,
		match: ({ effective: words }) => isGt(words, ["merge"]),
	},
	{
		id: "gt-delete-stack",
		description: "Graphite delete --upstack/--downstack (gt delete / gt branch delete)",
		severity: 88,
		match: ({ effective: words }) => {
			if (!isGt(words, ["delete", "dl"], ["delete", "dl"])) return false;
			return hasLongFlag(words, "--upstack") || hasLongFlag(words, "--downstack");
		},
	},
	{
		id: "gt-sync",
		description: "Graphite sync (restack + overwrite trunk/delete merged branches)",
		severity: 87,
		match: ({ effective: words }) => isGt(words, ["sync"]),
	},
	{
		id: "gt-delete-close",
		description: "Graphite delete --close (gt delete / gt branch delete)",
		severity: 82,
		match: ({ effective: words }) => {
			if (!isGt(words, ["delete", "dl"], ["delete", "dl"])) return false;
			return hasLongFlag(words, "--close") || hasShortFlagLetter(words, "c");
		},
	},
	{
		id: "gt-pop",
		description: "Graphite pop/unbranch (delete current branch, keep worktree)",
		severity: 80,
		match: ({ effective: words }) => isGt(words, ["pop"], ["unbranch", "ub"]),
	},
	{
		id: "gt-split",
		description: "Graphite split (gt split / gt branch split / aliases)",
		severity: 78,
		match: ({ effective: words }) => isGt(words, ["split", "sp"], ["split", "sp"]),
	},
	{
		id: "gt-squash",
		description: "Graphite squash (gt squash / gt branch squash / aliases)",
		severity: 76,
		match: ({ effective: words }) => isGt(words, ["squash", "sq"], ["squash", "sq"]),
	},
	{
		id: "gt-move",
		description: "Graphite move (re-parent branch and restack descendants)",
		severity: 74,
		match: ({ effective: words }) => isGt(words, ["move"]),
	},
	{
		id: "gt-fold",
		description: "Graphite fold (gt fold / gt branch fold)",
		severity: 74,
		match: ({ effective: words }) => isGt(words, ["fold"], ["fold", "f"]),
	},
	{
		id: "gt-untrack",
		description: "Graphite untrack (gt untrack / gt branch untrack / aliases)",
		severity: 72,
		match: ({ effective: words }) => isGt(words, ["untrack", "utr"], ["untrack", "utr"]),
	},
	{
		id: "gt-rename-force",
		description: "Graphite rename --force (gt rename / gt branch rename / aliases)",
		severity: 70,
		match: ({ effective: words }) => {
			if (!isGt(words, ["rename", "rn"], ["rename", "rn"])) return false;
			return hasLongFlag(words, "--force") || hasShortFlagLetter(words, "f");
		},
	},
	{
		id: "gt-unlink",
		description: "Graphite unlink (detach PR from branch)",
		severity: 70,
		match: ({ effective: words }) => isGt(words, ["unlink"]),
	},
	{
		id: "gt-submit",
		description: "Graphite submit (gt submit / gt branch submit / aliases)",
		severity: 68,
		match: ({ effective: words }) => isGt(words, ["submit", "s", "ss"], ["submit", "s", "ss"]),
	},
	{
		id: "gt-checkout",
		description: "Graphite checkout (gt checkout / gt branch checkout / gt co)",
		severity: 67,
		match: ({ effective: words }) => isGt(words, ["checkout", "co"], ["checkout", "co"]),
	},
	{
		id: "gt-modify",
		description: "Graphite modify (gt modify / gt m)",
		severity: 66,
		match: ({ effective: words }) => isGt(words, ["modify", "m"]),
	},
	{
		id: "gt-restore",
		description: "Graphite restore (git restore passthrough)",
		severity: 65,
		match: ({ effective: words }) => isGt(words, ["restore"]),
	},
	{
		id: "gt-create",
		description: "Graphite create (gt create / gt branch create / gt c)",
		severity: 64,
		match: ({ effective: words }) => isGt(words, ["create", "c"], ["create", "c"]),
	},
	{
		id: "gt-delete",
		description: "Graphite delete (gt delete / gt branch delete / aliases)",
		severity: 64,
		match: ({ effective: words }) => isGt(words, ["delete", "dl"], ["delete", "dl"]),
	},
];
