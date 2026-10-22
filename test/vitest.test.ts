import { spawnSync } from "node:child_process";
import { expect, inject, it } from "vitest";

it("fails a Vitest run whose test files take two tables in opposite orders, naming both paths", () => {
	const run = spawnSync(
		process.execPath,
		[
			"node_modules/vitest/vitest.mjs",
			"run",
			"--config",
			"test/fixture/vitest.config.ts",
		],
		{
			encoding: "utf8",
			env: { ...process.env, DATABASE_URL: inject("databaseUrl") },
		},
	);

	expect(run.status).toBe(1);
	const output = run.stdout + run.stderr;
	expect(output).toContain(
		"LockCycleError: pg-lockdep found 1 lock-order cycle(s)",
	);
	for (const line of [18, 19, 24, 25])
		expect(output).toContain(`at test/fixture/payments.ts:${line} `);
});
