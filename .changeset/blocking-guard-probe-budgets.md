---
type: Fixed
pr: 0
---
**Blocking PreToolUse guards no longer silently allow a denied edit on a slow host** — plugin-registered and Kimi-registered guards use the 120 s host budget the installer already uses; the worktree-path, workflow and Windsurf pre-write guards give their git probes a 5 s budget instead of 2 s; and the OpenCode and Kilo plugins no longer kill the git-probing guards before their worst case finishes. A killed or timed-out guard counts as an allow, so on a starved host any of these could previously let through the edit it exists to deny (Windsurf documents no hook timeout, so its host budget stays unknown). (#5180)
