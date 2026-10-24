import { fileURLToPath } from "node:url";
import pg from "pg";
import { isTableMode } from "./modes.ts";
import { keysInAnswer, keysInWhere, readTables, type Tables } from "./rows.ts";
import { insertsInto, type Request, requestsOf } from "./statement.ts";
import {
	type Control,
	controlOf,
	type Rows,
	Transaction,
} from "./transaction.ts";

// The hook on `pg`: every statement a client sends through its promise API,
// followed into the transaction it runs in.

export type WatchOptions = {
	/** The database under test: its catalog names each table's primary key. */
	connectionString: string;
	/** Transactions whose BEGIN call site this matches aren't watched, such as a test's own that stands in for another session. */
	ignore?: RegExp;
};

const transactions = new WeakMap<pg.Client, Transaction>();
let tables: Tables = new Map();
let ignore: RegExp | undefined;
let installed = false;

/**
 * Watches the transactions of every `pg` client in this process, pools'
 * included. Call it once before the tests run; calling it again rereads the
 * tables and replaces the options.
 */
export async function watchLocks(options: WatchOptions): Promise<void> {
	tables = await readTables(options.connectionString);
	ignore = options.ignore;
	if (installed) return;
	installed = true;
	const query = pg.Client.prototype.query;
	Object.defineProperty(pg.Client.prototype, "query", {
		value: function watchedQuery(this: pg.Client, ...args: unknown[]) {
			const [config, parameters] = args;
			const text = typeof config === "string" ? config : textOf(config);
			const control = text === undefined ? undefined : controlOf(text);
			const opened = control ? follow(this, control) : undefined;
			const transaction = transactions.get(this);
			const answer = Reflect.apply(query, this, args);
			if (!(answer instanceof Promise) || !transaction || text === undefined)
				return answer;
			if (opened)
				return answer.then((result) => {
					const site = siteOf(capture());
					opened.watched = ignore === undefined || site.search(ignore) === -1;
					return result;
				});
			if (control) return answer;
			const values = valuesOf(config, parameters);
			return answer.then((result: pg.QueryResult | pg.QueryResult[]) => {
				if (transaction.watched && !Array.isArray(result))
					answered(transaction, text, values, result);
				return result;
			});
		},
	});
}

/** Follows a statement that begins or ends a transaction or a savepoint, and returns the transaction a BEGIN opens. */
function follow(client: pg.Client, control: Control): Transaction | undefined {
	const transaction = transactions.get(client);
	if (control.step === "end") transactions.delete(client);
	else if (control.step !== "begin") transaction?.follow(control);
	else if (!transaction) {
		const opened = new Transaction();
		transactions.set(client, opened);
		return opened;
	}
	return undefined;
}

function answered(
	transaction: Transaction,
	text: string,
	values: readonly unknown[],
	answer: pg.QueryResult,
) {
	// An advisory call runs once per row the statement answers, so with no
	// row it took nothing, and a `pg_try_…` call that answers false neither.
	const refused = answer.rows.some((row) => Object.values(row).includes(false));
	const called = answer.rowCount !== 0;
	const taken = requestsOf(text, values).flatMap((request) =>
		request.keys && (!called || (!request.waits && refused))
			? []
			: [{ ...request, rows: rowsOf(request, text, values, answer) }],
	);
	transaction.take(taken, siteOf(capture()));
	if (answer.rowCount === 0) return;
	for (const table of insertsInto(text))
		transaction.inserted(
			table,
			[...values, ...(keysInAnswer(answer, table, tables) ?? [])].map(String),
		);
}

function rowsOf(
	request: Request,
	text: string,
	values: readonly unknown[],
	answer: pg.QueryResult,
): Rows {
	if (isTableMode(request.mode)) return "table";
	// An answer with no row names none of the rows locked: a statement that
	// waited for a row a concurrent writer changed, and found it no longer
	// matching, answers nothing but keeps that row's lock (EvalPlanQual).
	const answered =
		answer.rowCount === 0
			? undefined
			: keysInAnswer(answer, request.name, tables);
	const keys =
		request.keys ?? answered ?? keysInWhere(text, request.name, tables, values);
	return keys ? new Set(keys) : "unknown";
}

const ROOT = `${process.cwd()}/`;
const SOURCE = fileURLToPath(new URL(".", import.meta.url));
const FRAME =
	/at (?:async )?(?:(.*?) \()?(?:file:\/\/)?(\/[^():]+):(\d+):\d+\)?$/;

/**
 * Captured once a statement is answered, not as it is sent: by then the
 * stack runs back through the awaits to the code that sent it, where a
 * query builder's thenable would show only its own frames.
 */
function capture(): Error {
	const limit = Error.stackTraceLimit;
	Error.stackTraceLimit = 50;
	const error = new Error("lock");
	Error.stackTraceLimit = limit;
	return error;
}

/** A call site: its innermost four frames outside `node_modules` and this package. */
function siteOf(error: Error): string {
	const frames = (error.stack ?? "").split("\n").flatMap((line) => {
		const [, method, file = "", row] = line.match(FRAME) ?? [];
		const outside =
			file.startsWith(ROOT) &&
			!file.includes("/node_modules/") &&
			!file.startsWith(SOURCE);
		return outside
			? [`${file.slice(ROOT.length)}:${row}${method ? ` ${method}` : ""}`]
			: [];
	});
	return frames.slice(0, 4).join(" < ") || "(no frame outside node_modules)";
}

const textOf = (config: unknown) =>
	typeof config === "object" &&
	config !== null &&
	"text" in config &&
	typeof config.text === "string"
		? config.text
		: undefined;

function valuesOf(config: unknown, parameters: unknown): readonly unknown[] {
	if (Array.isArray(parameters)) return parameters;
	return typeof config === "object" &&
		config !== null &&
		"values" in config &&
		Array.isArray(config.values)
		? config.values
		: [];
}
