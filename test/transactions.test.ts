import { expect, it } from "vitest";
import { takeEdges } from "../src/index.ts";
import { inTransaction } from "./db.ts";

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
