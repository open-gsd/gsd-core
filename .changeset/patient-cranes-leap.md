---
type: Fixed
pr: 0
---
**`state prune` no longer loses entries when a write fails** — it now writes `STATE-ARCHIVE.md` first, atomically and under the STATE.md lock, and puts both files back if the STATE.md write fails; re-running the same prune after it was interrupted between the two writes archives each entry once, a symlinked or special-file `STATE-ARCHIVE.md` is refused instead of written through, and a failed auto-prune in `phase complete` is now reported as a warning (#5831).
