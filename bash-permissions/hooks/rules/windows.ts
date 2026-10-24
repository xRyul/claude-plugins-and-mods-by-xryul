import type { DangerRule } from "./types";

/** Remove-Item and its aliases. */
const POWERSHELL_DELETES = new Set(["remove-item", "rm", "ri", "del", "erase", "rd", "rmdir"]);
const CMD_DELETES = new Set(["rd", "rmdir", "del", "erase"]);

/** WSL reaches Windows files through /mnt/c, and Windows deletes skip the recycle bin. */
export const windowsRules: DangerRule[] = [
	{
		id: "windows-delete",
		description: "recursive delete on Windows (Remove-Item -Recurse, rd /s, del /s)",
		severity: 95,
		match: ({ effective: words, dialect }) => {
			const command = (words[0] ?? "").toLowerCase().replace(/\.exe$/, "");
			if (dialect === "powershell") {
				// PowerShell takes any unambiguous prefix of a parameter: -r, -rec, -Recurse.
				return POWERSHELL_DELETES.has(command) && words.some((w) => /^-r(e(c(u(r(se?)?)?)?)?)?$/i.test(w));
			}
			if (dialect === "cmd") return CMD_DELETES.has(command) && words.some((w) => /^\/s$/i.test(w));
			return false;
		},
	},
];
