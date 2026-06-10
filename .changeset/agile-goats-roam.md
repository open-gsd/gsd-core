---
type: Fixed
pr: 1005
---
**`/gsd-code-review`, `/gsd-code-review --fix`, and `/gsd-eval-review` now inject configured `agent_skills` into their subagents** — these review-family workflows previously spawned their reviewer/fixer/auditor agents (including the `--auto` re-review/re-fix loops) without the project-configured skill and rule context, so any `agent_skills` set for `gsd-code-reviewer`, `gsd-code-fixer`, or `gsd-eval-auditor` were silently ignored. They now query and inject those skills like the ~20 sibling workflows.
