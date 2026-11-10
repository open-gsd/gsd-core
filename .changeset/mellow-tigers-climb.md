---
type: Fixed
pr: 5929
---
**Code-review fix now runs whenever code review is enabled** — `/gsd-code-review-fix` and `/gsd-code-review --fix` no longer exit with "code-review capability inactive" when `workflow.code_review_point` is `execute:wave:post`; the gate follows the `workflow.code_review` toggle. (#5753)
