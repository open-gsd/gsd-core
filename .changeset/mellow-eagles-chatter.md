---
type: Fixed
pr: 2468
---
**`/gsd-stats` and STATE.md progress no longer freeze stale `total_plans`** — the progress ratchet was applied to the whole progress record, so any single counter decreasing (e.g. `completed_plans`) froze every field including `total_plans`. Now `total_plans` always takes the freshly derived value (joining `total_phases` from #1446), so it corrects in both directions — upward when a new phase adds plans, downward when a milestone reorganization removes phases. The write-path `applyStatePreservation` also switched from wholesale block restore to per-field merge, so `state planned-phase` writes a consistent `total_plans` instead of the pre-transform stale value.
