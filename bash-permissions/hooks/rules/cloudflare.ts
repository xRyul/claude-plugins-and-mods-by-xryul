import type { DangerRule } from "./types";

const SECRET_ACTIONS = ["put", "delete", "bulk"];

function optionValue(words: string[], flag: string): string | undefined {
	const index = words.indexOf(flag);
	if (index !== -1) return words[index + 1];
	return words.find((w) => w.startsWith(`${flag}=`))?.slice(flag.length + 1);
}

/** `--command "SELECT …"` that only reads; a `--file` could hold anything. */
function isReadOnlySql(words: string[]): boolean {
	const sql = optionValue(words, "--command");
	if (sql === undefined) return false;
	return /^\s*(select|pragma|explain|with)\b/i.test(sql) && !/\b(insert|update|delete|drop|alter|create|replace|truncate)\b/i.test(sql);
}

function isSecretCommand(words: string[]): boolean {
	return (
		(words[1] === "secret" && SECRET_ACTIONS.includes(words[2] ?? "")) ||
		((words[1] === "versions" || words[1] === "pages") && words[2] === "secret" && SECRET_ACTIONS.includes(words[3] ?? "")) ||
		SECRET_ACTIONS.some((action) => words[1] === `secret:${action}`)
	);
}

export const cloudflareRules: DangerRule[] = [
	{
		id: "wrangler-deploy",
		description: "ship to Cloudflare production (wrangler deploy, versions deploy, rollback, pages deploy)",
		severity: 88,
		match: ({ effective: words }) => {
			if (words[0] !== "wrangler" || words.includes("--dry-run")) return false;
			const [, group, action] = words;
			if (group === "deploy" || group === "publish" || group === "rollback") return true;
			if (group === "versions") return action === "deploy";
			return group === "pages" && (action === "deploy" || action === "publish");
		},
	},
	{
		id: "wrangler-remote-data",
		description: "change live Cloudflare data (wrangler d1 execute/migrations apply --remote, r2/kv deletes, wrangler delete)",
		severity: 90,
		match: ({ effective: words }) => {
			if (words[0] !== "wrangler" || isSecretCommand(words)) return false;
			const isRemote = words.includes("--remote");
			if (words[1] === "d1" && words[2] === "execute") return isRemote && !isReadOnlySql(words);
			if (words[1] === "d1" && words[2] === "migrations") return words[3] === "apply" && isRemote;
			// `wrangler delete` removes a Worker; `r2 object delete`, `kv key delete`, `kv:key delete`, `d1 delete`, …
			return words.slice(1, 4).includes("delete");
		},
	},
	{
		id: "wrangler-secret",
		description: "change Worker secrets (wrangler secret put/delete/bulk)",
		severity: 78,
		match: ({ effective: words }) => words[0] === "wrangler" && isSecretCommand(words),
	},
];
