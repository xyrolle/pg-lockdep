import pg from "pg";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function inTransaction(work: (client: pg.PoolClient) => Promise<void>) {
	const client = await pool.connect();
	try {
		await client.query("begin");
		await work(client);
	} finally {
		await client.query("rollback");
		client.release();
	}
}

export const pay = () =>
	inTransaction(async (client) => {
		await client.query("select id from account where id = 2 for update");
		await client.query("update invoice set total = 1 where id = $1", [2]);
	});

export const refund = () =>
	inTransaction(async (client) => {
		await client.query("select id from invoice where id = 2 for update");
		await client.query("update account set balance = 1 where id = $1", [2]);
	});

// Its rows are named neither by its answer nor by its where.
export const audit = () =>
	inTransaction(async (client) => {
		await client.query(
			"select balance from account where balance >= 0 for share",
		);
	});

export const close = () => pool.end();
