---
type: Changed
pr: 827
---
Codex installs now register three additional stable hook events (`SubagentStart`, `Stop`, `PostToolUse`) wired to `gsd-context-monitor.js`, matching the full event coverage available since Codex CLI stabilised these hooks. The `SessionStart` hook entry gains a `commandWindows` field on Windows installs so the `.cmd` shim is used for native execution (Git Bash/MSYS cannot POSIX-exec `node.exe` directly). Both new-event registration and uninstall paths handle the flat `{ "EventName": [...] }` and nested `{ "hooks": { "EventName": [...] } }` hooks.json shapes. `gsd-context-monitor.js` and its Windows `.cmd` sibling are added to the managed-hook allowlist so idempotent re-runs de-duplicate entries correctly. (#772)
