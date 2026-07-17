---
type: Fixed
pr: 2354
---
**OpenCode slash commands are now installed where OpenCode actually looks for them** — the installer wrote all ~71 `/gsd-*` commands to `command/` (singular) while OpenCode discovers them from `commands/` (plural), so a clean install produced no usable commands in the TUI at all. Commands now land in `~/.config/opencode/commands/` (global) and `.opencode/commands/` (local), and upgrading an existing install migrates the orphaned `command/` directory, preserving any files you put there yourself. Kilo is unaffected.
