import { atom, read, update } from "claude-code";
import type { EngineInterface, Register } from "claude-code";

import type { PromptView, Prompts, SessionAllowed } from "../types";
import { type DetectContext, findDangerousMatches } from "./detect";
import { explainCommand } from "./explain";
import { DANGER_RULES } from "./rules";
import { DEFAULT_APPROVAL_REQUIRED_RULE_IDS } from "./rules/defaults";

const sessionAllowed = atom({ plugin: "bash-permissions", key: "sessionAllowed" } as const, [] as SessionAllowed);
const prompts = atom({ plugin: "bash-permissions", key: "prompts" } as const, {} as Prompts);
/** The Bash shell's directory after its last `cd`; empty until it first changes. */
const shellCwd = atom({ plugin: "bash-permissions", key: "shellCwd" } as const, "");

const ALLOW_ONCE = "Allow once";
const ALLOW_SESSION = "Allow for session";
const ALWAYS_ALLOW = "Always allow";
const REJECT = "Reject";

const MAX_QUESTION_COMMAND = 160;
const METER_CELLS = 12;
/** Rows the card above the question may take, counted as the engine counts them: a line, plus one per 40 columns. */
const CARD_ROWS = { terminal: 9, desktop: 40, vscode: 40, mobile: 40 } as const;

function ruleIds(value: unknown): string[] {
	return typeof value === "string" ? value.split(/[\s,]+/).filter(Boolean) : [];
}

function commandOf(input: unknown): string {
	if (!input || typeof input !== "object") return "";
	const { command } = input as { command?: unknown };
	return typeof command === "string" ? command.trim() : "";
}

function rowsOf(text: string): number {
	return 1 + Math.floor(text.length / 40);
}

/** Cuts `text` so it takes at most `rows` rows. */
function fit(text: string, rows: number): string {
	const room = Math.max(1, rows) * 40 - 1;
	return text.length > room ? `${text.slice(0, room - 1)}…` : text;
}

/**
 * Where commands run, so `rm -r` inside the project stays quiet and outside it asks.
 * A directory it cannot read stays unknown, which makes relative paths ask.
 */
async function detectContext($: EngineInterface): Promise<DetectContext> {
	const project = await $.session.cwd().catch(() => undefined);
	const home = await $.env.get("HOME").catch(() => undefined);
	return { project, cwd: (await read($, shellCwd)) || project, home };
}

function riskOf(score: number) {
	if (score >= 67) return { label: "HIGH RISK", icon: "◆", tone: "error" } as const;
	if (score >= 34) return { label: "MEDIUM RISK", icon: "▲", tone: "warning" } as const;
	return { label: "LOW RISK", icon: "●", tone: "success" } as const;
}

export const register: Register = (on, options) => {
	const alwaysAllow = ruleIds(options.alwaysAllow);
	const alwaysAsk = ruleIds(options.alwaysAsk);
	const asks = (ruleId: string) =>
		!alwaysAllow.includes(ruleId) && (alwaysAsk.includes(ruleId) || DEFAULT_APPROVAL_REQUIRED_RULE_IDS.has(ruleId));

	on("session.start", async ($, e, next) => {
		await $.command.register({
			name: "bash-permissions",
			description: "Show which Bash commands ask before running, what is allowed, or check a command",
			argumentHint: "[rules | check <command>]",
		});
		return next(e);
	});

	on("classic.CwdChanged", async ($, e, next) => {
		await update($, shellCwd, () => e.new_cwd);
		return next(e);
	});

	on("tool.check", { tool: "Bash" }, async ($, e, next) => {
		const verdict = await next(e);
		if (verdict.decision === "deny") return verdict;

		const command = commandOf(e.input);
		if (!command) return verdict;

		const allowedThisSession = await read($, sessionAllowed);
		const pending = findDangerousMatches(command, await detectContext($)).filter(
			({ rule }) => asks(rule.id) && !allowedThisSession.includes(rule.id),
		);
		const rule = pending[0]?.rule;
		if (!rule) return verdict;
		// One answer covers every rule the command matches, so `git push -f` is not asked about again as `git push`.
		const ruleIdsAsked = pending.map((match) => match.rule.id);

		// A query from another plugin ($.tool.check) has no call to ask about.
		if (!e.tool_use_id) return { decision: "ask", reason: `bash-permissions asks before ${rule.description}` };

		const explanation = await explainCommand(
			{ command, ruleId: rule.id, ruleDescription: rule.description, severity: rule.severity },
			options.explain === false
				? undefined
				: async ({ system, prompt }) => {
						const reply = await $.model.complete({
							model: typeof options.model === "string" && options.model ? options.model : "haiku",
							system,
							prompt,
							maxTokens: 256,
							timeoutMs: 10_000,
						});
						return reply.isAnswered ? reply.text : undefined;
					},
		);

		// The question names the command, so it still reads on its own where the card is not drawn.
		const oneLine = command.replace(/\s*\n\s*/g, " ↵ ");
		const question = `Run ${oneLine.length > MAX_QUESTION_COMMAND ? `${oneLine.slice(0, MAX_QUESTION_COMMAND)}…` : oneLine}?`;
		const view: PromptView = {
			ruleId: rule.id,
			alsoMatches: ruleIdsAsked.slice(1),
			explanation: explanation.text,
			dangerScore: explanation.dangerScore,
			isFallback: explanation.source === "fallback",
		};
		await update($, prompts, (open) => ({ ...open, [question]: view }));

		// The question dialog, not Claude Code's permission prompt: auto mode hands an ask to its classifier.
		// It rejects when dismissed and in a -p run, where nobody can answer: both block the command.
		const answer = await $.ui
			.ask(question, { header: "Permissions", options: [ALLOW_ONCE, ALLOW_SESSION, ALWAYS_ALLOW, REJECT] })
			.catch(() => undefined)
			.finally(() =>
				update($, prompts, (open) => {
					const rest = { ...open };
					delete rest[question];
					return rest;
				}),
			);

		if (answer === ALLOW_ONCE) return { decision: "allow", reason: `bash-permissions: allowed once (${rule.id})` };

		if (answer === ALLOW_SESSION || answer === ALWAYS_ALLOW) {
			await update($, sessionAllowed, (list) => [...list, ...ruleIdsAsked.filter((id) => !list.includes(id))]);
			if (answer === ALLOW_SESSION) {
				$.ui.toast(`Allowed for this session: ${ruleIdsAsked.join(", ")}`);
				return { decision: "allow", reason: `bash-permissions: allowed for this session (${ruleIdsAsked.join(", ")})` };
			}

			// Saving reloads this module with the new list; the session allow covers the moment between.
			const saved = await $.config
				.set({ key: `${$.plugin.name}.alwaysAllow`, value: [...alwaysAllow, ...ruleIdsAsked].join(", ") })
				.catch((error: unknown) => ({ deny: String(error) }));
			$.ui.toast(
				"deny" in saved && saved.deny
					? `Allowed for this session only. Saving to settings failed: ${saved.deny}`
					: `Always allowed: ${ruleIdsAsked.join(", ")}`,
			);
			return { decision: "allow", reason: `bash-permissions: always allowed (${ruleIdsAsked.join(", ")})` };
		}

		if (answer === undefined) {
			return {
				decision: "deny",
				reason: `bash-permissions asked about this command (${rule.description}) and got no answer: the question was dismissed or could not be shown. Do not retry it; ask the user how to proceed.`,
			};
		}
		const note = answer !== REJECT ? ` They said: ${answer}` : "";
		return {
			decision: "deny",
			reason: `The user rejected this command (${rule.description}).${note} Do not retry it; ask them how to proceed.`,
		};
	}).catch(() => ({
		decision: "deny",
		reason: "bash-permissions could not check this command, so it was blocked. Ask the user to run it themselves.",
	}));

	// The card above bash-permissions's own questions: risk, score bar, explanation and rule.
	on("ui.render", { component: "AskUserQuestion" }, async ($, e, next) => {
		const first = e.props.questions[0] as { question?: unknown } | undefined;
		const view = typeof first?.question === "string" ? (await read($, prompts))[first.question] : undefined;
		if (!view) return next(e);

		const { Box, Text } = $.ui.resolve(e);
		const risk = riskOf(view.dangerScore);
		const filled = Math.min(METER_CELLS, Math.max(1, Math.round((view.dangerScore / 100) * METER_CELLS)));
		const also = view.alsoMatches.length > 0 ? ` · also ${view.alsoMatches.join(", ")}` : "";
		const ruleLine = fit(`${view.ruleId}${also}${view.isFallback ? " · no model, built-in text" : ""}`, 2);
		const explanation = fit(view.explanation, CARD_ROWS[e.surface] - 1 - rowsOf(ruleLine));

		return (
			<Box flexDirection="column">
				<Box flexDirection="column" borderStyle="round" borderColor={risk.tone} paddingX={1}>
					<Text>
						<Text color={risk.tone} bold>{`${risk.icon} ${risk.label}  `}</Text>
						<Text color={risk.tone}>{"━".repeat(filled)}</Text>
						<Text dimColor>{"─".repeat(METER_CELLS - filled)}</Text>
						<Text bold>{`  ${view.dangerScore}`}</Text>
						<Text dimColor>/100</Text>
					</Text>
					<Text>{explanation}</Text>
					<Text dimColor>{ruleLine}</Text>
				</Box>
				{await next(e)}
			</Box>
		);
	});

	on("command.run", { command: "bash-permissions" }, async ($, e) => {
		const args = e.args.trim();
		const allowedThisSession = await read($, sessionAllowed);
		const state = (ruleId: string) =>
			allowedThisSession.includes(ruleId) && asks(ruleId) ? "allowed this session" : asks(ruleId) ? "asks" : "quiet";

		if (args.startsWith("check")) {
			const command = args.slice("check".length).trim();
			if (!command) return { text: "Usage: /bash-permissions check <command>" };
			const matches = findDangerousMatches(command, await detectContext($));
			if (matches.length === 0) return { text: `No danger rule matches:\n  ${command}` };
			const lines = matches.map(({ rule }) => `  ${rule.id} (severity ${rule.severity}): ${state(rule.id)}`);
			return { text: [`Rules matching:\n  ${command}`, ...lines].join("\n") };
		}

		if (args === "rules") {
			const width = Math.max(...DANGER_RULES.map((rule) => rule.id.length));
			const lines = [...DANGER_RULES]
				.sort((a, b) => a.id.localeCompare(b.id))
				.map((rule) => `  ${state(rule.id).padEnd(20)} ${rule.id.padEnd(width)}  ${rule.description}`);
			return { text: [`${DANGER_RULES.length} rules:`, ...lines].join("\n") };
		}

		const asking = DANGER_RULES.filter((rule) => asks(rule.id)).length;
		return {
			text: [
				`bash-permissions: ${DANGER_RULES.length} rules, ${asking} ask before running.`,
				`Always allowed (settings): ${alwaysAllow.join(", ") || "none"}`,
				`Also asking (settings): ${alwaysAsk.join(", ") || "none"}`,
				`Allowed this session: ${allowedThisSession.join(", ") || "none"}`,
				`Explanations: ${options.explain === false ? "off" : `on (${typeof options.model === "string" && options.model ? options.model : "haiku"})`}`,
				"",
				"Change the lists in /config under bash-permissions. See every rule with /bash-permissions rules, or test one with /bash-permissions check <command>.",
			].join("\n"),
		};
	});
};
