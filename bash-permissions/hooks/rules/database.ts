import type { DangerRule } from "./types";

/** It cannot tell a local database from production, so some prompts will be for local ones. */
export const databaseRules: DangerRule[] = [
	{
		id: "drizzle-push",
		description: "push or reset a database schema (drizzle-kit push/drop, prisma db push, prisma migrate reset)",
		severity: 86,
		match: ({ effective: words }) => {
			const [tool, action = "", next] = words;
			if (tool === "drizzle-kit") return action === "push" || action.startsWith("push:") || action === "drop";
			if (tool === "prisma") return (action === "db" && next === "push") || (action === "migrate" && next === "reset");
			return false;
		},
	},
];
