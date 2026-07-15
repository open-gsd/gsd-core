---
type: Fixed
pr: 2261
---
**Windows Claude Code hooks now work under PowerShell** — when Claude Code's hook runner resolves to PowerShell (not Git Bash), every GSD-installed hook failed with `Unexpected token` because the installer emitted bare quoted paths with no PowerShell call operator. The fix adds a `hookShell` parameter to the hook-command projection chain; when `hookShell='powershell'`, the `&` call operator is prepended. Default behavior (Git Bash, no prefix) is unchanged. (#2236)
