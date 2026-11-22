---
type: Changed
pr: 0
---
**`worktree base-check` now reports which settings layer supplied `worktree.baseRef`** — `resolveEffectiveBaseRef` reads the value through the family-B config resolver and returns its producing layer, and the base-check result carries it as `baseRefLayer` (`runtime-local`, `runtime-shared`, `runtime-user`, or `null`). Verdicts are unchanged: `head` from any layer is trusted under the harness as #4588 measured, and a settings layer whose `baseRef` is not a string is still skipped. (#6031)
