---
type: Changed
pr: 0
---
**`verify plan-structure` warns when an `<automated>` check pipes its command into `tail`, `head` or `grep`** — such a check reports that program's status, so a failing command reads as clean; rule R4 already warned about the shape for a `git` pipeline. The warning is not raised when a `set -o pipefail` command comes earlier in the check, when the next command reads `$PIPESTATUS`, or when the `grep` is fed only by `grep`, `sed`, `awk`, `cat` or `tac`, and it does not invalidate a plan. The planner's gate rules and the plan-structure guidance name the shape and what to do about it, and the antipatterns reference gives `npm test` alone where it offered `npm test 2>&1 | grep -E '[0-9]+ passed'` as a good form. (#6602)
