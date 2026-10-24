import { spawnSync } from "node:child_process";
import { expect, inject, it } from "vitest";

/** Runs the fixture project, whose two test files take two tables in opposite orders: its exit status and its output. */
function runFixture() {
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
	return { status: run.status, output: run.stdout + run.stderr };
}

it("fails a Vitest run whose test files take two tables in opposite orders, naming both paths", () => {
	const { status, output } = runFixture();

	expect(status).toBe(1);
	expect(output).toContain(
		"LockCycleError: pg-lockdep found 1 lock-order cycle(s)",
	);
	for (const line of [18, 19, 24, 25])
		expect(output).toContain(`at test/fixture/payments.ts:${line} `);
});

it("warns at the end of a Vitest run of the row locks whose rows it couldn't name", () => {
	const { output } = runFixture();

	expect(output).toContain(
		"pg-lockdep couldn't name the rows of 1 row lock, keys unknown,",
	);
	expect(output).toMatch(
		/^ {2}account \(FOR SHARE\) at test\/fixture\/payments\.ts:\d+ /m,
	);
});
