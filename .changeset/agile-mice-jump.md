---
type: Fixed
pr: 5306
---
**A refused symlinked install destination no longer leaves a half-replaced install** — the installer now runs every destination trust check before its first write, so a refused run exits with the same error and leaves the previous install untouched. (#5179)
