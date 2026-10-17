---
type: Fixed
pr: 5233
---
**`worktree.reap-orphans` now removes a `.claude/worktrees/agent-*` directory left by an incomplete harness teardown, and only when every residue guard in `docs/CLI-TOOLS.md` passes** — the sweep used to miss such a directory and report `reaped: 0`; its three workflow callers now keep stderr, so a summary of what was removed or kept reaches the transcript, along with any runtime-build notice or Node warning, since `>/dev/null` discards only the JSON (#4941).
