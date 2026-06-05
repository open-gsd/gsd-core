---
type: Fixed
pr: 514
---
**`state planned-phase` no longer corrupts milestone progress counters** — a plan-phase run rebuilt the milestone-wide `progress.*` block in STATE.md from a half-planned disk snapshot (trampling curated counters), and the legacy `<N>-PLAN-<NN>-SUMMARY.md` layout double-counted summaries as plans. plan-phase now writes body-only (resync:false) and `isRootPlanFile` no longer classifies summary files as plans. (#500)
