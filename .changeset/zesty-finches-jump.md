---
type: Fixed
pr: 2354
---
**OpenCode slash commands now install to the supported `commands/` directory instead of OpenCode's legacy `command/` alias** — GSD wrote all ~71 `/gsd-*` commands to `command/` (singular), which OpenCode's docs list only as a backwards-compatibility alias for the documented `commands/` (plural) convention. Commands now land in `~/.config/opencode/commands/` (global) and `.opencode/commands/` (local), and upgrading migrates the legacy directory, preserving any files you put there yourself. OpenCode currently resolves both names, so this is an alignment rather than a rescue — it takes GSD off a path the vendor may withdraw. Kilo is unaffected.
