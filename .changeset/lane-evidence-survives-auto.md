---
type: Fixed
pr: 5456
---
**Carry external lane evidence into `--fix --auto` re-reviews** — re-reviews now receive the external reviewer lane evidence the first review saw instead of silently dropping it after iteration 1, and a later `--auto` run for the same phase reads that evidence while it has been idle for less than 6 hours, and each read restarts that window (#5019); nothing is written into the project or its git metadata.
