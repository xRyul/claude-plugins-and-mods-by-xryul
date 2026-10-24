/**
 * Reads a `find` expression to tell whether `-delete` can run on a file that no
 * narrowing filter matched. Operators bind as find binds them: `!` first, then
 * AND (written or not), then `-o`, then `,`.
 */

/** Tests that narrow what gets deleted. `-type f` alone still matches every file, so it is not one. */
const FILTERS = new Set([
	"-name", "-iname", "-path", "-ipath", "-wholename", "-iwholename", "-regex", "-iregex", "-lname", "-ilname",
	"-newer", "-mtime", "-mmin", "-atime", "-amin", "-ctime", "-cmin", "-size", "-empty", "-user", "-group",
	"-perm", "-inum", "-samefile", "-links",
]);
/** Tests and options that take one value. */
const ONE_VALUE = new Set([
	...FILTERS, "-type", "-xtype", "-maxdepth", "-mindepth", "-uid", "-gid", "-regextype", "-fstype", "-context",
	"-used", "-anewer", "-cnewer", "-printf", "-fprint", "-fprint0", "-fls", "-files0-from",
]);
const RUNS_COMMAND = new Set(["-exec", "-execdir", "-ok", "-okdir"]);

/**
 * What one part of the expression can do to a file that arrives with no
 * narrowing filter matched yet: delete it, and come out true or false with
 * still no filter matched.
 */
type Outcome = { deletes: boolean; trueUnfiltered: boolean; falseUnfiltered: boolean };
type Node = (arrivesUnfiltered: boolean) => Outcome;

function primary(token: string, values: string[]): Node {
	if (token === "-delete") return (u) => ({ deletes: u, trueUnfiltered: u, falseUnfiltered: u });
	if (token === "-false") return (u) => ({ deletes: false, trueUnfiltered: false, falseUnfiltered: u });
	// A filter that passes has matched; `-name '*'` matches everything, so it narrows nothing.
	if (FILTERS.has(token) && values[0] !== "*") return (u) => ({ deletes: false, trueUnfiltered: false, falseUnfiltered: u });
	return (u) => ({ deletes: false, trueUnfiltered: u, falseUnfiltered: u });
}

function not(node: Node): Node {
	return (u) => {
		const x = node(u);
		return { deletes: x.deletes, trueUnfiltered: x.falseUnfiltered, falseUnfiltered: x.trueUnfiltered };
	};
}

/** The right side runs only when the left is true. */
function and(left: Node, right: Node): Node {
	return (u) => {
		const x = left(u);
		const y = right(x.trueUnfiltered);
		return { deletes: x.deletes || y.deletes, trueUnfiltered: y.trueUnfiltered, falseUnfiltered: x.falseUnfiltered || y.falseUnfiltered };
	};
}

/** The right side runs only when the left is false. */
function or(left: Node, right: Node): Node {
	return (u) => {
		const x = left(u);
		const y = right(x.falseUnfiltered);
		return { deletes: x.deletes || y.deletes, trueUnfiltered: x.trueUnfiltered || y.trueUnfiltered, falseUnfiltered: y.falseUnfiltered };
	};
}

/** `,` runs both sides on every file. */
function both(left: Node, right: Node): Node {
	return (u) => {
		const x = left(u);
		const y = right(u);
		return { deletes: x.deletes || y.deletes, trueUnfiltered: y.trueUnfiltered, falseUnfiltered: y.falseUnfiltered };
	};
}

function parse(tokens: string[]): Node {
	let i = 0;
	const peek = () => tokens[i];

	function values(token: string): string[] {
		if (RUNS_COMMAND.has(token)) {
			const end = tokens.findIndex((word, index) => index >= i && (word === ";" || word === "+"));
			const stop = end === -1 ? tokens.length : end + 1;
			const taken = tokens.slice(i, stop);
			i = stop;
			return taken;
		}
		const count = token === "-fprintf" ? 2 : ONE_VALUE.has(token) || /^-newer[aBcmt][aBcmt]$/.test(token) ? 1 : 0;
		const taken = tokens.slice(i, i + count);
		i += count;
		return taken;
	}

	function unary(): Node {
		const token = tokens[i++] ?? "";
		if (token === "!" || token === "-not") return not(unary());
		if (token === "(") {
			const node = list();
			if (peek() === ")") i++;
			return node;
		}
		return primary(token, values(token));
	}

	function conjunction(): Node {
		let node = unary();
		while (i < tokens.length && ![")", ",", "-o", "-or"].includes(peek() ?? "")) {
			if (peek() === "-a" || peek() === "-and") i++;
			node = and(node, unary());
		}
		return node;
	}

	function disjunction(): Node {
		let node = conjunction();
		while (peek() === "-o" || peek() === "-or") {
			i++;
			node = or(node, conjunction());
		}
		return node;
	}

	function list(): Node {
		let node = disjunction();
		while (peek() === ",") {
			i++;
			node = both(node, disjunction());
		}
		return node;
	}

	return tokens.length > 0 ? list() : primary("", []);
}

/**
 * True when `-delete` can run on a file no narrowing filter matched:
 * `-delete`, `-type f -delete`, `! -name keep -delete`, `-name a -o -delete`,
 * `-name a , -delete`. `-name a -delete` and `\( -name a -o -name b \) -delete` are narrowed.
 */
export function deletesUnfiltered(expression: string[]): boolean {
	return parse(expression)(true).deletes;
}
