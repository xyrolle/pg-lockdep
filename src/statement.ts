import { type Mode, ROW_MODES, TABLE_MODES } from "./modes.ts";

// The locks a statement asks for, read from its SQL text. A lock is named by
// the table whose rows it takes, or by an advisory key's purpose (`order:`
// for `order:42`), so that two paths over different rows of one table still
// meet in the graph.

/** A lock a statement asks for, before its answer names the rows it took. */
export type Request = {
	/** The table, or `advisory <purpose>`. */
	name: string;
	mode: Mode;
	/** False for `NOWAIT`, `SKIP LOCKED` and `pg_try_…`: they wait for nobody. */
	waits: boolean;
	/** An advisory lock's keys; a row lock's rows come from the answer. */
	keys?: string[];
};

/** Each lock a statement asks for. */
export function requestsOf(
	text: string,
	values: readonly unknown[],
): Request[] {
	const depths = depthsOf(text);
	return [
		...rowLocks(text, depths),
		...writes(text),
		...tableLocks(text),
		...advisoryLocks(text, depths, values),
	];
}

const INSERT_INTO = /\binsert\s+into\s+([\w".]+)/gi;
const UPSERT = /\bon\s+conflict\b[\s\S]*\bdo\s+update\b/i;

/** The tables a plain insert writes new rows to: rows no other transaction can hold. */
export const insertsInto = (text: string): string[] =>
	UPSERT.test(text) ? [] : [...text.matchAll(INSERT_INTO)].map(tableOf);

const INSERT_VALUES = /\binsert\s+into\s+([\w".]+)\s*\(([^)]*)\)\s*values\s*/i;

/**
 * A plain insert's rows, by column, with the values it gives them by
 * parameter: `insert into t (a, b) values ($1, $2), ($3, $4)`.
 */
export function insertedRows(
	text: string,
	values: readonly unknown[],
): { table: string; rows: Map<string, unknown>[] } | undefined {
	const head = text.match(INSERT_VALUES);
	if (!head || UPSERT.test(text)) return undefined;
	const columns = (head[2] ?? "").split(",").map(nameOf);
	const rows: Map<string, unknown>[] = [];
	let rest = text.slice((head.index ?? 0) + head[0].length);
	while (rest.startsWith("(")) {
		const depths = depthsOf(rest);
		const end = depths.findIndex(
			(depth, at) => rest[at] === ")" && depth === 1,
		);
		if (end < 0) break;
		const items = splitAtDepth(rest.slice(1, end), depths.slice(1, end), 1);
		rows.push(
			new Map(
				columns.flatMap((column, at) => {
					const position = items[at]?.trim().match(/^\$(\d+)$/)?.[1];
					return position ? [[column, values[Number(position) - 1]]] : [];
				}),
			),
		);
		rest = rest.slice(end + 1).replace(/^\s*,\s*/, "");
	}
	return { table: nameOf(head[1] ?? ""), rows };
}

/** A text split at the commas that sit at `depth`. */
function splitAtDepth(text: string, depths: readonly number[], depth: number) {
	const parts: string[] = [];
	let start = 0;
	for (const [at, char] of text.split("").entries())
		if (char === "," && depths[at] === depth) {
			parts.push(text.slice(start, at));
			start = at + 1;
		}
	return [...parts, text.slice(start)];
}

const LOCKING_CLAUSE =
	/\bfor\s+(update|no\s+key\s+update|share|key\s+share)\b((?:\s+of\s+[\w".]+(?:\s*,\s*[\w".]+)*)?)(\s+(?:nowait|skip\s+locked))?/gi;
const SELECT = /\bselect\b/gi;

/** `SELECT … FOR …`: the tables its `OF` names, or every table in its own `FROM`. */
function rowLocks(text: string, depths: readonly number[]): Request[] {
	return [...text.matchAll(LOCKING_CLAUSE)].flatMap((clause) => {
		const mode = ROW_MODES.find((row) => row === `FOR ${words(clause[1])}`);
		if (!mode) return [];
		const level = depths[clause.index];
		const select = [...text.slice(0, clause.index).matchAll(SELECT)].findLast(
			(match) => depths[match.index] === level,
		);
		const from = fromItems(text, select?.index ?? 0, clause.index, depths);
		const tables = clause[2]
			? clause[2]
					.replace(/^\s+of\s+/i, "")
					.split(",")
					.map((of) => from.get(nameOf(of)) ?? nameOf(of))
			: [...new Set(from.values())];
		return tables.map((name) => ({ name, mode, waits: !clause[3] }));
	});
}

const FROM_ITEM =
	/\b(?:from|join)\s+(?:only\s+)?([\w".]+)(?:\s+(?:as\s+)?(?!(?:where|join|inner|left|right|full|cross|natural|on|using|for|order|group|limit|offset|union|except|intersect|having|window|fetch|lateral)\b)([\w"]+))?/gi;

/** The tables a select reads at its own level, by the name or alias that refers to them. */
function fromItems(
	text: string,
	start: number,
	end: number,
	depths: readonly number[],
) {
	const items = [...text.slice(start, end).matchAll(FROM_ITEM)].filter(
		(item) => depths[start + item.index] === depths[end],
	);
	return new Map(
		items.map((item) => [
			item[2] ? nameOf(item[2]) : tableOf(item),
			tableOf(item),
		]),
	);
}

const UPDATE_TARGET =
	/\bupdate\s+(?:only\s+)?([\w".]+)(?:\s+(?:as\s+)?[\w"]+)?\s+set\b/gi;
const DELETE_TARGET = /\bdelete\s+from\s+(?:only\s+)?([\w".]+)/gi;

/** The rows an `UPDATE`, a `DELETE` or an upsert's `DO UPDATE` writes. */
function writes(text: string): Request[] {
	const targets = (pattern: RegExp, mode: Mode) =>
		[...text.matchAll(pattern)].map((target) => ({
			name: tableOf(target),
			mode,
			waits: true,
		}));
	return [
		...targets(UPDATE_TARGET, "UPDATE"),
		...targets(DELETE_TARGET, "DELETE"),
		...(UPSERT.test(text) ? targets(INSERT_INTO, "UPDATE") : []),
	];
}

const LOCK_TABLE =
	/^\s*lock\s+(?:table\s+)?(?:only\s+)?([\w".]+(?:\s*,\s*[\w".]+)*)(?:\s+in\s+([a-z\s]+?)\s+mode)?(\s+nowait)?\s*;?\s*$/i;

/** `LOCK TABLE`, in `ACCESS EXCLUSIVE` mode unless it names another. */
function tableLocks(text: string): Request[] {
	const lock = text.match(LOCK_TABLE);
	const mode = TABLE_MODES.find(
		(table) => table === words(lock?.[2] ?? "access exclusive"),
	);
	if (!lock || !mode) return [];
	return (lock[1] ?? "")
		.split(",")
		.map((table) => ({ name: nameOf(table), mode, waits: !lock[3] }));
}

const ADVISORY_CALL = /\bpg_(try_)?advisory_xact_lock(_shared)?\s*\(/gi;

/** `pg_advisory_xact_lock(…)` and its `_shared` and `try_` forms, one request per purpose. */
function advisoryLocks(
	text: string,
	depths: readonly number[],
	values: readonly unknown[],
): Request[] {
	return [...text.matchAll(ADVISORY_CALL)].flatMap((call) => {
		const start = call.index + call[0].length;
		const end = depths.findIndex(
			(depth, at) =>
				at >= start && text[at] === ")" && depth === depths[start - 1],
		);
		const keys = advisoryKeys(text.slice(start, end), text, values);
		const purposes = Map.groupBy(
			keys,
			(key) => key.match(/^[^:]*:/)?.[0] ?? key,
		);
		return [...purposes].map(([purpose, taken]) => ({
			name: `advisory ${purpose}`,
			mode: call[2] ? "advisory shared" : "advisory",
			waits: !call[1],
			keys: taken,
		}));
	});
}

const PARAMETER = /\$(\d+)/g;
const STRING_OR_PARAMETER = /'((?:[^']|'')*)'|\$(\d+)/g;
const NAMES_A_COLUMN = /^[^$']*[a-z_][^$']*$/i;

/**
 * The keys an advisory call takes, by the text it hashes or the number it
 * is: its string literals and parameters in order. A call whose argument
 * names a column, with neither a string nor a parameter, takes one key per
 * value of the statement's parameters, as
 * `pg_advisory_xact_lock(hashtext(key)) from unnest($1)` does to take
 * several keys in order.
 */
function advisoryKeys(
	argument: string,
	text: string,
	values: readonly unknown[],
): string[] {
	const valueAt = (position: string | undefined) =>
		values[Number(position) - 1];
	if (NAMES_A_COLUMN.test(argument))
		return [...text.matchAll(PARAMETER)].flatMap(([, position]) => {
			const value = valueAt(position);
			return (Array.isArray(value) ? value : [value]).map(String);
		});
	// The two-number form, `(1, 2)`, is one key; a hash function's commas are inside its parentheses.
	const parts = argument.includes("(") ? [argument] : argument.split(",");
	const key = parts.map((part) => {
		const pieces = [...part.matchAll(STRING_OR_PARAMETER)].map(
			([, string = "", position]) =>
				position ? String(valueAt(position)) : string.replaceAll("''", "'"),
		);
		return pieces.length > 0 ? pieces.join("") : part.trim();
	});
	return [key.join(",")];
}

/** The parenthesis depth at each character of a statement. */
function depthsOf(text: string): number[] {
	const depths: number[] = [];
	let depth = 0;
	for (const char of text.split("")) {
		if (char === "(") depth += 1;
		depths.push(depth);
		if (char === ")") depth -= 1;
	}
	return depths;
}

/** An identifier as PostgreSQL resolves it: unquoted folds to lower case; the schema is dropped. */
function nameOf(identifier: string): string {
	const last = identifier.trim().split(".").at(-1) ?? "";
	return last.startsWith('"') ? last.slice(1, -1) : last.toLowerCase();
}

const tableOf = (match: RegExpExecArray) => nameOf(match[1] ?? "");

const words = (text: string | undefined) =>
	(text ?? "").trim().replace(/\s+/g, " ").toUpperCase();
