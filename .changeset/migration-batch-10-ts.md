---
type: Changed
pr: 537
---
Migrate 9 modules from hand-written CommonJS to TypeScript source of truth per ADR-457 (#537). Modules migrated: `phases-command-router`, `verify-command-router`, `init-command-router`, `agent-command-router`, `task-command-router`, `validate-command-router`, `workstream-inventory`, `roadmap-command-router`, and `state-command-router`. Each `src/<m>.cts` compiles to a gitignored `gsd-core/bin/lib/<m>.cjs` with behaviour preserved byte-for-behaviour; only strict types are added.

<!-- docs-exempt: Internal ADR-457 build-at-publish source migration; behaviourally-identical gitignored artifacts at same require() paths; no user-facing change. -->
