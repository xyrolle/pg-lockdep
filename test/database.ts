import pg from "pg";
import type { TestProject } from "vitest/node";

// The tests' own database, created for the run and dropped after it, on the
// server DATABASE_URL names.

declare module "vitest" {
	interface ProvidedContext {
		databaseUrl: string;
	}
}

const NAME = "pglockdep_test";

async function onServer(work: (client: pg.Client) => Promise<unknown>) {
	const server = process.env.DATABASE_URL;
	if (!server)
		throw new Error(
			`Set DATABASE_URL to a PostgreSQL server where the tests may create and drop the database ${NAME}, such as postgres://postgres:postgres@localhost:5432/postgres.`,
		);
	const client = new pg.Client({ connectionString: server });
	await client.connect();
	try {
		await work(client);
	} finally {
		await client.end();
	}
	const url = new URL(server);
	url.pathname = `/${NAME}`;
	return url.href;
}

export async function setup(project: TestProject) {
	const url = await onServer(async (server) => {
		await server.query(`drop database if exists ${NAME} with (force)`);
		await server.query(`create database ${NAME}`);
	});
	const client = new pg.Client({ connectionString: url });
	await client.connect();
	await client.query(`
		create table ledger (id int primary key);
		create table account (id int primary key, balance int not null default 0);
		create table invoice (id int primary key, total int not null default 0);
		create table payment (
			id int primary key,
			account_id int references account,
			invoice_id int references invoice
		);
		insert into ledger values (1);
		insert into account (id) values (1), (2);
		insert into invoice (id) values (1), (2);
	`);
	await client.end();
	project.provide("databaseUrl", url);
}

export async function teardown() {
	await onServer((server) =>
		server.query(`drop database if exists ${NAME} with (force)`),
	);
}
