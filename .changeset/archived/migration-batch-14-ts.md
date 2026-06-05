---
type: Changed
pr: 537
---
Migrate 2 hub modules from hand-written CommonJS to TypeScript source of truth per ADR-457 (#537). Modules migrated: `commands` (~1305 LOC, 17 exported functions including `cmdCommit`, `cmdStats`, `cmdWebsearch`, `cmdEffortSync`, etc.) and `state` (~2074 LOC, 28 exported functions including `readModifyWriteStateMd`, `acquireStateLock`, `cmdStateBeginPhase`, `cmdStateSync`, etc.). Each `src/<m>.cts` compiles to a gitignored `get-shit-done/bin/lib/<m>.cjs` with behaviour preserved byte-for-behaviour; only strict types are added.

<!-- docs-exempt: Internal ADR-457 build-at-publish source migration; behaviourally-identical gitignored artifacts at same require() paths; no user-facing change. -->
