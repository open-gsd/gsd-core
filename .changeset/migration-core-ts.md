---
type: Changed
pr: 537
---
Migrate `core` (the most depended-upon module, ~68 internal dependents) from hand-written CommonJS to TypeScript source of truth per ADR-457 (#537). `src/core.cts` compiles to a gitignored `get-shit-done/bin/lib/core.cjs` with behaviour preserved byte-for-behaviour; only strict types are added.

<!-- docs-exempt: Internal ADR-457 build-at-publish source migration; behaviourally-identical gitignored artifact at same require() path; no user-facing change. -->
