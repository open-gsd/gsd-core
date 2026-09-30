---
type: Fixed
pr: 5128
---
**Windows installs no longer treat WSL System32 bash as Git Bash** — when Git for Windows is outside the standard locations, portable JS hooks were written as a bare bash command and the entrypoint gate accepted that launcher. (#5100)
