import type { DangerRule } from "./types";

export const privilegeRules: DangerRule[] = [
	{
		id: "sudo",
		description: "superuser command (sudo)",
		severity: 80,
		match: ({ raw }) => raw[0] === "sudo",
	},
];
