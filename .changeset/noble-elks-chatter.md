---
type: Fixed
pr: 4959
---
**Statusline context meter no longer subtracts the auto-compact buffer when `autoCompactEnabled` is false** — with auto-compact disabled (settings `autoCompactEnabled: false`, `DISABLE_AUTOCOMPACT` or `CLAUDE_CODE_DISABLE_AUTO_COMPACT`) the bar shows the raw used% (`round(100 - remaining)`), matching Claude Code's own `/context`, instead of reading ~8 points high and pinning at 100% from raw 83.5% onward. Unchanged when auto-compact is enabled.
