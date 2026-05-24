---
type: Fixed
pr: 166
---
**Windows Claude `.sh` hook command serialization** — installer-managed Claude hooks now emit script-only command entries (no explicit `bash.exe` wrapper) for Windows settings hooks, preventing the `bash.exe: ... cannot execute binary file` failure mode reported in SessionStart/PreToolUse hook execution.
