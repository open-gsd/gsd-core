---
type: Fixed
pr: 0
---
**Worktree branch guards now accept Claude Code's `agent-<id>` namespace** — the `worktree record-agent` command, the spawn-time branch check, the cleanup-wave manifest reader, and the force-add/path/workflow guards all accept both the current `agent-<id>` and the legacy `worktree-agent-<id>` branch naming. Previously, Claude Code's rename from `worktree-agent-<id>` to `agent-<id>` caused every executor sub-agent to fail its branch check (false-positive FATAL / exit 42) and silently dropped valid cleanup-manifest entries (`empty_manifest`), blocking merge-back. (#1995)
