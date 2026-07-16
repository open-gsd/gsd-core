---
type: Fixed
pr: 2326
---
**The PreToolUse guard hooks now engage on Kimi** — `gsd-prompt-guard`, `gsd-read-guard`, and `gsd-worktree-path-guard` normalize Kimi's full payload shape before their checks: the tool name (`WriteFile` → `Write`, `StrReplaceFile` → `Edit`, bare or module-qualified) and the tool-input fields (`path` → `file_path`, `edit.old`/`edit.new` — single or list — → `old_string`/`new_string`), matching kimi-cli's actual tool schemas. The worktree path guard also writes its block reason to stderr, which is what Kimi feeds back to the model on exit 2. Previously the Kimi `[[hooks]]` matcher was translated to Kimi's vocabulary but the scripts' payload checks were not, leaving all guards dormant on Kimi while appearing registered. (#2304)
