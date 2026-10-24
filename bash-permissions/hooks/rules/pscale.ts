import type { DangerRule } from "./types";

const DATABASE_SUBCOMMANDS = ["database", "db"] as const;
const DEPLOY_REQUEST_SUBCOMMANDS = ["deploy-request", "dr"] as const;

function isPscale(words: string[]): boolean {
	return words[0] === "pscale";
}

function isPscaleCommand(words: string[], ...subcommands: string[]): boolean {
	return isPscale(words) && subcommands.includes(words[1] ?? "");
}

function isPscaleNestedCommand(words: string[], groups: readonly string[], ...subcommands: string[]): boolean {
	return isPscale(words) && groups.includes(words[1] ?? "") && subcommands.includes(words[2] ?? "");
}

function hasLongFlag(words: string[], flag: string): boolean {
	return words.some((w) => w === flag || w.startsWith(`${flag}=`));
}

export const pscaleRules: DangerRule[] = [
	{
		id: "pscale-database-delete",
		description: "PlanetScale database delete (pscale database delete / pscale db delete)",
		severity: 92,
		match: ({ effective: words }) => isPscaleNestedCommand(words, DATABASE_SUBCOMMANDS, "delete"),
	},
	{
		id: "pscale-branch-delete",
		description: "PlanetScale branch delete (pscale branch delete)",
		severity: 88,
		match: ({ effective: words }) => isPscaleNestedCommand(words, ["branch"], "delete"),
	},
	{
		id: "pscale-deploy-request-deploy",
		description: "PlanetScale deploy request deploy (pscale deploy-request deploy / pscale dr deploy)",
		severity: 86,
		match: ({ effective: words }) => isPscaleNestedCommand(words, DEPLOY_REQUEST_SUBCOMMANDS, "deploy"),
	},
	{
		id: "pscale-deploy-request-apply",
		description: "PlanetScale deploy request apply (pscale deploy-request apply / pscale dr apply)",
		severity: 85,
		match: ({ effective: words }) => isPscaleNestedCommand(words, DEPLOY_REQUEST_SUBCOMMANDS, "apply"),
	},
	{
		id: "pscale-deploy-request-revert",
		description: "PlanetScale deploy request revert (pscale deploy-request revert / pscale dr revert)",
		severity: 84,
		match: ({ effective: words }) => isPscaleNestedCommand(words, DEPLOY_REQUEST_SUBCOMMANDS, "revert"),
	},
	{
		id: "pscale-service-token-delete",
		description: "PlanetScale service-token delete (pscale service-token delete)",
		severity: 83,
		match: ({ effective: words }) => isPscaleNestedCommand(words, ["service-token"], "delete"),
	},
	{
		id: "pscale-deploy-request-approve",
		description: "PlanetScale deploy request approve (pscale deploy-request review --approve / pscale dr review --approve)",
		severity: 82,
		match: ({ effective: words }) => {
			if (!isPscaleNestedCommand(words, DEPLOY_REQUEST_SUBCOMMANDS, "review")) return false;
			return hasLongFlag(words, "--approve");
		},
	},
	{
		id: "pscale-password-delete",
		description: "PlanetScale password delete (pscale password delete)",
		severity: 81,
		match: ({ effective: words }) => isPscaleNestedCommand(words, ["password"], "delete"),
	},
	{
		id: "pscale-service-token-create",
		description: "PlanetScale service-token create (pscale service-token create)",
		severity: 80,
		match: ({ effective: words }) => isPscaleNestedCommand(words, ["service-token"], "create"),
	},
	{
		id: "pscale-password-create",
		description: "PlanetScale password create (pscale password create)",
		severity: 79,
		match: ({ effective: words }) => isPscaleNestedCommand(words, ["password"], "create"),
	},
	{
		id: "pscale-deploy-request-create",
		description: "PlanetScale deploy request create (pscale deploy-request create / pscale dr create)",
		severity: 78,
		match: ({ effective: words }) => isPscaleNestedCommand(words, DEPLOY_REQUEST_SUBCOMMANDS, "create"),
	},
	{
		id: "pscale-deploy-request-close",
		description: "PlanetScale deploy request close (pscale deploy-request close / pscale dr close)",
		severity: 76,
		match: ({ effective: words }) => isPscaleNestedCommand(words, DEPLOY_REQUEST_SUBCOMMANDS, "close"),
	},
	{
		id: "pscale-deploy-request-cancel",
		description: "PlanetScale deploy request cancel (pscale deploy-request cancel / pscale dr cancel)",
		severity: 75,
		match: ({ effective: words }) => isPscaleNestedCommand(words, DEPLOY_REQUEST_SUBCOMMANDS, "cancel"),
	},
	{
		id: "pscale-deploy-request-skip-revert",
		description: "PlanetScale deploy request skip-revert (pscale deploy-request skip-revert / pscale dr skip-revert)",
		severity: 74,
		match: ({ effective: words }) => isPscaleNestedCommand(words, DEPLOY_REQUEST_SUBCOMMANDS, "skip-revert"),
	},
	{
		id: "pscale-shell",
		description: "PlanetScale shell (pscale shell)",
		severity: 72,
		match: ({ effective: words }) => isPscaleCommand(words, "shell"),
	},
	{
		id: "pscale-connect",
		description: "PlanetScale connect (pscale connect)",
		severity: 70,
		match: ({ effective: words }) => isPscaleCommand(words, "connect"),
	},
];
