import { cloudflareRules } from "./cloudflare";
import { databaseRules } from "./database";
import { filesystemRules } from "./filesystem";
import { gitRules } from "./git";
import { githubRules } from "./github";
import { graphiteRules } from "./graphite";
import { pscaleRules } from "./pscale";
import { mysqlRules } from "./mysql";
import { obsidianRules } from "./obsidian";
import { infraRules } from "./infra";
import { packageRules } from "./packages";
import { privilegeRules } from "./privilege";
import { prRules } from "./pr";
import { serviceRules } from "./services";
import { systemRules } from "./system";
import type { DangerRule } from "./types";
import { windowsRules } from "./windows";

export type { DangerRule, Dialect, MatchContext } from "./types";

export const DANGER_RULES: DangerRule[] = [
	...privilegeRules,
	...systemRules,
	...filesystemRules,
	...windowsRules,
	...infraRules,
	...cloudflareRules,
	...graphiteRules,
	...pscaleRules,
	...mysqlRules,
	...databaseRules,
	...obsidianRules,
	...serviceRules,
	...packageRules,
	...gitRules,
	...prRules,
	...githubRules,
];
