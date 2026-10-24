import type { DangerRule } from "./types";

const MYSQL_CLIENT_COMMANDS = ["mysql", "mariadb", "mysqlsh"] as const;
const MYSQL_CLASSIC_CLIENT_COMMANDS = ["mysql", "mariadb"] as const;
const MYSQL_DUMP_COMMANDS = ["mysqldump", "mysqlpump"] as const;
const MYSQL_EXECUTE_FLAGS = ["--execute", "--init-command", "--init-command-add"] as const;

function isCommand(words: string[], commands: readonly string[]): boolean {
	return commands.includes((words[0] ?? "") as (typeof commands)[number]);
}

function isMysqlClient(words: string[]): boolean {
	return isCommand(words, MYSQL_CLIENT_COMMANDS);
}

function isMysqlClassicClient(words: string[]): boolean {
	return isCommand(words, MYSQL_CLASSIC_CLIENT_COMMANDS);
}

function hasLongFlag(words: string[], flag: string): boolean {
	return words.some((w) => w === flag || w.startsWith(`${flag}=`));
}

function hasShortExecuteFlag(words: string[]): boolean {
	return words.some((w) => w === "-e" || (w.startsWith("-e") && w.length > 2));
}

function hasMysqlExecuteFlag(words: string[]): boolean {
	if (!isMysqlClassicClient(words)) return false;
	if (hasShortExecuteFlag(words)) return true;
	return MYSQL_EXECUTE_FLAGS.some((flag) => hasLongFlag(words, flag));
}

function hasStdinMarker(words: string[]): boolean {
	return isMysqlClassicClient(words) && words.some((w) => w === "<" || w.startsWith("<<") || w.startsWith("<<<"));
}

export const mysqlRules: DangerRule[] = [
	{
		id: "mysqladmin-shutdown",
		description: "MySQL admin shutdown (mysqladmin shutdown)",
		severity: 91,
		match: ({ effective: words }) => words[0] === "mysqladmin" && words.includes("shutdown"),
	},
	{
		id: "mysqladmin-drop",
		description: "MySQL admin drop database (mysqladmin drop)",
		severity: 90,
		match: ({ effective: words }) => words[0] === "mysqladmin" && words.includes("drop"),
	},
	{
		id: "mysql-dump",
		description: "MySQL dump/export (mysqldump / mysqlpump)",
		severity: 84,
		match: ({ effective: words }) => isCommand(words, MYSQL_DUMP_COMMANDS),
	},
	{
		id: "mysqlimport",
		description: "MySQL import (mysqlimport)",
		severity: 82,
		match: ({ effective: words }) => words[0] === "mysqlimport",
	},
	{
		id: "mysql-execute",
		description: "MySQL client execute SQL (mysql / mariadb with -e / --execute / --init-command)",
		severity: 80,
		match: ({ effective: words }) => hasMysqlExecuteFlag(words),
	},
	{
		id: "mysql-script-input",
		description: "MySQL client script input (mysql / mariadb with stdin redirection)",
		severity: 79,
		match: ({ effective: words }) => hasStdinMarker(words),
	},
	{
		id: "mysql-shell",
		description: "MySQL client shell/access (mysql / mariadb / mysqlsh)",
		severity: 70,
		match: ({ effective: words }) => isMysqlClient(words),
	},
];
