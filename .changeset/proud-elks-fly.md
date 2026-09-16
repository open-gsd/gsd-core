---
type: Fixed
pr: 0
---
**`/gsd-code-review --fix` now works on an existing REVIEW.md even when no source files changed** — incremental scoping (#3661) narrowed the review file set to empty for phases whose only post-review changes were planning artifacts, and the empty-scope check exited the whole workflow before the fix step, so standing findings could never be addressed. With `--fix` and an existing REVIEW.md, the empty scope now routes straight to the fix workflow instead of skipping. (#4665)
