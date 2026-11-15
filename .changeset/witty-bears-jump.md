---
type: Fixed
pr: 5455
---
**A `fix(<phase>-<plan>)` GREEN commit no longer hard-stops `verify-phase-goal`** — under `tdd_mode`, `tdd.review-checkpoint` reported a plan whose GREEN commit was `fix(<phase>-<plan>)` as missing GREEN; the gate now accepts `feat` or `fix`, and the TDD reference, planner, and executor docs state the same rule. The `Expected commit pattern:` and `GREEN precedes RED` lines of the `tdd.review-checkpoint` output now name `fix(...)` beside `feat(...)`, and the executor halt reason `feat_before_test` is renamed `impl_before_test`; scripts that match the old halt-reason token or the old hint text must change. (#5274)
