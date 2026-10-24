import { isReadMethod, methodOf } from "./http";
import type { DangerRule } from "./types";

const CLERK_RECORD_WRITES = ["create", "update", "delete", "ban", "unban", "lock", "unlock", "remove"];
const STRIPE_WRITES = ["create", "update", "delete", "cancel", "capture", "confirm", "pay", "void", "finalize", "refund", "close"];
const NOTION_WRITES = new Set(["create", "update", "delete", "patch", "append", "archive", "trash", "move"]);

export const serviceRules: DangerRule[] = [
	{
		id: "clerk-mutate",
		description: "change Clerk users, config or deploys (clerk api writes, users delete/ban, config set/patch, deploy)",
		severity: 85,
		match: ({ effective: words }) => {
			if (words[0] !== "clerk" || words.includes("--dry-run")) return false;
			const [, group, action = ""] = words;
			if (group === "api") {
				const method = methodOf(words);
				if (method) return !isReadMethod(method);
				// A body makes `clerk api` send a POST.
				return words.some((w) => w === "-d" || /^-d./.test(w) || w.startsWith("--data") || w === "--file" || w.startsWith("--file="));
			}
			if (group === "deploy") return true;
			if (group === "config") return ["set", "patch", "put", "push", "apply"].includes(action);
			if (group === "users" || group === "orgs" || group === "organizations") return CLERK_RECORD_WRITES.includes(action);
			return false;
		},
	},
	{
		id: "resend-send",
		description: "send real email (resend … send)",
		severity: 70,
		match: ({ effective: words }) => words[0] === "resend" && words.slice(1).includes("send"),
	},
	{
		id: "stripe-mutate",
		description: "change Stripe objects, which moves real money on a live key (stripe <resource> create/update/cancel, stripe post/delete)",
		severity: 85,
		match: ({ effective: words }) => {
			if (words[0] !== "stripe") return false;
			if (words[1] === "post" || words[1] === "delete") return true;
			return !(words[1] ?? "-").startsWith("-") && STRIPE_WRITES.includes(words[2] ?? "");
		},
	},
	{
		id: "ntn-write",
		description: "write to Notion (ntn create/update/delete/patch/append, a non-GET ntn api call, notion_write.py)",
		severity: 60,
		match: ({ effective: words }) => {
			if (words[0] === "ntn") {
				const method = methodOf(words);
				if (method) return !isReadMethod(method);
				return words.slice(1).some((w) => NOTION_WRITES.has(w.toLowerCase()));
			}
			// The notion-cli skill's helpers write through `ntn api`.
			const isHelper = /^python[\d.]*$/.test(words[0] ?? "") && /(^|\/)notion_(write|tool)\.py$/.test(words[1] ?? "");
			return isHelper && !words.includes("--dry-run") && words.slice(2).some((w) => /^(write|append|patch|create|update|delete|archive|restore|replace|set)/.test(w));
		},
	},
	{
		id: "upstash-mutate",
		description: "wipe Redis data (redis-cli flushall/flushdb, upstash delete/flush)",
		severity: 88,
		match: ({ effective: words }) => {
			if (words[0] === "redis-cli") return words.some((w) => /^flush(all|db)$/i.test(w));
			if (words[0] === "upstash") return words.slice(1).some((w) => /^(delete|remove|rm|flush|flushall|flushdb|purge|reset)$/i.test(w));
			return false;
		},
	},
];
