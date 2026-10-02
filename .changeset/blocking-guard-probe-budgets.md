---
type: Fixed
pr: 0
---
**Blocking PreToolUse guards no longer silently allow a denied edit on a slow host** — plugin-registered and Kimi-registered guards use the 120 s host budget the installer already uses, and the guards' internal git probes get a 5 s budget instead of 2 s, so a starved host can no longer time a probe out and fail the guard open. (#5180)
