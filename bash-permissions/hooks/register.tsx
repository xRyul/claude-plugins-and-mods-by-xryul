import { atom, read, update } from "claude-code";
import type { EngineInterface, Register } from "claude-code";

import type { PromptView, Prompts, SessionAllowed } from "../types";
import { describeDeletes } from "./describe";
import { type DetectContext, findDangerousMatches } from "./detect";
import { explainCommand } from "./explain";
import { DANGER_RULES } from "./rules";
import { DEFAULT_APPROVAL_REQUIRED_RULE_IDS } from "./rules/defaults";

const sessionAllowed = atom({ plugin: "bash-permissions", key: "sessionAllowed" } as const, [] as SessionAllowed);
const prompts = atom({ plugin: "bash-permissions", key: "prompts" } as const, {} as Prompts);
/** The Bash shell's directory after its last `cd`; empty until it first changes. */
const shellCwd = atom({ plugin: "bash-permissions", key: "shellCwd" } as const, "");

const ALLOW_ONCE = "Allow once";
const REJECT = "Reject";

const METER_CELLS = 12;
/** Rows the card above the question may take, counted as the engine counts them: a line, plus one per 40 columns. The terminal allows 12, its border taking two. */
const CARD_ROWS = { terminal: 10, desktop: 40, vscode: 40, mobile: 40 } as const;

function ruleIds(value: unknown): string[] {
	return typeof value === "string" ? value.split(/[\s,]+/).filter(Boolean) : [];
}

function commandOf(input: unknown): string {
	if (!input || typeof input !== "object") return "";
	const { command } = input as { command?: unknown };
	return typeof command === "string" ? command.trim() : "";
}

/**
 * The Bash call's `description`, on one line; undefined when Claude gave none.
 * Control and direction characters go, so the text cannot restyle the terminal or reorder itself.
 */
function descriptionOf(input: unknown): string | undefined {
	if (!input || typeof input !== "object") return undefined;
	const { description } = input as { description?: unknown };
	const text =
		typeof description === "string"
			? description.replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, " ").replace(/\s+/g, " ").trim()
			: "";
	return text || undefined;
}

/** The question with each option's note as its description, which the dialog draws under the label. */
function withNotes(question: unknown, notes: Record<string, string>): unknown {
	const { options } = question as { options?: unknown };
	if (!Array.isArray(options)) return question;
	return {
		...(question as object),
		options: options.map((option: unknown) => {
			const { label } = option as { label?: unknown };
			const note = typeof label === "string" ? notes[label] : undefined;
			return note ? { ...(option as object), description: note } : option;
		}),
	};
}

/** `a`, `a and b`, `a, b and c`. */
function joinAnd(parts: string[]): string {
	return parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
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
		const context = await detectContext($);
		const pending = findDangerousMatches(command, context).filter(
			({ rule }) => asks(rule.id) && !allowedThisSession.includes(rule.id),
		);
		const rule = pending[0]?.rule;
		if (!rule) return verdict;
		// One answer covers every rule the command matches, so `git push -f` is not asked about again as `git push`.
		const ruleIdsAsked = pending.map((match) => match.rule.id);

		// A query from another plugin ($.tool.check) has no call to ask about.
		if (!e.tool_use_id) return { decision: "ask", reason: `bash-permissions asks before ${rule.description}` };

		const explanation = await explainCommand(
			{
				command,
				ruleId: rule.id,
				ruleDescription: rule.description,
				severity: rule.severity,
				deletes: describeDeletes(pending, context.home),
			},
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

		// The whole command, never cut: the person approves what they can read, and the dialog wraps it.
		// The card above it is held to a few rows, so the command lives here.
		const question = `Run ${command.replace(/\s*\n\s*/g, " ↵ ")}?`;
		// The session and always options switch off whole rules, so their labels name them.
		const rules = ruleIdsAsked.join(", ");
		const allowSession = `Allow ${rules} for session`;
		const allowAlways = `Always allow ${rules}`;
		const view: PromptView = {
			explanation: explanation.text,
			dangerScore: explanation.dangerScore,
			isFallback: explanation.source === "fallback",
			// The model's sentence says what Claude's own description would, so Claude's shows only in its place.
			claudeSays: explanation.source === "fallback" ? descriptionOf(e.input) : undefined,
			optionNotes: {
				[ALLOW_ONCE]: "Runs this command. Asks again next time.",
				[allowSession]: `Stops asking about ${joinAnd(ruleIdsAsked)} until you quit Claude Code.`,
				[allowAlways]: `Saved to settings: never asks about ${joinAnd(ruleIdsAsked)} again.`,
				[REJECT]: "Blocks it and tells Claude not to retry.",
			},
		};
		await update($, prompts, (open) => ({ ...open, [question]: view }));

		// The question dialog, not Claude Code's permission prompt: auto mode hands an ask to its classifier.
		// It rejects when dismissed and in a -p run, where nobody can answer: both block the command.
		const answer = await $.ui
			.ask(question, { header: "Permissions", options: [ALLOW_ONCE, allowSession, allowAlways, REJECT] })
			.catch(() => undefined)
			.finally(() =>
				update($, prompts, (open) => {
					const rest = { ...open };
					delete rest[question];
					return rest;
				}),
			);

		if (answer === ALLOW_ONCE) return { decision: "allow", reason: `bash-permissions: allowed once (${rule.id})` };

		if (answer === allowSession || answer === allowAlways) {
			await update($, sessionAllowed, (list) => [...list, ...ruleIdsAsked.filter((id) => !list.includes(id))]);
			if (answer === allowSession) {
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

	// The card above bash-permissions's own questions: risk, explanation and Claude's description.
	// The question below it holds the whole command; each option gets a note saying what it allows.
	on("ui.render", { component: "AskUserQuestion" }, async ($, e, next) => {
		const first = e.props.questions[0] as { question?: unknown } | undefined;
		const view = typeof first?.question === "string" ? (await read($, prompts))[first.question] : undefined;
		if (!view) return next(e);

		const { Box, Text } = $.ui.resolve(e);
		const risk = riskOf(view.dangerScore);
		const filled = Math.min(METER_CELLS, Math.max(1, Math.round((view.dangerScore / 100) * METER_CELLS)));
		// Up to three rows: Claude's descriptions are a short sentence, and cutting one hides the point of it.
		const claudeSays = view.claudeSays ? fit(`Claude's reason: ${view.claudeSays}`, 3) : undefined;
		const explanation = fit(view.explanation, CARD_ROWS[e.surface] - 1 - (claudeSays ? rowsOf(claudeSays) : 0));
		// Without a model the score is the rule's fixed severity, so it is not drawn as a measurement.
		const score = view.isFallback ? (
			<Text dimColor>{` · rule severity ${view.dangerScore}`}</Text>
		) : (
			<Text>
				<Text color={risk.tone}>{`  ${"━".repeat(filled)}`}</Text>
				<Text dimColor>{"─".repeat(METER_CELLS - filled)}</Text>
				<Text bold>{`  ${view.dangerScore}`}</Text>
				<Text dimColor>/100</Text>
			</Text>
		);
		const questions = e.props.questions.map((question, index) => (index === 0 ? withNotes(question, view.optionNotes) : question));

		return (
			<Box flexDirection="column">
				<Box flexDirection="column" borderStyle="round" borderColor={risk.tone} paddingX={1}>
					<Text>
						<Text color={risk.tone} bold>{`${risk.icon} ${risk.label}`}</Text>
						{score}
					</Text>
					<Text>{explanation}</Text>
					{claudeSays ? <Text dimColor>{claudeSays}</Text> : null}
				</Box>
				{await next({ ...e, props: { ...e.props, questions } })}
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
