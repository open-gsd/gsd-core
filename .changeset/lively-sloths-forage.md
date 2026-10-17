---
type: Fixed
pr: 5192
---
**plan-phase's stall watch now waits for the planner and plan-checker to actually return** — it no longer reports them finished at its first check because their own prompt or definition mentions the return markers, and a finished plan revision now continues instead of always ending in the stall menu. The plan-checker now declares `Write` for that one receipt file, so on Codex it runs `workspace-write` instead of `read-only`, and on Claude Code it is denied only `Edit` and `MultiEdit`. No receipt is created when the phase directory is a symlink or resolves outside the project (for example through a symlinked parent), when its path has a `..` component, or when it holds a control character; the watch then ends on the agent's own completion result or as stalled. (#5182)
