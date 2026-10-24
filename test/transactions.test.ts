import { expect, it } from "vitest";
import { takeEdges, takeUnnamed } from "../src/index.ts";
import { inTransaction, pool, until } from "./db.ts";

const edges = () =>
	takeEdges().map(({ held, took }) => `${held.name} > ${took.name}`);

it("takes no new edge for a row the transaction already holds", async () => {
	await inTransaction(async (client) => {
		await client.query("select id from account where id = 1 for update");
		await client.query("select id from invoice where id = 1 for update");
		await client.query("select id from account where id = 1 for update");
		await client.query("update account set balance = 1 where id = $1", [1]);
	});

	expect(edges()).toEqual(["account > invoice"]);
});

it("lets go of the locks taken after a savepoint the transaction rolls back to", async () => {
	await inTransaction(async (client) => {
		await client.query("savepoint before_invoice");
		await client.query("select id from invoice where id = 1 for update");
		await client.query("rollback to savepoint before_invoice");
		await client.query("select id from account where id = 1 for update");
	});

	expect(edges()).toEqual([]);
});

it("keeps the locks taken after a savepoint the transaction releases", async () => {
	await inTransaction(async (client) => {
		await client.query("savepoint before_invoice");
		await client.query("select id from invoice where id = 1 for update");
		await client.query("release savepoint before_invoice");
		await client.query("select id from account where id = 1 for update");
	});

	expect(edges()).toEqual(["invoice > account"]);
});

it("takes no edge to a row the transaction inserted: nobody else can hold it", async () => {
	await inTransaction(async (client) => {
		await client.query("select id from account where id = 1 for update");
		await client.query("insert into invoice (id) values ($1)", [3]);
		await client.query("update invoice set total = 1 where id = $1", [3]);
	});

	expect(edges()).toEqual([]);
});

it("lists a row lock whose statement names none of its rows, keys unknown", async () => {
	await inTransaction(async (client) => {
		await client.query(
			"select balance from account where balance >= 0 for update",
		);
		await client.query("select id from invoice where id = 1 for update");
		await client.query("update invoice set total = 2 where id = $1", [1]);
	});

	expect(
		takeUnnamed().map(({ name, mode, site }) => [name, mode, site]),
	).toEqual([
		[
			"account",
			"FOR UPDATE",
			expect.stringMatching(/^test\/transactions\.test\.ts:\d+ /),
		],
	]);
});

it("holds the row an update waited for and found no longer matching, though it wrote none", async () => {
	expect(
		await afterAConcurrentWrite(
			"update account set balance = 2 where id = $1 and balance = 0",
		),
	).toEqual({ answered: 0, probe: "55P03", edges: ["invoice > account"] });
});

it("holds the row a SELECT … FOR UPDATE waited for and found no longer matching, though it answered none", async () => {
	expect(
		await afterAConcurrentWrite(
			"select id from account where id = $1 and balance = 0 for update",
		),
	).toEqual({ answered: 0, probe: "55P03", edges: ["invoice > account"] });
});

it("takes no foreign-key check of an insert that skipped a row on a conflict, as it can't tell which rows it wrote", async () => {
	await pool.query("insert into payment (id) values (20)");
	try {
		await inTransaction(async (client) => {
			await client.query("select id from invoice where id = 1 for update");
			await client.query(
				"insert into payment (id, account_id) values ($1, $2), ($3, $4) on conflict do nothing",
				[20, 1, 21, 2],
			);
		});

		expect(edges()).toEqual([]);
	} finally {
		await pool.query("delete from payment where id = 20");
	}
});

it("takes no edge for an advisory call a statement made for none of its rows, as it answered none", async () => {
	await inTransaction(async (client) => {
		await client.query("select id from account where id = 1 for update");
		await client.query(
			"select pg_advisory_xact_lock(hashtext($1)) from invoice where id = -1",
			["order:1"],
		);
	});

	expect(edges()).toEqual([]);
});

/**
 * Runs `statement` on account 10, holding an invoice, while another session
 * changes the account's balance: it waits for that session, which then
 * commits, and finds the row no longer matching. What it answered, what a
 * third session's NOWAIT lock of the row met while it still ran, and the
 * edges its transaction took.
 */
async function afterAConcurrentWrite(statement: string) {
	await pool.query("insert into account (id) values (10)");
	const other = await pool.connect();
	try {
		const {
			rows: [{ pid }],
		} = await other.query("select pg_backend_pid() as pid");
		await other.query("begin");
		await other.query("update account set balance = 1 where id = 10");
		let answered: number | null = null;
		let probe = "";
		const waiting = inTransaction(async (client) => {
			await client.query("select id from invoice where id = 1 for update");
			({ rowCount: answered } = await client.query(statement, [10]));
			probe = await pool
				.query("select id from account where id = 10 for update nowait")
				.then(
					() => "free",
					(error: { code: string }) => error.code,
				);
		});
		await waitedOn(pid);
		await other.query("commit");
		await waiting;
		return { answered, probe, edges: edges() };
	} finally {
		other.release();
		await pool.query("delete from account where id = 10");
	}
}

/** Returns once some statement waits for a lock the backend holds. */
const waitedOn = (pid: number) =>
	until(
		"select exists (select from pg_locks where not granted and $1 = any(pg_blocking_pids(pid))) as done",
		[pid],
		`No statement waited for a lock backend ${pid} holds within five seconds.`,
	);
