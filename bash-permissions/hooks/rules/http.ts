/** The HTTP method an API command sets with `-X POST`, `-XPOST`, `--method POST` or `--method=POST`, upper-cased. */
export function methodOf(words: string[]): string | undefined {
	for (let i = 0; i < words.length; i++) {
		const word = words[i] ?? "";
		if (word === "-X" || word === "--method") return words[i + 1]?.toUpperCase();
		if (word.startsWith("--method=")) return word.slice("--method=".length).toUpperCase();
		if (/^-X[A-Za-z]+$/.test(word)) return word.slice(2).toUpperCase();
	}
	return undefined;
}

export function isReadMethod(method: string): boolean {
	return method === "GET" || method === "HEAD" || method === "OPTIONS";
}
