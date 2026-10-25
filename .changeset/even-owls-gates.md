---
type: Fixed
pr: 5655
---
**The `verify:pre` and `execute:wave:post` predicate gate dispatches now pass the phase values their step holds** — `verify-work.md` forwarded only `--phase-dir` although it holds the phase number, and `wave-post-gate-hooks.md` pointed at a predicate command its block never showed, so a `command-exit-zero` gate referencing `${PHASE_NUMBER}` or `${PHASE_DIR}` there interpolated an empty string. (#5289, #5290)
