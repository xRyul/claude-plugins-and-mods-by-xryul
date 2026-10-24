/** The shell a command runs under: POSIX, or a Windows shell reached through `powershell.exe` or `cmd.exe`. */
export type Dialect = "sh" | "powershell" | "cmd";

export type MatchContext = {
	/** argv at one stage of unwrapping (`sudo git push`, then `git push`). */
	raw: string[];
	/** argv with wrappers, global options and the command's directory removed. */
	effective: string[];
	/** Where relative paths resolve: the shell's directory after any `cd` earlier in the script. Unknown when undefined. */
	cwd?: string;
	/** The directory the Claude Code session runs in. */
	project?: string;
	home?: string;
	/** Variables the script set earlier (`S=/tmp/x; rm -rf $S`), so paths using them resolve. */
	variables?: Readonly<Record<string, string>>;
	dialect?: Dialect;
	/** True for a command that runs on another machine (`ssh host '…'`). */
	isRemote?: boolean;
	/** Files the command's output is redirected to (`> /dev/sda`). */
	writesTo?: string[];
	/** True when a shell runs a script nobody can read first: piped in, or fetched by `curl`/`wget`. */
	runsUnseenScript?: boolean;
};

export interface DangerRule {
	/** Stable ID used for allowlists (session + persistent). */
	id: string;
	/** Human-readable description shown in approval prompt. */
	description: string;
	/** Higher severity wins when multiple rules match. */
	severity: number;
	/** Return true if the rule matches the command. */
	match: (ctx: MatchContext) => boolean;
}
