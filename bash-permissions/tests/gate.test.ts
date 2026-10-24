import type { On } from "claude-code";
import { expect, test, type Engine } from "claude-code/testing";

const SUMMARY = '{"summary":"Overwrites main on origin with your local history.","dangerScore":72}';
const NO_USAGE = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
const SURFACES = ["terminal", "desktop", "vscode", "mobile"] as const;

type Model = "answers" | "fails";

/** Stands for Claude Code's own question dialog, the node bash-permissions's card sits above. */
function engineDialog(on: On) {
	on("ui.render", { component: "AskUserQuestion" }, () => ({ type: "engine" as const, ref: 0 }));
}

/**
 * Stands for the engine beneath bash-permissions: the permission verdict, a model and
 * the question dialog. While a question is open it draws the dialog on every
 * surface, so `cards` holds what the person would see (and a card past the
 * dialog's rows fails the test).
 */
function engine($: Engine, on: On, answer: string, verdict: "allow" | "ask" | "deny" = "allow", model: Model = "answers") {
	const asked: string[] = [];
	const cards: string[] = [];
	engineDialog(on);
	on("session.cwd", () => ({ value: "/home/u/myapp" }));
	on("tool.check", () => ({ decision: verdict }));
	on("model.complete", () => ({
		value:
			model === "answers"
				? { isAnswered: true as const, text: SUMMARY, usage: NO_USAGE }
				: { isAnswered: false as const, reason: "aborted" as const, usage: NO_USAGE },
	}));
	on("tool.call", { tool: "AskUserQuestion" }, async (_, e) => {
		const question = e.questions[0]?.question ?? "";
		asked.push(question);
		for (const surface of SURFACES) {
			const ui = await $.ui.mount({
				plugin: "bash-permissions",
				surface,
				component: "AskUserQuestion",
				props: { tool: "AskUserQuestion", questions: e.questions },
			});
			cards.push(JSON.stringify(await ui.drawn()));
			await ui.unmount();
		}
		return { result: { questions: e.questions, answers: { [question]: answer } } };
	});
	return { asked, cards };
}

let calls = 0;
/** The permission check of one call the model made. */
function bash(command: string) {
	return { tool: "Bash", input: { command }, tool_use_id: `toolu_test_${++calls}` };
}

test("asks before a force push and allows it once", async ($, on) => {
	const { asked } = engine($, on, "Allow once");
	const verdict = await $.tool.check(bash("git push --force origin main"));
	expect(asked).toEqual(["Run git push --force origin main?"]);
	expect(verdict.decision).toBe("allow");
});

test("the card shows risk, explanation and rules on every surface", async ($, on) => {
	const { cards } = engine($, on, "Reject");
	await $.tool.check(bash("git push --force origin main"));
	expect(cards.length).toBe(SURFACES.length);
	for (const card of cards) {
		expect(card).toContain("HIGH RISK");
		expect(card).toContain("72");
		expect(card).toContain("Overwrites main on origin with your local history.");
		expect(card).toContain("git-push-force · also git-push");
	}
});

test("a long explanation and command still fit the terminal dialog", async ($, on) => {
	const long = "word ".repeat(70).trim();
	engineDialog(on);
	on("tool.check", () => ({ decision: "allow" }));
	on("model.complete", () => ({
		value: { isAnswered: true as const, text: JSON.stringify({ summary: long, dangerScore: 20 }), usage: NO_USAGE },
	}));
	on("tool.call", { tool: "AskUserQuestion" }, async (_, e) => {
		const ui = await $.ui.mount({
			plugin: "bash-permissions",
			surface: "terminal",
			component: "AskUserQuestion",
			props: { tool: "AskUserQuestion", questions: e.questions },
		});
		const drawn = JSON.stringify(await ui.drawn());
		expect(drawn).toContain("LOW RISK");
		expect(drawn).toContain('"type":"engine"');
		await ui.unmount();
		return { result: { questions: e.questions, answers: { [e.questions[0]?.question ?? ""]: "Reject" } } };
	});
	const verdict = await $.tool.check(bash(`gt submit --stack && git push origin ${"x".repeat(400)}`));
	expect(verdict.decision).toBe("deny");
});

test("a rejection blocks the command and passes the note to Claude", async ($, on) => {
	engine($, on, "push to a new branch instead");
	const verdict = await $.tool.check(bash("git push --force origin main"));
	expect(verdict.decision).toBe("deny");
	expect(verdict.reason).toContain("push to a new branch instead");
});

test("a dismissed dialog blocks the command", async ($, on) => {
	on("tool.check", () => ({ decision: "allow" }));
	on("model.complete", () => ({ value: { isAnswered: true as const, text: SUMMARY, usage: NO_USAGE } }));
	on("tool.call", { tool: "AskUserQuestion" }, () => ({ deny: "dismissed" }));
	const verdict = await $.tool.check(bash("gt submit --stack"));
	expect(verdict.decision).toBe("deny");
	expect(verdict.reason).toContain("got no answer");
});

test("allow for session stops asking about that rule", async ($, on) => {
	const { asked } = engine($, on, "Allow for session");
	const first = await $.tool.check(bash("git push --force origin main"));
	const second = await $.tool.check(bash("git push -f origin other"));
	expect(asked.length).toBe(1);
	expect([first.decision, second.decision]).toEqual(["allow", "allow"]);
});

test("always allow saves the rules to settings", async ($, on) => {
	const saved: Array<{ key: string; value: unknown }> = [];
	on("config.set", (_, e) => {
		saved.push({ key: e.key, value: e.value });
		return { value: e.value };
	});
	engine($, on, "Always allow");
	const verdict = await $.tool.check(bash("git push --force origin main"));
	expect(verdict.decision).toBe("allow");
	expect(saved).toEqual([{ key: "bash-permissions.alwaysAllow", value: "git-push-force, git-push" }]);
});

test("a model that fails still gets a prompt, with the built-in sentence", async ($, on) => {
	const { cards } = engine($, on, "Reject", "allow", "fails");
	const verdict = await $.tool.check(bash("git push origin main"));
	expect(cards[0]).toContain("Pushes local commits and refs to origin");
	expect(cards[0]).toContain("HIGH RISK");
	expect(cards[0]).toContain("no model");
	expect(verdict.decision).toBe("deny");
});

test("an always-allowed rule keeps the engine's verdict", { options: { alwaysAllow: "git-push-force, git-push" } }, async ($, on) => {
	const { asked } = engine($, on, "Reject", "ask");
	const verdict = await $.tool.check(bash("git push --force origin main"));
	expect(asked).toEqual([]);
	expect(verdict.decision).toBe("ask");
});

test("a quiet rule keeps the engine's verdict", async ($, on) => {
	const { asked } = engine($, on, "Reject");
	const verdict = await $.tool.check(bash("git rebase main"));
	expect(asked).toEqual([]);
	expect(verdict.decision).toBe("allow");
});

test("alwaysAsk turns a quiet rule on", { options: { alwaysAsk: "git-rebase" } }, async ($, on) => {
	const { asked } = engine($, on, "Reject");
	const verdict = await $.tool.check(bash("git rebase main"));
	expect(asked.length).toBe(1);
	expect(verdict.decision).toBe("deny");
});

test("rm -r inside the project stays quiet and outside it asks", async ($, on) => {
	const { asked } = engine($, on, "Reject");
	const inside = await $.tool.check(bash("rm -rf node_modules"));
	const outside = await $.tool.check(bash("rm -rf /etc/nginx"));
	expect([inside.decision, outside.decision]).toEqual(["allow", "deny"]);
	expect(asked.length).toBe(1);
});

test("rm -r follows the shell's directory after a cd", async ($, on) => {
	const { asked } = engine($, on, "Reject");
	on("classic.CwdChanged", () => ({}));
	await $.classic.CwdChanged({ old_cwd: "/home/u/myapp", new_cwd: "/tmp/build" });
	const inTemp = await $.tool.check(bash("rm -rf dist"));
	await $.classic.CwdChanged({ old_cwd: "/tmp/build", new_cwd: "/etc" });
	const inEtc = await $.tool.check(bash("rm -rf nginx"));
	expect([inTemp.decision, inEtc.decision]).toEqual(["allow", "deny"]);
	expect(asked.length).toBe(1);
});

test("the engine's deny stands without asking", async ($, on) => {
	const { asked } = engine($, on, "Allow once", "deny");
	const verdict = await $.tool.check(bash("git push --force origin main"));
	expect(asked).toEqual([]);
	expect(verdict.decision).toBe("deny");
});

test("a query from another plugin answers ask without a dialog", async ($, on) => {
	const { asked } = engine($, on, "Allow once");
	const verdict = await $.tool.check({ tool: "Bash", input: { command: "git push --force" } });
	expect(asked).toEqual([]);
	expect(verdict.decision).toBe("ask");
});

test("someone else's question is drawn as the engine draws it", async ($, on) => {
	engineDialog(on);
	const ui = await $.ui.mount({
		plugin: "bash-permissions",
		surface: "terminal",
		component: "AskUserQuestion",
		props: { tool: "AskUserQuestion", questions: [{ question: "Which library?", header: "Library", options: [], multiSelect: false }] },
	});
	expect(JSON.stringify(await ui.drawn())).not.toContain("RISK");
});
