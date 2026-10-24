import { setTimeout } from "node:timers/promises";
import pg from "pg";
import { afterAll, inject } from "vitest";

export const pool = new pg.Pool({ connectionString: inject("databaseUrl") });
afterAll(() => pool.end());

/** Runs `work` in a transaction on one of the pool's connections, rolled back so the rows stay as they were. */
export async function inTransaction(
	work: (client: pg.PoolClient) => Promise<unknown>,
) {
	const client = await pool.connect();
	try {
		await client.query("begin");
		await work(client);
	} finally {
		await client.query("rollback");
		client.release();
	}
}

/** Returns once `query` answers `true` as `done`, asking every 10 ms; throws `failure` after five seconds. */
export async function until(
	query: string,
	values: readonly unknown[],
	failure: string,
) {
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		const { rows } = await pool.query<{ done: boolean }>(query, [...values]);
		if (rows[0]?.done) return;
		await setTimeout(10);
	}
	throw new Error(failure);
}
