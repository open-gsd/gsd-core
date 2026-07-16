---
type: Fixed
pr: 0
---
**The PreToolUse guard hooks now engage on Kimi** — `gsd-prompt-guard`, `gsd-read-guard`, and `gsd-worktree-path-guard` normalize Kimi's tool vocabulary (`WriteFile` → `Write`, `StrReplaceFile` → `Edit`, bare or module-qualified) before the tool-name check, so the guards no longer silently exit on every Kimi tool call. Previously the Kimi `[[hooks]]` matcher was translated to Kimi's vocabulary but the scripts' payload check was not, leaving all guards dormant on Kimi while appearing registered. (#2304)
