---
type: Changed
pr: 5540
---
**Closing a milestone no longer goes through while a capability still reports open work** — before, `/gsd-complete-milestone` archived the roadmap even when a blocking `ship:pre` gate still failed. `milestone complete --confirm` now runs each such gate once per milestone phase and refuses with reason `milestone_gate_blocked` (also when the milestone window cannot be resolved and a gate has `onError: halt`); `--dry-run` and `/gsd-audit-milestone` run the same gates, and the `--dry-run` JSON gains `would_refuse` and `gate_warnings`. Command gates read `GSD_PHASE_NUMBER`, `GSD_PHASE_DIR` and `GSD_PHASE_REQ_IDS` from the environment. Breaking: the old `${PHASE_NUMBER}`, `${PHASE_DIR}` and `${PHASE_REQ_IDS}` spelling and any single-quoted `${GSD_PHASE_*}` are refused as unevaluable, so write `"${GSD_PHASE_NUMBER}"`; the beads ship gate migrates under gsd-beads-i7e7. (#5482)
