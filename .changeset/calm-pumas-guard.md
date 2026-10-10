---
type: Fixed
pr: 5128
---
**Windows installs no longer treat WSL System32 bash as Git Bash** — when Git for Windows is outside the standard locations, portable JS hooks were written as a bare bash command and the entrypoint gate accepted that launcher. The one visible behaviour change: on win32, a `.js` portable hook with no Git Bash found is now left unregistered rather than written as a bare `bash`, so the hook does not run instead of running through WSL, which cannot read Windows paths. (#5100)
