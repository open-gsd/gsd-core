---
type: Fixed
pr: 0
---
**`/gsd-debug` no longer re-asks symptoms already given.** When a symptom value (expected behavior, actual behavior, error messages, timeline, reproduction) is already supplied in $ARGUMENTS, Step 2 now shows it back for confirmation instead of asking the open question from scratch, and asks only for whatever is still missing (#5012).
