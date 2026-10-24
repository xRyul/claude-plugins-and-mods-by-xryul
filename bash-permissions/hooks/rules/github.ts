import { isReadMethod, methodOf } from "./http";
import type { DangerRule } from "./types";

/** `-f key=value`, `-F key=@file`, `--input file`: fields make `gh api` send a POST. */
function sendsFields(words: string[]): boolean {
	return words.some(
		(w) =>
			(/^-[fF]/.test(w) && !w.startsWith("--")) ||
			["--field", "--raw-field", "--input"].some((flag) => w === flag || w.startsWith(`${flag}=`)),
	);
}

export const githubRules: DangerRule[] = [
	{
		id: "gh-api-write",
		description: "change things on GitHub through its API (gh api -X POST/PATCH/PUT/DELETE, -f fields)",
		severity: 80,
		match: ({ effective: words }) => {
			if (words[0] !== "gh" || words[1] !== "api") return false;
			const method = methodOf(words);
			if (method) return !isReadMethod(method);
			// GraphQL always posts; only a mutation changes anything.
			const endpoint = words.slice(2).find((w) => !w.startsWith("-"));
			if (endpoint === "graphql") return words.some((w) => /\bmutation\b/.test(w));
			return sendsFields(words);
		},
	},
	{
		id: "gh-repo-delete",
		description: "delete, archive or change the visibility of a GitHub repo",
		severity: 96,
		match: ({ effective: words }) => {
			if (words[0] !== "gh" || words[1] !== "repo") return false;
			if (words[2] === "delete" || words[2] === "archive") return true;
			return words[2] === "edit" && words.some((w) => w === "--visibility" || w.startsWith("--visibility="));
		},
	},
	{
		id: "gh-release",
		description: "publish or trigger on GitHub (gh release create/edit/delete/upload, gh workflow run, gh secret/variable set or delete)",
		severity: 75,
		match: ({ effective: words }) => {
			if (words[0] !== "gh") return false;
			const [, group, action = ""] = words;
			if (group === "release") return ["create", "edit", "delete", "upload", "delete-asset"].includes(action);
			if (group === "workflow") return action === "run";
			if (group === "secret" || group === "variable") return ["set", "delete", "remove"].includes(action);
			return false;
		},
	},
];
