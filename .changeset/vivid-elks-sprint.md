---
type: Fixed
pr: 5540
---
**`milestone complete --confirm` now refuses while a capability still reports open work** — a milestone could be closed while a capability's blocking `ship:pre` predicate gate still blocked one of its phases. The close now re-checks every capability's blocking `ship:pre` predicate gate against each milestone phase and refuses, listing each blocking gate, so a milestone can no longer be closed while a capability still reports open work. `--force` does not bypass it; `--dry-run` previews it. (#5482)
