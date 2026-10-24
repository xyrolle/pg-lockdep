import { beforeEach, inject } from "vitest";
import { takeEdges, takeUnnamed, watchLocks } from "../src/index.ts";

await watchLocks({ connectionString: inject("databaseUrl") });

// Each test looks only at what its own transactions recorded.
beforeEach(() => {
	takeEdges();
	takeUnnamed();
});
