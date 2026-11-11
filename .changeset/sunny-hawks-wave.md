---
type: Fixed
pr: 6067
---
**Windows hooks no longer block every Read, Grep and Bash call when Git Bash is not found** — Claude Code runs hooks in PowerShell when it cannot find Git Bash, where the installed bash node-runner could not parse and the secret-read guard blocked every tool call; on Windows the installer now always writes a PowerShell runner with an explicit `shell: "powershell"` (Git Bash or not, portable installs included) and rewrites existing bash-runner entries, including the statusline, on reinstall. (#5850)
