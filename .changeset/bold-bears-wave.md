---
type: Fixed
pr: 1537
---
**Non-Claude runtime installs now resolve their own runtime and never attempt Claude-only worktree isolation** — on any non-Claude install (Cursor, Gemini, Qwen, etc.) a runtime-neutral `.planning/config.json` previously resolved `runtime=claude` and enabled git worktree isolation, which only Claude Code's `isolation="worktree"` can honor — risking main-checkout edits while the workflow believed agents were isolated. Every non-Claude install now resolves its own runtime identity, defaults `workflow.use_worktrees` to `false`, fails closed if worktrees are forced on, and runs plan/execute inline in the manager/autonomous flows since only Codex can background-nest the pipeline's subagents. (#1521)
