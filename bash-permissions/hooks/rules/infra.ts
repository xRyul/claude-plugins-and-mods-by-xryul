import type { DangerRule } from "./types";

/** Vercel commands that deploy, promote or remove a deployment. */
const VERCEL_DEPLOYS = new Set(["deploy", "promote", "redeploy", "remove", "rm", "rollback"]);
const VERCEL_VALUE_OPTIONS = new Set(["--token", "-t", "--scope", "-S", "--cwd", "-A", "--local-config", "-Q", "--global-config", "--team", "-T"]);

/** Bare `vercel` and `vercel --prod` deploy, as does `vercel ./site`; `vercel curl`, `vercel env` do not. */
function isVercelDeploy(words: string[]): boolean {
	let i = 1;
	while (i < words.length && (words[i] ?? "").startsWith("-")) {
		if (["-v", "-h"].includes(words[i] ?? "")) return false;
		i += VERCEL_VALUE_OPTIONS.has(words[i] ?? "") ? 2 : 1;
	}
	const command = words[i];
	return command === undefined || VERCEL_DEPLOYS.has(command) || /^[./~]|\//.test(command);
}

function hasVolumesFlag(words: string[]): boolean {
	return words.includes("-v") || words.includes("--volumes");
}

export const infraRules: DangerRule[] = [
	{
		id: "infra-deploy",
		description: "deploy or tear down infrastructure (vercel deploy/rm, docker prune/volume rm, helm uninstall, pulumi up/destroy, fly deploy/destroy)",
		severity: 88,
		match: ({ effective: words }) => {
			const [tool, action = "", next = ""] = words;
			switch (tool) {
				case "vercel":
					return isVercelDeploy(words);
				case "docker":
					if (action === "compose") return words.includes("down") && hasVolumesFlag(words);
					return (action === "system" && next === "prune") || (action === "volume" && ["rm", "remove", "prune"].includes(next));
				case "docker-compose":
					return action === "down" && hasVolumesFlag(words);
				case "helm":
					return ["uninstall", "delete", "del", "un"].includes(action);
				case "pulumi":
					return ["up", "update", "destroy"].includes(action) || (action === "stack" && next === "rm");
				case "fly":
				case "flyctl":
					return action === "deploy" || action === "destroy" || (action === "apps" && (next === "destroy" || next === "delete"));
				default:
					return false;
			}
		},
	},
	{
		id: "terraform-apply",
		description: "terraform apply",
		severity: 90,
		match: ({ effective: words }) => words[0] === "terraform" && words[1] === "apply",
	},
	{
		id: "terraform-destroy",
		description: "terraform destroy",
		severity: 95,
		match: ({ effective: words }) => words[0] === "terraform" && words[1] === "destroy",
	},
	{
		id: "kubectl-apply",
		description: "kubectl apply",
		severity: 85,
		match: ({ effective: words }) => words[0] === "kubectl" && words[1] === "apply",
	},
	{
		id: "kubectl-delete",
		description: "kubectl delete",
		severity: 85,
		match: ({ effective: words }) => words[0] === "kubectl" && words[1] === "delete",
	},
];
