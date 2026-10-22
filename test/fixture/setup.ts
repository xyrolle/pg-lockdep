import { recordLocks } from "../../src/vitest.ts";

// The README's setup file, as written there but for the import path.
await recordLocks({
	connectionString: process.env.DATABASE_URL ?? "postgres://localhost/app_test",
	// A test's own transaction, begun in a test file, stands in for another session.
	ignore: /^[^ ]+\.test\.ts:/,
});
