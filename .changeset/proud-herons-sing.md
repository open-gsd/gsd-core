---
type: Fixed
pr: 5405
---
The Codex Windows hook shim no longer depends on the install-time node.exe path alone: it uses GSD_NODE_PATH, then that path while it exists, then node.exe on PATH, so a WinGet Node upgrade no longer silently disables the hook until the installer is re-run.
