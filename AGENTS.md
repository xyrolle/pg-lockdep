# pg-lockdep: contributor guide

pg-lockdep finds lock-order cycles, the cause of deadlocks, in a PostgreSQL app's test suite. It runs only in tests and has no production cost.

## Design invariants
- **It hooks the `pg` driver,** so every library built on `pg` is covered without adapters (Drizzle, Kysely and others).
- **Each connection is tracked across `BEGIN`/`COMMIT`/`ROLLBACK` and savepoints.** A rollback to a savepoint releases the locks taken after it.
- **It records what each statement locks:** `FOR UPDATE`, `NO KEY UPDATE`, `SHARE` and `KEY SHARE` (including `OF`); advisory transaction locks; `LOCK TABLE`; and the rows of `UPDATE`/`DELETE`.
- **A failure is a cycle in the observed "held X, then took Y" graph whose opposing edges conflict,** per PostgreSQL's row-lock conflict table. Share against share never fails. A rank deviation that isn't part of a cycle is a report, not a failure.
- **A failure names both call sites:** where the first lock was taken and where the second one was.
- **No false positives by design.** A rule that would flag something that can't deadlock is a bug.
- **It sees only the paths the tests run.** Say so in the docs, and never imply more.

## Testing
- **Integration tests run against a real PostgreSQL**, with two real connections for interleavings. Never mock the driver.
- **Each detection rule has a minimal two-path scenario** that fails, plus its share-mode or same-guard counterpart that passes.

## Quality bar

The code is small, readable and maintainable by a stranger. Every line earns its place.

- **The smallest public API that covers the real use.** No option, flag, hook or extension point without a concrete user today. Adding one later is easy; removing one is a breaking change.
- **No abstraction without two real uses.** No factories, registries, plugin systems or generic layers "for later".
- **Short files, short functions and plain control flow.** A reader understands a function without scrolling or jumping between files.
- **Names say what a thing is in the domain.** No `utils`, `helpers` or `manager` dumping grounds.
- **No dead code, commented-out code or TODOs in `main`.** Open work goes in `docs/followups.md`.
- **Dependencies are a cost.** Runtime dependencies are the platform and the declared peer dependencies, nothing else, unless a review agrees otherwise.
- **Errors are typed and actionable.** A message says what went wrong and what to do; nothing is swallowed.
- **Tests are few, meaningful and readable.** Each one names a behaviour and fails for one reason. No generated matrices and no snapshot dumps.
- **Nothing is pushed to `main` before review:**
  - one design read for simplicity and API shape;
  - one adversarial review (break it, soundness, clean code, simplicity);
  - findings fixed first.

## Working rules

### Commits and pull requests
- Every commit message is a single-line title with a conventional prefix (`feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`). No body, no bullet points.
- One cause per commit. A commit carries the test that proves it: red before, green after.
- No `Co-Authored-By` trailer and no AI or tool attribution, in commits, pull request titles or descriptions.
- Never force push a shared branch. Changes after review go in as new commits.
- A pull request description says what was wrong, the cause, what changed and how it was tested. Short, plain, and true to the code as it stands.

### Code
- The smallest change at the cause. Weigh the alternatives and pick the simplest one that fully solves the problem.
- No `as any`, no casts, no `@ts-ignore`/`@ts-expect-error` and no avoidable `!`. Model the type instead.
- Code reads at a glance. A chain that needs a comment becomes a named constant or a small named function. Comments say why, never what.
- No legacy or compatibility code. Delete what you replace in the same change; no fallbacks "for old callers", no aliases.
- Public API changes are deliberate. Every exported name is documented and tested.

### Tests
- Tests exercise the real thing (see the testing section below). No mocks where the real dependency can run.
- A test creates the data it needs and leaves nothing behind.
- No timing sleeps. Wait for an observable condition.

### Tooling
- pnpm only, with the version pinned in `packageManager`. Node 24 LTS.
- The latest stable, fastest tooling: Biome (lint and format), Vitest, and TypeScript 7 (`tsgo`) for type checking.
- `pnpm check`, `pnpm typecheck` and `pnpm test` all pass before a push.

### Docs
- Docs record decisions and their reasons, not implementation retellings.
- Open follow-ups go in `docs/followups.md`, each with "done when"; delete an entry in the change that resolves it.
