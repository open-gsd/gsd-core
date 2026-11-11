---
type: Fixed
pr: 5457
---
**`tdd.review-checkpoint` no longer fails a sealed TDD plan after a squash merge** — a squash merge made a passing TDD plan fail the review checkpoint. Now `--record` seals the evidence, and a committed seal credits the plan after the squash, or shows it as not evaluable in a shallow clone. `ship` commits the seal when the phase's `commit_docs` resolves true (`phase_commit_docs.<phase>` overrides `commit_docs`) and exits 1 before the push when that commit fails. In a complete (non-shallow) history, an unsealed plan with no surviving commit and gone SUMMARY commits shows as not evaluable instead of failing. While the original commits still exist, a plan whose SUMMARY commits were rebased or amended with their subjects intact still fails. A squash commit titled `<type>(<phase>-<plan>):` with no seal still fails. (#5354)
