import { conflicts, type Mode } from "./modes.ts";

// The "held X, then took Y" graph of every watched transaction, and its
// cycles: two paths that take two locks in opposite orders, each in a mode
// that waits for the other's, deadlock once their steps interleave.

/** A lock, its mode, and where it was taken: the innermost frames outside `node_modules`. */
export type Lock = { name: string; mode: Mode; site: string };

/** A lock a transaction held on these rows or keys; `keys` is absent for a whole table. */
export type Guard = { name: string; mode: Mode; keys?: readonly string[] };

/**
 * A transaction held `held` when it asked for `took` on rows or keys it
 * didn't hold yet, and could wait for them. `guards`: what it held at that
 * moment, on the same rows or keys every time this path ran.
 */
export type Edge = { held: Lock; took: Lock; guards: readonly Guard[] };

/** Two paths, each holding the lock the other then asks for. */
export type Cycle = readonly [Edge, Edge];

const edges = new Map<string, Edge>();

export function recordEdge(edge: Edge): void {
	const key = JSON.stringify([edge.held, edge.took]);
	const known = edges.get(key);
	edges.set(
		key,
		known
			? { ...known, guards: commonGuards(known.guards, edge.guards) }
			: edge,
	);
}

/** The edges this process has recorded since the last call, which start over. */
export function takeEdges(): Edge[] {
	const taken = [...edges.values()];
	edges.clear();
	return taken;
}

/** The guards two runs of a path both held: the same lock in the same mode, on rows or keys both held. */
function commonGuards(some: readonly Guard[], others: readonly Guard[]) {
	return some.flatMap((guard) => {
		const same = others.filter(
			(other) => other.name === guard.name && other.mode === guard.mode,
		);
		if (!guard.keys) return same.length > 0 ? [guard] : [];
		const keys = guard.keys.filter((key) =>
			same.some((other) => other.keys?.includes(key)),
		);
		return keys.length > 0 ? [{ ...guard, keys }] : [];
	});
}

const overlap = (one: Guard, other: Guard) =>
	!one.keys || !other.keys || one.keys.some((key) => other.keys?.includes(key));

/** Whether both paths held one lock first, on the same rows or key, in modes that can't be held at once. */
const guarded = (one: Edge, other: Edge) =>
	one.guards.some((mine) =>
		other.guards.some(
			(theirs) =>
				mine.name === theirs.name &&
				conflicts(mine.mode, theirs.mode) &&
				overlap(mine, theirs),
		),
	);

const deadlocks = (one: Edge, other: Edge) =>
	conflicts(one.held.mode, other.took.mode) &&
	conflicts(other.held.mode, one.took.mode) &&
	!guarded(one, other);

/** The pairs of locks some two paths take in opposite orders and can deadlock on, one cycle per pair. */
export function findCycles(edges: readonly Edge[]): Cycle[] {
	const byLocks = Map.groupBy(edges, ({ held, took }) =>
		JSON.stringify([held.name, took.name]),
	);
	const cycles = new Map<string, Cycle>();
	for (const one of edges)
		for (const other of byLocks.get(
			JSON.stringify([one.took.name, one.held.name]),
		) ?? []) {
			const pair = JSON.stringify([one.held.name, one.took.name].sort());
			if (!cycles.has(pair) && deadlocks(one, other))
				cycles.set(pair, [one, other]);
		}
	return [...cycles.values()];
}

const side = ({ name, mode, site }: Lock) => `${name} (${mode}) at ${site}`;

const describeCycle = ([one, other]: Cycle) =>
	[
		`${one.held.name} and ${one.took.name} are taken in opposite orders:`,
		`  one path held ${side(one.held)}`,
		`      then took ${side(one.took)}`,
		`  another held ${side(other.held)}`,
		`      then took ${side(other.took)}`,
	].join("\n");

/** Thrown at the end of a run whose paths can deadlock: each cycle, named by both paths' call sites. */
export class LockCycleError extends Error {
	readonly cycles: readonly Cycle[];

	constructor(cycles: readonly Cycle[]) {
		super(
			[
				`pg-lockdep found ${cycles.length} lock-order cycle(s) that can deadlock.`,
				...cycles.map(describeCycle),
				"Take both locks in the same order on every path, or have both paths first take one lock that makes the other wait.",
			].join("\n\n"),
		);
		this.name = "LockCycleError";
		this.cycles = cycles;
	}
}
