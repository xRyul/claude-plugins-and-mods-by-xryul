import type { DangerRule } from "./types";

const KILL_SIGNAL = /^(9|kill|sigkill)$/i;

export const systemRules: DangerRule[] = [
	{
		// detect.ts sets `runsUnseenScript` where a shell reads its script from a pipe or a download.
		id: "pipe-to-shell",
		description: "run a script piped or downloaded into a shell (curl … | sh, sh <(curl …))",
		severity: 92,
		match: ({ runsUnseenScript }) => runsUnseenScript === true,
	},
	{
		id: "process-kill",
		description: "kill processes (pkill, killall, kill -9)",
		severity: 55,
		match: ({ effective: words }) => {
			if (words[0] === "pkill" || words[0] === "killall") return true;
			if (words[0] !== "kill") return false;
			return words.some(
				(w, i) =>
					/^-(9|kill|sigkill)$/i.test(w) ||
					/^--signal=(9|kill|sigkill)$/i.test(w) ||
					((w === "-s" || w === "-n" || w === "--signal") && KILL_SIGNAL.test(words[i + 1] ?? "")),
			);
		},
	},
];
