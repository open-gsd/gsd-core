---
type: Fixed
pr: 5252
---
**Statusline context meter no longer subtracts the auto-compact buffer when `autoCompactEnabled` is false** — with auto-compact disabled (settings `autoCompactEnabled: false`, `DISABLE_AUTO_COMPACT` or `DISABLE_COMPACT`) the bar shows the used share of the whole model window, matching Claude Code's own `/context`, instead of reading ~8 points high and pinning at 100% from raw 83.5% onward. Contributed by @tanji-dg (#4959, carried here).
