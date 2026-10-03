---
type: Fixed
pr: 5150
---
<!-- docs-exempt: prompt and reference table alignment; no public CLI or docs change -->
**`/gsd-pause-work` no longer produces a commit Conventional Commits hooks reject** — Changed the hardcoded pause/handoff commit subject from `wip: [context-name] paused...` to `docs(pause): [context-name] paused...` in `gsd-core/workflows/pause-work.md`, `gsd-core/references/git-integration.md`, and localized references, plus `chore(recover):` in execute-phase recovery hints (#4943).
