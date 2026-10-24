import { findDangerousMatches } from "../hooks/detect";
import { DANGER_RULES } from "../hooks/rules";
import { DEFAULT_APPROVAL_REQUIRED_RULE_IDS } from "../hooks/rules/defaults";
import { ASKS_BY_DEFAULT, CONTEXT, PARSER_ROWS, type Plan, QUIET_BY_DEFAULT, RULE_ROWS } from "./cases";

type Test = (name: string, body: () => void) => void;
type Expect = (value: unknown) => { toEqual: (expected: unknown) => void };

const ruleIds = (command: string) => findDangerousMatches(command, CONTEXT).map(({ rule }) => rule.id);
const label = (plan: Plan | undefined, row: number) => (plan === "gaps" ? `gap ${row}` : `row ${row}`);

/** The detection tests, one per row of the rule plan, for whichever runner passes its `test` and `expect`. */
export function defineDetectionSuite(test: Test, expect: Expect) {
	for (const { plan, row, ruleId, catches, ignores } of RULE_ROWS) {
		test(`${label(plan, row)}: ${ruleId}`, () => {
			const missed = catches.filter((command) => !ruleIds(command).includes(ruleId));
			const wronglyCaught = ignores.filter((command) => ruleIds(command).includes(ruleId));
			expect({ missed, wronglyCaught }).toEqual({ missed: [], wronglyCaught: [] });
		});
	}

	for (const { plan, row, name, catches, ignores } of PARSER_ROWS) {
		test(`${label(plan, row)}: ${name}`, () => {
			const missed = catches.filter(([command, ruleId]) => !ruleIds(command).includes(ruleId)).map(([command, ruleId]) => `${command} → ${ruleId}`);
			const wronglyCaught = ignores.filter((command) => ruleIds(command).length > 0).map((command) => `${command} → ${ruleIds(command).join(", ")}`);
			expect({ missed, wronglyCaught }).toEqual({ missed: [], wronglyCaught: [] });
		});
	}

	for (const { row, ruleIds: ids } of ASKS_BY_DEFAULT) {
		test(`row ${row}: ${ids.length === 1 ? ids[0] : `${ids.length} rules`} ask by default`, () => {
			expect(ids.filter((id) => !DEFAULT_APPROVAL_REQUIRED_RULE_IDS.has(id))).toEqual([]);
		});
	}

	for (const { row, ruleIds: ids } of QUIET_BY_DEFAULT) {
		test(`row ${row}: ${ids.join(", ")} stay quiet by default`, () => {
			expect(ids.filter((id) => DEFAULT_APPROVAL_REQUIRED_RULE_IDS.has(id))).toEqual([]);
		});
	}

	test("every default names a rule that exists", () => {
		const known = new Set(DANGER_RULES.map((rule) => rule.id));
		expect([...DEFAULT_APPROVAL_REQUIRED_RULE_IDS].filter((id) => !known.has(id))).toEqual([]);
	});

	test("the most severe rule comes first", () => {
		expect(ruleIds("git push --force && gt submit")[0]).toEqual("git-push-force");
	});
}
