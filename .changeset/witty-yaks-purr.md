---
type: Fixed
pr: 0
---
**`/gsd-quick` no longer strands locked decisions and research in worktree mode** — with `workflow.use_worktrees: true`, CONTEXT.md and RESEARCH.md now travel into the executor's worktree alongside PLAN.md instead of only PLAN.md reaching it, so `--discuss`/`--research` findings are no longer invisible to the executor (#4996).
