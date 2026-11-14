---
type: Fixed
pr: 6188
---
**`phase complete` now keeps the prose in the Progress table Status cell** — a leading status token (`In Progress`, `Planned`, `Deferred`, ...) is rewritten to `Complete` and its tail kept (`In Progress - waiting on sign-off` becomes `Complete - waiting on sign-off`), prose with no token becomes `Complete - <prose>`, and a cell already reading `Complete` or `Completed` stays byte-identical; it shares one token-rewrite rule with `roadmap update-plan-progress`, which is unchanged. (#6170)
