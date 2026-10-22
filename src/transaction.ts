import { type Guard, type Lock, recordEdge } from "./graph.ts";
import { covers, type Mode } from "./modes.ts";

// One transaction on one connection, from its BEGIN to its end: the locks
// it holds, and an edge from each of them to every lock it then asks for on
// rows or keys it doesn't hold yet.

/** A statement that begins or ends a transaction or a savepoint. */
export type Control =
	| { step: "begin" }
	| { step: "end" }
	| { step: "savepoint" | "release" | "rollback to"; name: string };

const BEGIN = /^\s*(?:begin|start\s+transaction)\b/i;
const END =
	/^\s*(?:commit|end|abort|rollback)\b(?!\s+(?:work\s+|transaction\s+)?to\b)/i;
const SAVEPOINTS = [
	["savepoint", /^\s*savepoint\s+"?([\w$]+)/i],
	["release", /^\s*release\s+(?:savepoint\s+)?"?([\w$]+)/i],
	[
		"rollback to",
		/^\s*rollback\s+(?:work\s+|transaction\s+)?to\s+(?:savepoint\s+)?"?([\w$]+)/i,
	],
] as const;

export function controlOf(text: string): Control | undefined {
	if (BEGIN.test(text)) return { step: "begin" };
	if (END.test(text)) return { step: "end" };
	for (const [step, pattern] of SAVEPOINTS) {
		const name = text.match(pattern)?.[1];
		if (name) return { step, name };
	}
	return undefined;
}

/** The rows a lock covers: these keys, the whole table, or rows its statement didn't name. */
export type Rows = ReadonlySet<string> | "table" | "unknown";

/** What a statement took: a lock, its rows, and whether asking for it could wait. */
export type Taken = { name: string; mode: Mode; rows: Rows; waits: boolean };

type Held = Lock & { rows: Rows };

export class Transaction {
	/** Whether its locks are recorded: not until its BEGIN's call site is known not to be ignored. */
	watched = false;
	readonly #held: Held[] = [];
	/** The keys of the rows it inserted, by table: rows nobody else can hold. */
	readonly #own = new Map<string, Set<string>>();
	readonly #savepoints: { name: string; held: number }[] = [];

	/** A release keeps the locks taken since the savepoint; a rollback to it lets go of them. */
	follow({ step, name }: Extract<Control, { name: string }>): void {
		if (step === "savepoint") {
			this.#savepoints.push({ name, held: this.#held.length });
			return;
		}
		const at = this.#savepoints.findLastIndex((point) => point.name === name);
		const point = this.#savepoints[at];
		if (!point) return;
		if (step === "rollback to") this.#held.splice(point.held);
		this.#savepoints.splice(step === "release" ? at : at + 1);
	}

	inserted(table: string, keys: readonly string[]): void {
		this.#own.set(table, new Set([...(this.#own.get(table) ?? []), ...keys]));
	}

	/**
	 * Holds what one statement took beyond what the transaction held, with an
	 * edge to each new lock that could wait from every lock held before the
	 * statement. The locks of one statement get no edges between them: their
	 * order is the plan's, not the text's.
	 */
	take(locks: readonly Taken[], site: string): void {
		const before = [...this.#held];
		const guards = before.flatMap(guardOf);
		for (const lock of locks) {
			const rows = this.#uncovered(lock);
			if (!rows) continue;
			const took = { name: lock.name, mode: lock.mode, site };
			if (lock.waits)
				for (const { name, mode, site } of before)
					if (name !== lock.name)
						recordEdge({ held: { name, mode, site }, took, guards });
			this.#held.push({ ...took, rows });
		}
	}

	/** The rows of a lock the transaction doesn't hold yet in a mode that covers it, if any. */
	#uncovered({ name, mode, rows }: Taken): Rows | undefined {
		const same = this.#held.filter((held) => held.name === name);
		const covering = same.filter((held) => covers(held.mode, mode));
		const own = this.#own.get(name);
		if (covering.some((held) => held.rows === "table")) return undefined;
		if (rows === "table") return rows;
		// Rows it can't name may be ones it holds or inserted: counting them as new could invent a wait.
		if (rows === "unknown") return same.length > 0 || own ? undefined : rows;
		const left = [...rows].filter(
			(key) =>
				!own?.has(key) &&
				!covering.some(
					(held) => typeof held.rows === "string" || held.rows.has(key),
				),
		);
		return left.length > 0 ? new Set(left) : undefined;
	}
}

function guardOf({ name, mode, rows }: Held): Guard[] {
	if (rows === "unknown") return [];
	return [rows === "table" ? { name, mode } : { name, mode, keys: [...rows] }];
}
