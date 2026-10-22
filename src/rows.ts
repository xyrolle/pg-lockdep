import pg from "pg";

// Which rows a statement locked, by their primary keys: from its answer
// when it returns them, else from a `where` that names them by parameter.

/** Each table's single-column primary key, by the table's oid, which an answer's fields carry. */
export type Tables = ReadonlyMap<
	number,
	{ name: string; key: string; position: number }
>;

export async function readTables(connectionString: string): Promise<Tables> {
	const client = new pg.Client({ connectionString });
	await client.connect();
	try {
		const { rows } = await client.query<{
			oid: number;
			name: string;
			key: string;
			position: number;
		}>(
			`select c.oid, c.relname as name, a.attname as key, a.attnum as position
			from pg_index i
			join pg_class c on c.oid = i.indrelid
			join pg_attribute a on a.attrelid = c.oid and a.attnum = i.indkey[0]
			where i.indisprimary and i.indnkeyatts = 1`,
		);
		return new Map(rows.map(({ oid, ...table }) => [oid, table]));
	} finally {
		await client.end();
	}
}

/** The keys of `table`'s rows in a statement's answer, when it returns them. */
export function keysInAnswer(
	answer: pg.QueryResult,
	table: string,
	tables: Tables,
): string[] | undefined {
	const at = answer.fields.findIndex((field) => {
		const owner = tables.get(field.tableID);
		return owner?.name === table && owner.position === field.columnID;
	});
	const field = answer.fields[at];
	if (!field) return undefined;
	return answer.rows.map((row) =>
		String(Array.isArray(row) ? row[at] : row[field.name]),
	);
}

// A join, a subquery or an `or` can reach rows the key's condition doesn't name.
const OTHER_ROWS = /\bor\b|\bjoin\b|\(\s*select\b/i;
const WORD = /^\w+$/;
const EQUALS = String.raw`=\s*\$(\d+)`;
const IN_LIST = String.raw`in\s*\(((?:\s*\$\d+\s*,?)+)\)`;
const EQUALS_ANY = String.raw`=\s*any\s*\(\s*\$(\d+)`;

/** The keys a statement's `where` names `table`'s rows by: `key = $1`, `key in ($1, $2)` or `key = any($1)`. */
export function keysInWhere(
	text: string,
	table: string,
	tables: Tables,
	values: readonly unknown[],
): string[] | undefined {
	const key = [...tables.values()].find((owner) => owner.name === table)?.key;
	const where = text.search(/\bwhere\b/i);
	if (!key || !WORD.test(table) || !WORD.test(key) || where < 0)
		return undefined;
	if (OTHER_ROWS.test(text)) return undefined;
	const column = String.raw`(?<![\w".])(?:"?${table}"?\.)?"?${key}"?\s*`;
	const condition = text
		.slice(where)
		.match(new RegExp(`${column}(?:${EQUALS}|${IN_LIST}|${EQUALS_ANY})`, "i"));
	if (!condition) return undefined;
	const positions = [
		...(condition[1] ?? condition[2] ?? condition[3] ?? "").matchAll(/\d+/g),
	];
	return positions.flatMap(([position]) => {
		const value = values[Number(position) - 1];
		return (Array.isArray(value) ? value : [value]).map(String);
	});
}
