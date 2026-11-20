---
type: Fixed
pr: 6402
---
**A checkpoint continuation in `harness-worktree` mode keeps the paused plan's commits** — the fresh isolated agent forked from the orchestrator HEAD and could not see its own plan's finished tasks, which sit on the paused executor's unmerged branch. The workflow now resumes the paused executor by its recorded agent id while its worktree exists, and otherwise passes `<paused_branch>` so the continuation fast-forwards onto it before verifying the previous commits. (#6118)
