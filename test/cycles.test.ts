import { describe, expect, it } from "vitest";
import { type Edge, findCycles, takeEdges } from "../src/index.ts";
import { inTransaction, pool, until } from "./db.ts";

const locks = (edges: readonly Edge[]) =>
	edges.map(({ held, took }) => `${held.name} > ${took.name}`).sort();

describe("two paths that take two tables in opposite orders", () => {
	it("form a cycle when their modes conflict, naming where each lock was taken", async () => {
		await inTransaction(async (client) => {
			await client.query("select id from account where id = 1 for update");
			await client.query("update invoice set total = total + 1 where id = 1");
		});
		await inTransaction(async (client) => {
			await client.query("select id from invoice where id = 1 for share");
			await client.query(
				"select id from account where id = 1 for no key update",
			);
		});

		const [cycle, ...more] = findCycles(takeEdges());
		expect(more).toEqual([]);
		expect(locks(cycle ?? [])).toEqual([
			"account > invoice",
			"invoice > account",
		]);
		const sites = cycle?.flatMap(({ held, took }) => [held.site, took.site]);
		expect(new Set(sites).size).toBe(4);
		for (const site of sites ?? [])
			expect(site).toMatch(/^test\/cycles\.test\.ts:\d+ /);
	});

	it("deadlock in Postgres when their steps interleave", async () => {
		const [one, other] = [await pool.connect(), await pool.connect()];
		try {
			const {
				rows: [{ pid }],
			} = await one.query("select pg_backend_pid() as pid");
			await one.query("begin");
			await other.query("begin");
			await one.query("select id from account where id = 1 for update");
			await other.query("select id from invoice where id = 1 for share");
			const first = one.query(
				"update invoice set total = total + 1 where id = 1",
			);
			await waitingForLock(pid);
			const second = other.query(
				"select id from account where id = 1 for no key update",
			);

			const outcomes = await Promise.allSettled([first, second]);
			expect(
				outcomes.flatMap((outcome) =>
					outcome.status === "rejected" ? [outcome.reason.code] : [],
				),
			).toEqual(["40P01"]);
		} finally {
			for (const client of [one, other]) {
				await client.query("rollback");
				client.release();
			}
		}
	});

	it("form no cycle when both only share the rows", async () => {
		await inTransaction(async (client) => {
			await client.query("select id from account where id = 1 for share");
			await client.query("select id from invoice where id = 1 for key share");
		});
		await inTransaction(async (client) => {
			await client.query("select id from invoice where id = 1 for share");
			await client.query("select id from account where id = 1 for share");
		});

		const edges = takeEdges();
		expect(locks(edges)).toEqual(["account > invoice", "invoice > account"]);
		expect(findCycles(edges)).toEqual([]);
	});

	it("form no cycle when both first hold the same row in modes that wait for each other", async () => {
		await inTransaction(async (client) => {
			await client.query(
				"select id from ledger where id = 1 for no key update",
			);
			await client.query("select id from account where id = 1 for update");
			await client.query("select id from invoice where id = 1 for update");
		});
		await inTransaction(async (client) => {
			await client.query("select id from ledger where id = 1 for share");
			await client.query("select id from invoice where id = 1 for update");
			await client.query("select id from account where id = 1 for update");
		});

		expect(findCycles(takeEdges())).toEqual([]);
	});
});

describe("an advisory lock", () => {
	it("forms a cycle with rows another path takes before it, on any key of its purpose", async () => {
		await inTransaction(async (client) => {
			await client.query(
				"select pg_advisory_xact_lock(hashtext('order:' || $1))",
				[1],
			);
			await client.query("select id from account where id = 1 for update");
		});
		await inTransaction(async (client) => {
			await client.query("select id from account where id = 1 for update");
			await client.query(
				"select pg_advisory_xact_lock(hashtext(key)) from unnest($1::text[]) as key order by key",
				[["order:2", "order:3"]],
			);
		});

		const [cycle, ...more] = findCycles(takeEdges());
		expect(more).toEqual([]);
		expect(locks(cycle ?? [])).toEqual([
			"account > advisory order:",
			"advisory order: > account",
		]);
	});

	it("taken with pg_try_ waits for nobody, so it closes no cycle", async () => {
		await inTransaction(async (client) => {
			await client.query("select pg_advisory_xact_lock(hashtext($1))", [
				"order:1",
			]);
			await client.query("select id from account where id = 1 for update");
		});
		await inTransaction(async (client) => {
			await client.query("select id from account where id = 1 for update");
			await client.query(
				"select pg_try_advisory_xact_lock(hashtext($1)) as taken",
				["order:2"],
			);
		});

		expect(findCycles(takeEdges())).toEqual([]);
	});
});

describe("LOCK TABLE", () => {
	it("in SHARE mode forms a cycle with a path that writes the table", async () => {
		await inTransaction(async (client) => {
			await client.query("lock table invoice in share mode");
			await client.query("select id from account where id = 1 for update");
		});
		await inTransaction(async (client) => {
			await client.query("select id from account where id = 1 for update");
			await client.query("update invoice set total = 0 where id = 1");
		});

		expect(findCycles(takeEdges())).toHaveLength(1);
	});

	it("in SHARE mode forms no cycle with a path that only locks the table's rows", async () => {
		await inTransaction(async (client) => {
			await client.query("lock table invoice in share mode");
			await client.query("select id from account where id = 1 for update");
		});
		await inTransaction(async (client) => {
			await client.query("select id from account where id = 1 for update");
			await client.query("select id from invoice where id = 1 for update");
		});

		expect(findCycles(takeEdges())).toEqual([]);
	});
});

/** Returns once the backend's statement waits for a lock another transaction holds. */
const waitingForLock = (pid: number) =>
	until(
		"select cardinality(pg_blocking_pids($1)) > 0 as done",
		[pid],
		`Backend ${pid} didn't wait for a lock within five seconds.`,
	);
