---
type: Fixed
pr: 5454
---
code-review-fix --auto now commits the retained .iterN.md backups when a run ends non-clean and COMMIT_DOCS is true, so the working tree is clean afterward and the post-mortem trail stays recoverable (#5034).
