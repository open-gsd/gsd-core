---
type: Fixed
pr: 0
---
**`plan-review-convergence` now runs `gsd-plan-phase` inline instead of inside `Agent()`** — both sites that previously wrapped `gsd-plan-phase` in `Agent()` (initial planning + replan loop) have been changed to bare `Skill()` calls at depth 0. On Claude Code, a depth-1 Agent has no Agent tool, so a wrapped `plan-phase` could never spawn `gsd-planner` or `gsd-plan-checker` — the replan loop silently failed to produce a revised plan whenever HIGH concerns were found. Running plan-phase inline from the depth-0 orchestrator (which retains the Agent tool) restores the full planner→checker sub-agent chain. A new structural guard test (`bug-936-no-nested-spawner-wrap.test.cjs`) statically scans all workflow files and fails if any workflow wraps a spawner orchestrator in `Agent()` without a `RUNTIME != claude` carve-out, preventing regression. (#936)
