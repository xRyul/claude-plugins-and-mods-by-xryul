/** Rule IDs the person allowed for the rest of the session. */
export type SessionAllowed = string[];

/** What the question dialog draws above its options for one bash-permissions question. */
export type PromptView = {
	ruleId: string;
	/** Other rules the same answer covers. */
	alsoMatches: string[];
	explanation: string;
	dangerScore: number;
	/** True when the model gave no explanation and the built-in sentence stands in. */
	isFallback: boolean;
};

/** Open questions, keyed by the question text the dialog shows. */
export type Prompts = Record<string, PromptView>;

declare module "claude-code" {
	interface PluginState {
		/** `shellCwd`: the Bash shell's directory after its last `cd`, empty until it first changes. */
		"bash-permissions": { sessionAllowed: SessionAllowed; prompts: Prompts; shellCwd: string };
	}
}
