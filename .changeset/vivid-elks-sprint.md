---
type: Changed
pr: 5540
---
**Closing a milestone no longer goes through while a capability still reports open work** — before, `/gsd-complete-milestone` archived the roadmap even when a blocking `ship:pre` gate still failed; now `milestone complete --confirm` refuses with `milestone_gate_blocked`, `--dry-run` and `/gsd-audit-milestone` run blocking `ship:pre` gate commands, and gate commands read `GSD_PHASE_*` environment values, so the old `${PHASE_*}` spelling is refused and `"${GSD_PHASE_NUMBER}"` replaces it, and a single-quoted `'${GSD_PHASE_NUMBER}'` is refused too because the shell would not expand it. (#5482)
