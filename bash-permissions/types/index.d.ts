/** Rule IDs the person allowed for the rest of the session. */
export type SessionAllowed = string[];

/** What the question dialog draws for one bash-permissions question: the card above it and a note under each option. */
export type PromptView = {
	explanation: string;
	dangerScore: number;
	/** True when the model gave no explanation: the sentence is built in and the score is the rule's severity. */
	isFallback: boolean;
	/** The Bash call's own description, written by Claude; only when the model gave no explanation, absent when Claude gave none. */
	claudeSays?: string;
	/** What choosing each option does, keyed by its label. */
	optionNotes: Record<string, string>;
};

/** Open questions, keyed by the question text the dialog shows. */
export type Prompts = Record<string, PromptView>;

declare module "claude-code" {
	interface PluginState {
		/** `shellCwd`: the Bash shell's directory after its last `cd`, empty until it first changes. */
		"bash-permissions": { sessionAllowed: SessionAllowed; prompts: Prompts; shellCwd: string };
	}
}
