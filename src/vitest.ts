import { randomUUID } from "node:crypto";
import {
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, inject } from "vitest";
import type { TestProject } from "vitest/node";
import {
	type Edge,
	findCycles,
	type Lock,
	LockCycleError,
	takeEdges,
} from "./graph.ts";
import { describeUnnamed, takeUnnamed } from "./unnamed.ts";
import { type WatchOptions, watchLocks } from "./watch.ts";

// A Vitest run as one lock-order check. Test files run in their own
// workers, so each leaves what it recorded in a folder the run's global
// setup opened, and its teardown looks for cycles among them all.

/** What one test file recorded. */
type Recorded = { edges: Edge[]; unnamed: Lock[] };

declare module "vitest" {
	interface ProvidedContext {
		pgLockdepEdges: string;
	}
}

/** In a setup file: watches the test file's transactions for the run's check. */
export async function recordLocks(options: WatchOptions): Promise<void> {
	const folder = inject("pgLockdepEdges");
	if (!folder)
		throw new Error(
			'pg-lockdep: recordLocks has no run to report to. Add "pg-lockdep/vitest" to this test project\'s globalSetup.',
		);
	await watchLocks(options);
	afterAll(() => {
		const recorded: Recorded = { edges: takeEdges(), unnamed: takeUnnamed() };
		writeFileSync(
			join(folder, `${randomUUID()}.json`),
			JSON.stringify(recorded),
		);
	});
}

let folder = "";

/** Vitest's global setup: opens the run's check. */
export function setup(project: TestProject): void {
	folder = mkdtempSync(join(tmpdir(), "pg-lockdep-"));
	project.provide("pgLockdepEdges", folder);
}

/**
 * Vitest's global teardown: warns of the row locks whose rows it couldn't
 * name, and fails the run on a cycle among the edges of all its test files.
 */
export function teardown(): void {
	const files = readdirSync(folder);
	const records: Recorded[] = files.map((file) =>
		JSON.parse(readFileSync(join(folder, file), "utf8")),
	);
	rmSync(folder, { recursive: true, force: true });
	if (files.length === 0)
		throw new Error(
			"pg-lockdep: no test file recorded its locks. Call recordLocks in a setup file of this test project.",
		);
	const unnamed = records.flatMap((record) => record.unnamed);
	if (unnamed.length > 0) console.warn(describeUnnamed(unnamed));
	const cycles = findCycles(records.flatMap((record) => record.edges));
	if (cycles.length > 0) throw new LockCycleError(cycles);
}
