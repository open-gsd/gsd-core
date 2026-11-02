---
type: Fixed
pr: 5233
---
**`worktree.reap-orphans` now removes a `.claude/worktrees/agent-<id>` directory left by an incomplete harness teardown, and only when every residue guard in `docs/CLI-TOOLS.md` passes** — the sweep used to miss such a directory and report `reaped: 0` (#4941).
