---
type: Fixed
pr: 0
---
**Windows hooks no longer block every Read, Grep and Bash call when Git Bash is not found** — on Windows without a discoverable Git Bash, Claude Code runs hooks in PowerShell, where the installed bash node-runner could not parse and the secret-read guard blocked every tool call; the installer now writes a PowerShell runner with an explicit `shell: "powershell"` and rewrites existing entries. (#5850)
