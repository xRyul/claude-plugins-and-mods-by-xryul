import { deletesUnfiltered } from "./find";
import { findExpression, findStartPaths, isRiskyTarget, operands } from "./paths";
import type { DangerRule } from "./types";

/** Block devices, where writing over the start destroys a whole disk. */
const DISK_DEVICE = /^\/dev\/(sd|hd|vd|xvd|nvme|mmcblk|disk|md|dm-)/;

/** True when a long flag or a short-flag cluster (`-rf`, `-r -f`) before `--` sets the option. */
function hasFlag(words: string[], long: string, shortLetters: string): boolean {
	const end = words.indexOf("--");
	const options = end === -1 ? words.slice(1) : words.slice(1, end);
	return options.some(
		(w) =>
			w === long ||
			(w.startsWith("-") && !w.startsWith("--") && [...shortLetters].some((letter) => w.includes(letter))),
	);
}

export const filesystemRules: DangerRule[] = [
	{
		// Agents never get rm's own confirmation, so -f adds nothing: any recursive delete counts.
		// Inside the project or /tmp it is routine and stays quiet.
		id: "rm-rf",
		description: "recursive delete outside the project or /tmp, or of /, ~, .. or the project (rm -r)",
		severity: 100,
		match: (context) => {
			const { effective: words } = context;
			if (words[0] !== "rm" || !hasFlag(words, "--recursive", "rR")) return false;
			return operands(words).some((target) => isRiskyTarget(target, context));
		},
	},
	{
		// rm-rf judges recursive deletes by where they point; a plain rm asks wherever it points.
		id: "rm",
		description: "delete files with rm (without -r)",
		severity: 60,
		match: ({ effective: words }) => words[0] === "rm" && !hasFlag(words, "--recursive", "rR"),
	},
	{
		// From the project root it asks unless every -delete sits behind a filter: `find . -delete` empties the project.
		id: "find-delete",
		description: "find … -delete outside the project or /tmp, or over the whole project",
		severity: 95,
		match: (context) => {
			const { effective: words } = context;
			if (words[0] !== "find" || !words.includes("-delete")) return false;
			const isProjectRootRisky = deletesUnfiltered(findExpression(words));
			return findStartPaths(words).some((start) => isRiskyTarget(start, context, { isProjectRootRisky }));
		},
	},
	{
		id: "truncate-shred",
		description: "destroy file or disk contents (shred, truncate -s, > /dev/sd*)",
		severity: 90,
		match: ({ effective: words, writesTo = [] }) =>
			words[0] === "shred" ||
			(words[0] === "truncate" && words.some((w) => w.startsWith("-s") || w.startsWith("--size"))) ||
			writesTo.some((target) => DISK_DEVICE.test(target)),
	},
	{
		// Reading with dd (`dd if=file skip=… count=…`) is harmless; writing is what destroys.
		id: "dd",
		description: "raw write with dd (dd of=)",
		severity: 98,
		match: ({ effective: words }) => words[0] === "dd" && words.some((w) => w.startsWith("of=") && w !== "of=/dev/null"),
	},
	{
		id: "mkfs",
		description: "filesystem format (mkfs.*)",
		severity: 99,
		match: ({ effective: words }) => {
			const w0 = words[0] ?? "";
			return w0 === "mkfs" || w0.startsWith("mkfs.");
		},
	},
	{
		id: "chmod-r-777",
		description: "insecure recursive permissions (chmod -R 777)",
		severity: 70,
		match: ({ effective: words }) => {
			if (words[0] !== "chmod") return false;
			const hasRecursive = words.includes("-R") || words.includes("-r");
			const has777 = words.some((w) => /^0?777$/.test(w));
			return hasRecursive && has777;
		},
	},
	{
		id: "chown-r",
		description: "recursive ownership change (chown -R)",
		severity: 70,
		match: ({ effective: words }) => {
			if (words[0] !== "chown") return false;
			return words.includes("-R") || words.includes("-r");
		},
	},
];
