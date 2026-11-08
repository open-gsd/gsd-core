---
type: Added
pr: 6057
---
**`verify plan-structure --replay` checks that recorded baselines were measured** — a plan's `[HEAD=<value> EXPECT…]` baseline was a claim nobody checked until the executor ran the phase. The opt-in `--replay` flag runs each criterion's `grep` or read-only `git` command as direct argv with no shell, and reports where the printed value differs from the recorded one. It never changes the exit code. (#4310)
