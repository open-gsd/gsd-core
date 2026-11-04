---
type: Fixed
pr: 5886
---
**`state prune` no longer loses entries when a write fails, and a retry no longer duplicates them** — pruned entries are now written to `STATE-ARCHIVE.md` first, atomically (temp file + rename, never a truncating direct write) and under the STATE.md lock, and only then removed from STATE.md; if the STATE.md write fails, the archive is restored to its exact previous bytes. A failed archive write fails the prune with both files untouched. Each archived block records its run in an HTML comment, so re-running the same prune after it was interrupted between the two writes only finishes the STATE.md side: each entry is archived once. (A re-run with different options, or after STATE.md was edited in between, is a new prune and archives its entries again — duplicated, never lost.) Overlapping prunes no longer clobber each other's archive append (#5831).
