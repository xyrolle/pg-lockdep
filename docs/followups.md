# Follow-ups

- **Cycles of four or more locks.** Done when `findCycles` reports a ring of four paths under the same mode and guard rules, by a search whose work doesn't grow with the number of simple cycles in the graph, with a four-path test that fails and its guarded counterpart that passes.
- **Foreign-key checks of an update that changes a key.** An update takes `KEY SHARE` on the parent's row a changed key names, and none when the value stays. Done when such a check is recorded only for a value the update changed, with a test whose cycle runs through one and its counterpart that sets the key to the value it had.
- **Watch mode.** Done when each rerun under `vitest` checks the edges of its own files.
