---
type: Fixed
pr: 5128
---
**Windows installs no longer treat WSL System32 bash as Git Bash** — when Git for Windows is outside the standard locations, portable JS hooks were written as a bare bash command and the entrypoint gate accepted that launcher. The hook is now left unregistered and the gate reports `unresolved-interpreter` instead: on such a host a fresh install fails loudly rather than installing hooks that silently never run, and an upgrade over already-registered hooks fails the gate the same way. A Git Bash on PATH outside the standard locations (for example Scoop) is no longer picked up either — that fallback reached System32 whenever it lost the PATH-order race, so its removal is intended; set `GSD_BASH_PATH` to the Git `bash.exe` as the migration. (#5100)
