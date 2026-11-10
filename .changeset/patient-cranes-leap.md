---
type: Fixed
pr: 5981
---
**`state prune` no longer loses entries when a write fails** — it now writes `STATE-ARCHIVE.md` first, atomically and under the STATE.md lock, and puts both files back if the STATE.md write fails; re-running a prune that was interrupted between the two writes finishes it without archiving its entries twice; a symlinked or special-file `STATE-ARCHIVE.md` is refused instead of written through, a named pipe at `STATE.md` no longer hangs `state` commands, and a failed auto-prune in `phase complete` is reported as a warning (#5831).
