---
type: Fixed
pr: 0
---
**`state prune` no longer loses entries when the archive write fails** — pruned entries are now written to `STATE-ARCHIVE.md` first, under the STATE.md lock, and only then removed from STATE.md; if the STATE.md write fails, the archive is restored to its exact previous bytes. An unwritable archive fails the prune with both files untouched, and overlapping prunes no longer clobber each other's archive append (#5831).
