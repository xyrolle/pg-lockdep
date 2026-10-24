import { conflicts, type Mode } from "./modes.ts";

// The "held X, then took Y" graph of every watched transaction, and its
// cycles: paths that each hold the lock the next one then asks for, in a
// mode that makes it wait, deadlock once their steps interleave. Two paths
// that take two locks in opposite orders are the common case; three that
// each take two of three locks are a ring.

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

/** Two or three paths, each asking for the lock the next one holds. */
export type Cycle = readonly Edge[];

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

/**
 * Whether a ring of paths can deadlock: each one's request waits for the
 * lock the next one holds, and no two of them held a guard they can't hold
 * at once, which would keep them from running together.
 */
function deadlocks(ring: Cycle): boolean {
	const waits = ring.every((edge, at) => {
		const next = ring[(at + 1) % ring.length];
		return next !== undefined && conflicts(next.held.mode, edge.took.mode);
	});
	return (
		waits &&
		!ring.some((one, at) =>
			ring.slice(at + 1).some((other) => guarded(one, other)),
		)
	);
}

/** The rings of two or three locks some paths take in turn and can deadlock on, one cycle per set of locks. */
export function findCycles(edges: readonly Edge[]): Cycle[] {
	const between = Map.groupBy(edges, ({ held, took }) =>
		JSON.stringify([held.name, took.name]),
	);
	const from = Map.groupBy(edges, ({ held }) => held.name);
	const back = (edge: Edge, to: string) =>
		between.get(JSON.stringify([edge.took.name, to])) ?? [];
	const cycles = new Map<string, Cycle>();
	const consider = (ring: Cycle) => {
		const locks = JSON.stringify(ring.map(({ held }) => held.name).sort());
		if (!cycles.has(locks) && deadlocks(ring)) cycles.set(locks, ring);
	};
	for (const one of edges) {
		for (const other of back(one, one.held.name)) consider([one, other]);
		for (const next of from.get(one.took.name) ?? [])
			if (next.took.name !== one.held.name)
				for (const last of back(next, one.held.name))
					consider([one, next, last]);
	}
	return [...cycles.values()];
}

const side = ({ name, mode, site }: Lock) => `${name} (${mode}) at ${site}`;

function describeCycle(cycle: Cycle): string {
	const names = cycle.map(({ held }) => held.name);
	const last = names.pop();
	const taken =
		cycle.length === 2
			? "are taken in opposite orders:"
			: "are taken in a ring, each path asking for the lock the next one holds:";
	return [
		`${names.join(", ")} and ${last} ${taken}`,
		...cycle.flatMap(({ held, took }, at) => [
			`  ${at === 0 ? "one path" : "another"} held ${side(held)}`,
			`      then took ${side(took)}`,
		]),
	].join("\n");
}

/** Thrown at the end of a run whose paths can deadlock: each cycle, named by its paths' call sites. */
export class LockCycleError extends Error {
	readonly cycles: readonly Cycle[];

	constructor(cycles: readonly Cycle[]) {
		super(
			[
				`pg-lockdep found ${cycles.length} lock-order cycle(s) that can deadlock.`,
				...cycles.map(describeCycle),
				"Take the locks in the same order on every path, or have the paths first take one lock that makes the others wait.",
			].join("\n\n"),
		);
		this.name = "LockCycleError";
		this.cycles = cycles;
	}
}
