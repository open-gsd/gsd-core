---
type: Fixed
pr: 1
---
**`/gsd-plan-review-convergence` bare invocation no longer silently overrides `review.default_reviewers` with `--codex`** — when no reviewer flags are provided, the orchestrator now defers to `review.default_reviewers` (and configured `review.reviewer_instances`) and only falls back to `--codex` when that config is unset/empty. (#2315)
