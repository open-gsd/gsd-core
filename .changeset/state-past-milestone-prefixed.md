---
type: Fixed
pr: 0
---
**`phase complete` no longer rewinds STATE.md under milestone-prefixed phase ids** — re-completing a phase such as `3-01` while STATE.md was already at `3-02` read the current phase as `3` and moved STATE back to the completed phase. (#5676)
