import { beforeAll, expect, inject, it } from "vitest";
import { takeEdges, watchLocks } from "../src/index.ts";
import { inTransaction } from "./db.ts";

beforeAll(() =>
	watchLocks({ connectionString: inject("databaseUrl"), ignore: /standsIn/ }),
);

it("doesn't watch a transaction begun at an ignored call site", async () => {
	await standsInForAnotherSession();
	await inTransaction(async (client) => {
		await client.query("select id from account where id = 1 for update");
		await client.query("select id from invoice where id = 1 for update");
	});

	expect(
		takeEdges().map(({ held, took }) => `${held.name} > ${took.name}`),
	).toEqual(["account > invoice"]);
});

async function standsInForAnotherSession() {
	await inTransaction(async (client) => {
		await client.query("select id from invoice where id = 1 for update");
		await client.query("select id from account where id = 1 for update");
	});
}
