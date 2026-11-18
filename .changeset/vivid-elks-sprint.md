---
type: Changed
pr: 5540
---
**Closing a milestone no longer goes through while a capability still reports open work** — before, `/gsd-complete-milestone` archived the roadmap even when a blocking `ship:pre` gate still failed; now `milestone complete --confirm` refuses with `milestone_gate_blocked`, and `milestone complete --dry-run` and `/gsd-audit-milestone` run the `ship:pre` gate commands and report what would refuse in `would_refuse` and the gates that were not evaluated in `gate_warnings`. (#5482)
