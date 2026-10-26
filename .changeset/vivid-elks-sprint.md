---
type: Changed
pr: 5540
---
**`milestone complete --confirm` now refuses while a capability still reports open work** — the close re-checks every capability's blocking `ship:pre` predicate gate (except `security` and `broken-windows`, which `ship.md` step 6 enforces) against each milestone phase and refuses, listing each blocking gate. `--force` does not bypass it; `--dry-run` previews it as `would_refuse` and therefore also runs the gate commands. (#5482)
