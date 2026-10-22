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
