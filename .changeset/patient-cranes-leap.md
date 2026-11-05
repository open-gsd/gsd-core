---
type: Fixed
pr: 5886
---
**`state prune` no longer loses entries when a write fails** — it now writes `STATE-ARCHIVE.md` first, atomically and under the STATE.md lock, and puts both files back if the STATE.md write fails; re-running the same prune after it was interrupted between the two writes archives each entry once, and a failed auto-prune in `phase complete` is now reported as a warning (#5831).
