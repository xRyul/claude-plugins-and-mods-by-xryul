/**
 * A small shell reader for permission checks. It splits a script into the
 * simple commands it would run, with quotes removed, and collects the scripts
 * nested in `$(…)`, backticks, `<(…)` and `>(…)` so they can be read in turn.
 *
 * It never throws: an unterminated quote or bracket runs to the end of the
 * script. It reads what is written, so a command built at run time (a
 * variable holding `git push`) is not seen.
 */

export interface Redirect {
	operator: string;
	target: string;
}

export interface SimpleCommand {
	/** argv with quotes removed; redirections and their targets left out. */
	words: string[];
	/** The scripts of the substitutions written in each word, aligned with `words`. */
	substitutions: string[][];
	/** Whether each word had any part quoted or escaped, aligned with `words`. */
	quoted: boolean[];
	/** True when stdin comes from a file, a heredoc or a here-string. */
	hasStdinRedirect: boolean;
	/** The bodies of the command's heredocs, in order. */
	heredocs: string[];
	/** Redirections to and from files (`> out.txt`, `2>&1`), in order. */
	redirects: Redirect[];
	/** The command whose output is piped into this one's stdin. */
	pipedFrom?: SimpleCommand;
}

export interface ParsedScript {
	commands: SimpleCommand[];
	/** Scripts nested in command or process substitutions. */
	nested: string[];
}

interface PendingHeredoc {
	delimiter: string;
	stripTabs: boolean;
	owner: SimpleCommand;
}

const REDIRECT_OPERATORS = ["&>>", "<<<", "<<-", "&>", "<<", "<&", "<>", ">>", ">&", ">|", "<", ">"];

function newCommand(): SimpleCommand {
	return { words: [], substitutions: [], quoted: [], hasStdinRedirect: false, heredocs: [], redirects: [] };
}

/** Index of the `"` that closes a double-quoted string starting at `start`. */
function skipDoubleQuoted(script: string, start: number): number {
	for (let j = start; j < script.length; j++) {
		const c = script[j];
		if (c === "\\") j++;
		else if (c === '"') return j;
		else if (c === "$" && script[j + 1] === "(") j = findClosing(script, j + 1);
		else if (c === "`") j = findBacktick(script, j + 1);
	}
	return script.length;
}

/** Index of the unescaped backtick that closes one opened before `start`. */
function findBacktick(script: string, start: number): number {
	for (let j = start; j < script.length; j++) {
		if (script[j] === "\\") j++;
		else if (script[j] === "`") return j;
	}
	return script.length;
}

/** Index of the bracket that closes the one at `openIndex`, quotes respected. */
function findClosing(script: string, openIndex: number): number {
	const open = script[openIndex];
	const close = open === "(" ? ")" : "}";
	let depth = 0;
	for (let j = openIndex; j < script.length; j++) {
		const c = script[j];
		if (c === "\\") j++;
		else if (c === "'") {
			const end = script.indexOf("'", j + 1);
			if (end === -1) return script.length;
			j = end;
		} else if (c === '"') j = skipDoubleQuoted(script, j + 1);
		else if (c === "`") j = findBacktick(script, j + 1);
		else if (c === open) depth++;
		else if (c === close && --depth === 0) return j;
	}
	return script.length;
}

function ansiEscape(letter: string): string {
	const escapes: Record<string, string> = { n: "\n", t: "\t", r: "\r", "'": "'", '"': '"', "\\": "\\" };
	return escapes[letter] ?? letter;
}

/** Reads heredoc bodies starting at `start`, the line after their command. */
function readHeredocs(script: string, start: number, heredocs: PendingHeredoc[]): number {
	let index = start;
	for (const heredoc of heredocs) {
		const body: string[] = [];
		while (index < script.length) {
			const lineEnd = script.indexOf("\n", index);
			const end = lineEnd === -1 ? script.length : lineEnd;
			const line = script.slice(index, end);
			index = end + 1;
			if ((heredoc.stripTabs ? line.replace(/^\t+/, "") : line) === heredoc.delimiter) break;
			body.push(line);
		}
		heredoc.owner.heredocs.push(body.join("\n"));
	}
	return index;
}

export function parseScript(script: string): ParsedScript {
	const commands: SimpleCommand[] = [];
	const nested: string[] = [];
	let pending: PendingHeredoc[] = [];

	let current = newCommand();
	let word = "";
	let wordSubstitutions: string[] = [];
	let inWord = false;
	let isQuoted = false;
	let redirectOperator: string | undefined;

	function substitute(inner: string) {
		nested.push(inner);
		wordSubstitutions.push(inner);
		inWord = true;
	}

	function endWord() {
		if (!inWord) return;
		if (redirectOperator === "<<" || redirectOperator === "<<-") {
			pending.push({ delimiter: word, stripTabs: redirectOperator === "<<-", owner: current });
		} else if (redirectOperator !== undefined) {
			current.redirects.push({ operator: redirectOperator, target: word });
		} else {
			current.words.push(word);
			current.substitutions.push(wordSubstitutions);
			current.quoted.push(isQuoted);
		}
		redirectOperator = undefined;
		word = "";
		wordSubstitutions = [];
		inWord = false;
		isQuoted = false;
	}

	function endCommand() {
		endWord();
		redirectOperator = undefined;
		const hasContent =
			current.words.length > 0 ||
			current.redirects.length > 0 ||
			current.heredocs.length > 0 ||
			pending.some((p) => p.owner === current);
		if (hasContent) commands.push(current);
		current = newCommand();
	}

	function readDoubleQuoted(start: number): number {
		inWord = true;
		isQuoted = true;
		let j = start;
		while (j < script.length) {
			const c = script[j];
			if (c === '"') return j + 1;
			if (c === "\\" && j + 1 < script.length) {
				const next = script[j + 1] ?? "";
				if (next !== "\n") word += "$`\"\\".includes(next) ? next : `\\${next}`;
				j += 2;
			} else if (c === "$" && script[j + 1] === "(") {
				const end = findClosing(script, j + 1);
				if (script[j + 2] !== "(") substitute(script.slice(j + 2, end));
				j = end + 1;
			} else if (c === "`") {
				const end = findBacktick(script, j + 1);
				substitute(script.slice(j + 1, end).replace(/\\([`\\$])/g, "$1"));
				j = end + 1;
			} else {
				word += c;
				j++;
			}
		}
		return j;
	}

	let i = 0;
	while (i < script.length) {
		const c = script[i] ?? "";
		const next = script[i + 1];

		if (c === "\n") {
			endCommand();
			i++;
			if (pending.length > 0) {
				i = readHeredocs(script, i, pending);
				pending = [];
			}
			continue;
		}
		if (c === " " || c === "\t" || c === "\r") {
			endWord();
			i++;
			continue;
		}
		if (c === "#" && !inWord) {
			while (i < script.length && script[i] !== "\n") i++;
			continue;
		}
		if (c === "\\") {
			if (next !== "\n" && next !== undefined) {
				word += next;
				inWord = true;
				isQuoted = true;
			}
			i += 2;
			continue;
		}
		if (c === "'") {
			const end = script.indexOf("'", i + 1);
			const stop = end === -1 ? script.length : end;
			word += script.slice(i + 1, stop);
			inWord = true;
			isQuoted = true;
			i = stop + 1;
			continue;
		}
		if (c === "$" && next === "'") {
			let j = i + 2;
			while (j < script.length && script[j] !== "'") {
				if (script[j] === "\\" && j + 1 < script.length) {
					word += ansiEscape(script[j + 1] ?? "");
					j += 2;
				} else {
					word += script[j];
					j++;
				}
			}
			inWord = true;
			isQuoted = true;
			i = j + 1;
			continue;
		}
		if (c === '"') {
			i = readDoubleQuoted(i + 1);
			continue;
		}
		if (c === "`") {
			const end = findBacktick(script, i + 1);
			substitute(script.slice(i + 1, end).replace(/\\([`\\$])/g, "$1"));
			i = end + 1;
			continue;
		}
		if (c === "$" && (next === "(" || next === "{")) {
			const end = findClosing(script, i + 1);
			if (next === "{") word += script.slice(i, end + 1);
			else if (script[i + 2] !== "(") substitute(script.slice(i + 2, end));
			inWord = true;
			i = end + 1;
			continue;
		}
		if ((c === "<" || c === ">") && next === "(") {
			const end = findClosing(script, i + 1);
			substitute(script.slice(i + 2, end));
			i = end + 1;
			continue;
		}
		if (c === "<" || c === ">" || (c === "&" && next === ">")) {
			// A run of digits written straight before the operator is its file descriptor.
			if (inWord && !isQuoted && /^\d+$/.test(word)) {
				word = "";
				inWord = false;
			} else {
				endWord();
			}
			const operator = REDIRECT_OPERATORS.find((op) => script.startsWith(op, i)) ?? c;
			if (operator.startsWith("<")) current.hasStdinRedirect = true;
			redirectOperator = operator;
			i += operator.length;
			continue;
		}
		if (c === ";" || c === "&" || c === "|" || c === "(" || c === ")") {
			const isPipe = c === "|" && next !== "|";
			const previous = current;
			endCommand();
			if (isPipe && commands[commands.length - 1] === previous) current.pipedFrom = previous;
			i += next === c || (c === "|" && next === "&") ? 2 : 1;
			continue;
		}

		word += c;
		inWord = true;
		i++;
	}
	endCommand();
	if (pending.length > 0) readHeredocs(script, script.length, pending);

	return { commands, nested };
}
