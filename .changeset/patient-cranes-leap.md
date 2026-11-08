---
type: Fixed
pr: 0
---
**`state prune` no longer loses entries when a write fails** — it now writes `STATE-ARCHIVE.md` first, atomically and under the STATE.md lock, and puts both files back if the STATE.md write fails; a prune re-run after one that was interrupted between the two writes archives each entry once, even after the current phase moved; a symlinked or special-file `STATE-ARCHIVE.md` is refused instead of written through, a named pipe at `STATE.md` no longer hangs `state prune`, and a failed auto-prune in `phase complete` is reported as a warning (#5831).
