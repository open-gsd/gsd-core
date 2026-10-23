---
type: Fixed
pr: 5456
---
**Carry external lane evidence into `--fix --auto` re-reviews** — re-reviews now receive the external reviewer lane evidence the first review saw, instead of silently dropping it after iteration 1 (#5019). The persisted file names the lane dir by suffix only and is validated before any read or removal, and is written by the dispatch step itself so the keep-or-clear decision needs no shell state from earlier steps.
