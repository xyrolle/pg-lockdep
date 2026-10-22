# Follow-ups

- **Cycles of three or more locks.** Done when `findCycles` reports a ring of three paths under the same mode and guard rules, with a three-path test that fails and its guarded counterpart that passes.
- **Foreign-key checks.** An insert or a key update takes `KEY SHARE` on the rows its foreign keys name. Done when those locks are recorded from the catalog's foreign keys, with a test whose cycle runs through one.
- **Watch mode.** Done when each rerun under `vitest` checks the edges of its own files.
