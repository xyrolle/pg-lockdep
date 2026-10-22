import { beforeEach, inject } from "vitest";
import { takeEdges, watchLocks } from "../src/index.ts";

await watchLocks({ connectionString: inject("databaseUrl") });

// Each test looks only at the edges its own transactions recorded.
beforeEach(() => {
	takeEdges();
});
