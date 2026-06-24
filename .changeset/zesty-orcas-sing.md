---
type: Fixed
pr: 1640
---
verify schema-drift now resolves the target phase by its canonical token instead of substring containment, so a non-existent phase no longer silently matches a token-superstring phase (e.g. "1" matching "11-expansion") and runs the drift gate against the wrong phase.
