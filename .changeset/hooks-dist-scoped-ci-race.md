---
type: Fixed
pr: 1968
---
Build the gitignored `hooks/dist/` artifact once upfront in `scripts/run-tests.cjs` (the same chokepoint as `ensureBuiltArtifacts`), before any concurrent install test spawns `install.js`. Closes the scoped-CI first-build empty-dir race that intermittently failed install tests with `Failed to install hooks: directory is empty` (e.g. `bug-3683-workflow-colon-namespace-leak`). (#1967)
