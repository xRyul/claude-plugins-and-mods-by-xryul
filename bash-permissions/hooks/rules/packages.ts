import type { DangerRule } from "./types";

const PACKAGE_MANAGERS = ["npm", "pnpm", "yarn", "bun"];

export const packageRules: DangerRule[] = [
	{
		id: "npm-publish",
		description: "publish a package, publicly and for good (npm/pnpm/yarn/bun publish, npm unpublish/deprecate)",
		severity: 90,
		match: ({ effective: words }) => {
			if (!PACKAGE_MANAGERS.includes(words[0] ?? "") || words.includes("--dry-run")) return false;
			// Yarn 2+ publishes with `yarn npm publish`.
			const action = words[0] === "yarn" && words[1] === "npm" ? words[2] : words[1];
			if (action === "publish") return true;
			return words[0] === "npm" && (action === "unpublish" || action === "deprecate");
		},
	},
];
