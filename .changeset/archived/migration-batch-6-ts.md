---
type: Changed
pr: 537
---
Migrate 5 modules from hand-written CommonJS to TypeScript source of truth per ADR-457 (#537). Modules migrated: `graphify`, `install-profiles`, `intel`, `installer-migrations`, and `worktree-safety`. Each `src/<m>.cts` compiles to a gitignored `get-shit-done/bin/lib/<m>.cjs` with behaviour preserved byte-for-behaviour; only strict types are added.

<!-- docs-exempt: Internal ADR-457 build-at-publish source migration; behaviourally-identical gitignored artifacts at same require() paths; no user-facing change. -->
