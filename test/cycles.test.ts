import { describe, expect, it } from "vitest";
import {
	type Edge,
	findCycles,
	LockCycleError,
	takeEdges,
} from "../src/index.ts";
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

describe("three paths that each take two of three tables, in a ring", () => {
	const ring = [
		["ledger", "account"],
		["account", "invoice"],
		["invoice", "ledger"],
	] as const;

	it("form a cycle when each waits for the lock the next one holds", async () => {
		for (const [first, then] of ring)
			await inTransaction(async (client) => {
				await client.query(`select id from ${first} where id = 1 for update`);
				await client.query(`select id from ${then} where id = 1 for update`);
			});

		const cycles = findCycles(takeEdges());
		expect(cycles.map(locks)).toEqual([
			["account > invoice", "invoice > ledger", "ledger > account"],
		]);
		const { message } = new LockCycleError(cycles);
		expect(message).toContain(
			"ledger, account and invoice are taken in a ring, each path asking for the lock the next one holds:",
		);
		expect(
			message.match(/held .* at test\/cycles\.test\.ts:\d+ /g),
		).toHaveLength(3);
	});

	it("deadlock in Postgres when their steps interleave", async () => {
		const sessions = [];
		for (const [first, then] of ring)
			sessions.push({ first, then, client: await pool.connect() });
		try {
			for (const { first, client } of sessions) {
				await client.query("begin");
				await client.query(`select id from ${first} where id = 1 for update`);
			}
			const asked = [];
			for (const [at, { then, client }] of sessions.entries()) {
				const {
					rows: [{ pid }],
				} = await client.query("select pg_backend_pid() as pid");
				asked.push(
					client.query(`select id from ${then} where id = 1 for update`),
				);
				if (at < sessions.length - 1) await waitingForLock(pid);
			}

			// Postgres ends one of them; the others go on once it's rolled back.
			const ended = await Promise.any(
				asked.map((request) =>
					request.then(
						() => Promise.reject(new Error("went through")),
						(error: { code: string }) => error.code,
					),
				),
			);
			expect(ended).toBe("40P01");
		} finally {
			await Promise.all(
				sessions.map(async ({ client }) => {
					await client.query("rollback");
					client.release();
				}),
			);
		}
	});

	it("form no cycle when two of them first hold the same row in modes that wait for each other", async () => {
		await pool.query("insert into payment (id) values (30)");
		try {
			for (const [at, [first, then]] of ring.entries())
				await inTransaction(async (client) => {
					if (at < 2)
						await client.query(
							"select id from payment where id = 30 for update",
						);
					await client.query(`select id from ${first} where id = 1 for update`);
					await client.query(`select id from ${then} where id = 1 for update`);
				});

			expect(findCycles(takeEdges())).toEqual([]);
		} finally {
			await pool.query("delete from payment where id = 30");
		}
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

describe("a foreign key's check", () => {
	it("takes KEY SHARE of the row an insert names, which forms a cycle with a path that holds that row for update", async () => {
		await inTransaction(async (client) => {
			await client.query("select id from invoice where id = 1 for update");
			await client.query(
				"insert into payment (id, account_id, invoice_id) values ($1, $2, $3)",
				[1, 1, 1],
			);
		});
		await inTransaction(async (client) => {
			await client.query("select id from account where id = 1 for update");
			await client.query("update invoice set total = 1 where id = $1", [1]);
		});

		const [cycle, ...more] = findCycles(takeEdges());
		expect(more).toEqual([]);
		expect(
			cycle
				?.map(({ held, took }) => `${held.name} > ${took.name} (${took.mode})`)
				.sort(),
		).toEqual([
			"account > invoice (UPDATE)",
			"invoice > account (FOR KEY SHARE)",
		]);
	});

	it("forms no cycle with a path that holds the row for no key update, which KEY SHARE doesn't wait for", async () => {
		await inTransaction(async (client) => {
			await client.query("select id from invoice where id = 1 for update");
			await client.query(
				"insert into payment (id, account_id, invoice_id) values ($1, $2, $3)",
				[1, 1, 1],
			);
		});
		await inTransaction(async (client) => {
			await client.query(
				"select id from account where id = 1 for no key update",
			);
			await client.query("update invoice set total = 1 where id = $1", [1]);
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
