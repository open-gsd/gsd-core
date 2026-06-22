---
type: Fixed
pr: 1519
---
**Codex installs no longer run with unsafe Claude-style worktree isolation** — a Codex install with a runtime-neutral `.planning/config.json` was resolving its runtime as Claude and enabling git worktree isolation, which Codex's `spawn_agent` cannot honor; the Codex fail-closed guard was also silently dead because runtime/worktree config was read JSON-quoted and broke shell equality checks. Codex-emitted workflows now resolve `runtime=codex`, default `workflow.use_worktrees` to `false`, and fail closed when worktrees are forced on. (#1515)
