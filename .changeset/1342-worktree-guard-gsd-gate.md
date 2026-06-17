---
type: Fixed
pr: 1361
---

**The worktree path guard no longer blocks ordinary writes in non-GSD git worktrees** — the `gsd-worktree-path-guard` PreToolUse hook fired for every `Write`/`Edit` in any linked git worktree, so Claude Code plan-mode writing its plan to `~/.claude/plans/<slug>.md` from a manually-created worktree was hard-blocked. The hook now only enforces inside a GSD isolated-executor worktree (branch `worktree-agent-*`) and fails open when a target resolves to no git repository, while still blocking writes that escape to a different git root (the #260 protection) or into a repository's `.git` internals. (#1342)
