---
type: Fixed
pr: 5908
---
**The fork-probe cache stays inside the project and out of git** — the cache no longer writes through a symlinked .gsd that points outside the project, and a fresh project no longer shows .gsd/ as untracked or sweeps it into git add -A. (#5757)
