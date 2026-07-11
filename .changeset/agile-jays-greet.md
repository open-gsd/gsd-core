---
type: Fixed
pr: 1997
---
**Worktree guards now accept Claude Code's `agent-<id>` isolation branches** — the spawn-time branch check, cleanup-manifest normalizer, executor commit guard, path-traversal hook, force-add hook, and orchestrator cwd-drift guard all previously hard-coded the legacy `worktree-agent-<id>` namespace and mis-fired (blocked commits, empty cleanup manifests, and two silently-disabled safety guards) on the current `agent-<id>` branches. Both namespaces are now accepted. (#1995)
