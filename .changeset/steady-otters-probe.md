---
type: Fixed
pr: 5710
---
`/gsd-discuss-phase` and `/gsd-surface` in a `--claude --global --config-dir <dir>` install now look up gsd-tools under `<dir>/gsd-core` instead of `~/.claude/gsd-core`: the Claude skill and command rewrite now also replaces the bare `~/.claude` and `$HOME/.claude` forms, such as the launcher's `${CLAUDE_CONFIG_DIR:-$HOME/.claude}` default, and leaves `.claude-plugin`, `.claudeignore` and `.claude-work` alone (#5501).
