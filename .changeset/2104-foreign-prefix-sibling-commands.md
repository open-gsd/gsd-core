---
type: Fixed
pr: 2149
---
**`init execute-phase`, `init verify-work`, and `init phase-op` no longer collapse foreign-prefixed task IDs to numeric phases** — `MEM-01` under `project_code: LKML` was silently stripped to `01` and resolved to the unrelated numeric Phase 01, because the #2056 guard was applied only to `init plan-phase`. The guard is now extracted into shared helpers (`guardedFindPhase` / `guardedGetRoadmapPhase`) that delegate to the canonical `isForeignPrefixedPhaseQuery` from `phase-id.cts`, and all four init commands route through them. (#2104)
