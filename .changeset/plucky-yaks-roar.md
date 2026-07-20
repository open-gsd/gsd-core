---
type: Fixed
pr: 0
---
**`/gsd-plan-review-convergence` no longer silently overrides configured reviewers with Codex** — a bare invocation (no reviewer flags) now respects `review.default_reviewers` (and, transitively, `review.reviewer_instances`) per ADR-0011/ADR-0015, instead of always injecting `--codex` and bypassing the configured default. Users without `review.default_reviewers` configured still get `--codex` as before. The startup banner now shows what will actually run.
