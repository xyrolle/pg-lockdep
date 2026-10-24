# pg-lockdep

Catch PostgreSQL deadlocks in your test suite before they reach production.

pg-lockdep watches the locks each transaction takes while your tests run: `SELECT … FOR UPDATE`/`NO KEY UPDATE`/`SHARE`/`KEY SHARE`, `UPDATE`, `DELETE`, upserts, the `KEY SHARE` an insert's foreign-key checks take, `LOCK TABLE` and `pg_advisory_xact_lock`. It records which lock a transaction held when it asked for another. When code paths take locks in an order that can deadlock, two locks in opposite orders or three in a ring, each path's mode making the next one wait, it fails the run and names every call site. It's [lockdep](https://docs.kernel.org/locking/lockdep-design.html) for Postgres apps.

It hooks the `pg` driver, so it works with plain `pg` and with anything built on its promise API (Drizzle, Kysely and others). It runs only in tests and adds nothing to production.

**Status:** 0.1, not yet published to npm.

## Install

```sh
pnpm add -D pg-lockdep
```

It needs Node 24 and `pg` 8; the Vitest integration needs Vitest 5.

## Usage with Vitest

```ts
// vitest.config.ts
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globalSetup: ["pg-lockdep/vitest"],
		setupFiles: ["./test/locks.ts"],
	},
});
```

```ts
// test/locks.ts
import { recordLocks } from "pg-lockdep/vitest";

await recordLocks({
	connectionString: process.env.DATABASE_URL ?? "postgres://localhost/app_test",
	// A test's own transaction, begun in a test file, stands in for another session.
	ignore: /^[^ ]+\.test\.ts:/,
});
```

Each test file records what its transactions did. Once `vitest run` has run every file, the run fails with a `LockCycleError` if two paths can deadlock:

```
LockCycleError: pg-lockdep found 1 lock-order cycle(s) that can deadlock.

invoice and account are taken in opposite orders:
  one path held invoice (FOR UPDATE) at src/refunds.ts:24 refund < test/refunds.test.ts:9
      then took account (UPDATE) at src/refunds.ts:25 refund < test/refunds.test.ts:9
  another held account (FOR UPDATE) at src/payments.ts:18 pay < test/payments.test.ts:7
      then took invoice (UPDATE) at src/payments.ts:19 pay < test/payments.test.ts:7

Take the locks in the same order on every path, or have the paths first take one lock that makes the others wait.
```

A call site is the innermost four frames outside `node_modules`, captured through the `await`s that led to the statement.

The run also warns of each row lock whose rows it couldn't name, since a cycle through them may be missed:

```
pg-lockdep couldn't name the rows of 1 row lock, keys unknown, so a cycle through it may be missed.
  account (FOR SHARE) at src/audit.ts:12 audit < test/audit.test.ts:5
Return the rows' primary keys from the statement, or name them in its where.
```

## How it decides

- **A lock is named by its table, or by an advisory key's purpose.** Rows of one table are one lock, as lockdep names a lock by its class: two paths meet in the graph even when the tests gave them different rows, because production can give them the same. An advisory key hashed from text such as `order:42` belongs to the purpose before its first colon, `order:`; any other key is a lock of its own.
- **An edge is "held X, then asked for Y"** on rows or keys the transaction didn't already hold in a mode at least as strong. Rows it inserted are its own, and `NOWAIT`, `SKIP LOCKED` and `pg_try_…` wait for nobody, so none of them makes an edge. Rolling back to a savepoint lets go of the locks taken after it.
- **A cycle is a ring of edges, each path's request waiting for the lock the next one holds:** two edges in opposite directions, or three that each take two of three locks. The modes decide, by PostgreSQL's row-level and table-level conflict tables, so `FOR SHARE` against `FOR SHARE` never fails.
- **A lock two of the paths held first, on the same row or key, in modes that can't be held at once, rules the cycle out:** those two can't run together. Only the same row or key counts, as the tests ran it: a per-tenant row serializes two paths only within one tenant, which pg-lockdep can't know.
- **When it can't tell, it doesn't fail, and it says so.** A statement whose rows it can't name, from its answer's primary keys or a `where` on them, is taken to touch rows of that table the transaction already holds, or, when it holds none, to cover every later lock of them in that transaction. Either way it's listed as keys unknown.
- **An insert's foreign-key checks hold the parents' rows it names for `KEY SHARE`,** read from the catalog's foreign keys and the values the insert gives them by parameter. They're the insert's own locks, after the row it writes. An insert that skipped a row on a conflict doesn't say which rows it wrote, so its checks aren't counted.
- **A statement that answered no row may still hold one.** An update, a delete or a `SELECT … FOR …` that waited for a row a concurrent writer changed, and then found it no longer matching, answers nothing but keeps that row's lock. So it counts as a lock on the rows its `where` names, or on rows it can't name. An advisory call runs once per row its statement answers, so one that answered none took no advisory lock.

## API

### `pg-lockdep/vitest`

- **`recordLocks(options: WatchOptions): Promise<void>`**: for a setup file. Watches the test file's transactions and hands their edges to the run's check.
- **`setup`, `teardown`**: Vitest's global setup hooks, loaded by naming `"pg-lockdep/vitest"` in `globalSetup`. The teardown warns of the row locks whose rows it couldn't name, throws a `LockCycleError` when the run's edges hold a cycle, and an `Error` when no test file recorded its locks.

### `pg-lockdep`

For other runners, or to inspect the graph yourself:

- **`watchLocks(options: WatchOptions): Promise<void>`**: hooks `pg.Client.prototype.query`, so every client in the process is watched, pools' included. Call it once; calling it again replaces the options.
- **`WatchOptions`**: `connectionString`, the database under test, whose catalog names each table's primary key and foreign keys; `ignore`, a pattern for the call site of a transaction's `BEGIN`, whose transaction then isn't watched.
- **`takeEdges(): Edge[]`**: the edges this process recorded since the last call, which start over.
- **`takeUnnamed(): Lock[]`**: the row locks this process recorded since the last call whose statements named none of their rows, each once by lock, mode and call site; the list starts over.
- **`findCycles(edges: readonly Edge[]): Cycle[]`**: the rings of two or three locks some paths take in turn and can deadlock on, one cycle per set of locks.
- **`LockCycleError`**: an `Error` naming each cycle's paths, with the cycles on `cycles`.
- **Types:** `Edge` (`held` and `took`, each a `Lock`, and the `guards` held at that moment), `Lock` (`name`, `mode`, `site`), `Guard`, `Cycle` (two or three edges, each path asking for the lock the next one holds) and `Mode`.

## Limitations

- **It sees only the paths your tests run,** in the transactions they run. A path no test takes isn't checked.
- **Where it can't name the rows, it can miss a cycle.** A statement whose rows it can't name is taken to touch rows of that table the transaction already holds, or to cover all of them for the rest of the transaction, so a cycle through a row it didn't see isn't reported. It lists such statements as keys unknown: make them return their primary keys, or name them in the `where`.
- **It looks for cycles of two and three locks.** Four or more paths that wait on each other in a ring aren't found.
- **It doesn't check the order within one table or one advisory purpose,** such as two rows of one table taken in opposite orders.
- **It reads SQL with patterns, not a parser.** It doesn't see statements sent with a callback, several statements in one string, session-level advisory locks, `MERGE`, the foreign-key checks of an update that changes a key, of a multi-column key or of a value not given by parameter, locks taken by triggers or cascades, or inserts waiting on each other's unique keys. An `UPDATE` that changes a key column is taken as `NO KEY UPDATE`.
- **Rows are named by a single-column primary key,** read from the catalog when `watchLocks` runs, and tables by their name without the schema.
- **The Vitest check runs once `vitest run` ends,** not between reruns in watch mode.

## Development

`pnpm check`, `pnpm typecheck` and `pnpm test`. The tests run against a real PostgreSQL: set `DATABASE_URL` to a server where they may create and drop the database `pglockdep_test`.

## License

MIT
