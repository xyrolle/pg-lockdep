# pg-lockdep

Catch PostgreSQL deadlocks in your test suite before they reach production.

pg-lockdep watches the row locks and advisory locks each transaction takes while your tests run: `SELECT … FOR UPDATE`/`SHARE`, `UPDATE`, `DELETE` and `pg_advisory_xact_lock`. It builds a graph of which lock was held when another was taken. When two code paths take the same locks in opposite orders, and the lock modes conflict, it fails the run and names both call sites. It's [lockdep](https://docs.kernel.org/locking/lockdep-design.html) for Postgres apps.

It hooks the `pg` driver, so it works with plain `pg` and with anything built on it (Drizzle, Kysely and others). It runs only in tests and adds nothing to production.

**Status:** being extracted from a production app's test suite, where it's in use. The code and the first release are coming.

## License

MIT
