import type { Lock } from "./graph.ts";

// The row locks whose rows a statement didn't name, by its answer's primary
// keys or by its `where`. Such a lock is taken to be on rows its transaction
// already holds in that table, or else to cover every later lock of them in
// the transaction: either way a cycle through a row it can't see may be
// missed, so the run lists the statement for its keys to be named.

const unnamed = new Map<string, Lock>();

export function recordUnnamed(lock: Lock): void {
	unnamed.set(JSON.stringify([lock.name, lock.mode, lock.site]), lock);
}

/** The row locks this process recorded since the last call whose statements named none of their rows, each once; the list starts over. */
export function takeUnnamed(): Lock[] {
	const taken = [...unnamed.values()];
	unnamed.clear();
	return taken;
}
