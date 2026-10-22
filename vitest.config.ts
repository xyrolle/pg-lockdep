import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/*.test.ts"],
		globalSetup: ["test/database.ts"],
		setupFiles: ["test/watch.ts"],
		// The files share one database's rows: run at once, their transactions
		// would wait for each other's, and a deadlock test could take others in.
		fileParallelism: false,
	},
});
