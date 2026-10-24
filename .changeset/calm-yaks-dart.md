---
type: Fixed
pr: 5660
---
**The TDD review now checks that GREEN follows RED** — `check tdd.review-checkpoint` only tested that a plan had a `test(...)` and a `feat(...)` commit, so a plan whose implementation came before its test passed. A GREEN now counts only when it descends from a RED commit (by commit ancestry, so histories merged from worktree branches are judged correctly); a plan with GREEN before RED fails with `reason: green_before_red` and blocks under TDD mode. Plans whose history is out of order will now be reported. (#5275)
