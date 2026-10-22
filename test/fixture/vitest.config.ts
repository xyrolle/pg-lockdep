import { defineConfig } from "vitest/config";

// A project whose two test files take two tables in opposite orders, run
// by test/vitest.test.ts with DATABASE_URL naming the tests' database.
export default defineConfig({
	test: {
		root: import.meta.dirname,
		include: ["*.test.ts"],
		globalSetup: ["../../src/vitest.ts"],
		setupFiles: ["./setup.ts"],
		// Run at once, the two paths would deadlock for real.
		fileParallelism: false,
	},
});
