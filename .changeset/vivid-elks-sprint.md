---
type: Changed
pr: 5540
---
**Closing a milestone no longer goes through while a capability still reports open work** — before, `/gsd-complete-milestone` archived the roadmap even when a blocking `ship:pre` gate still failed. `milestone complete --confirm` now re-runs each such gate once per milestone phase and refuses, listing every blocking gate; `--force` does not bypass it. `--dry-run` and `/gsd-audit-milestone` preview the same open work, so they now run the gate commands (30 s per gate per phase by default), and the `--dry-run` JSON gains `would_refuse` and `gate_warnings`. A command gate reads the phase placeholders as environment values, so a directory name with shell syntax runs no command. A gate that single-quotes a placeholder, such as `'${PHASE_NUMBER}'`, now reports `unevaluable`; write `"${PHASE_NUMBER}"` instead. When the milestone window cannot be resolved, a blocking `onError: halt` gate refuses the close. (#5482)
