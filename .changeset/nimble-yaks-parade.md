---
type: Fixed
pr: 2061
---
**`phase complete` no longer marks the wrong phase as complete** — the ROADMAP checkbox regex matched any unchecked line that merely mentioned the completed phase (e.g. "after Phase 1 verification"), so re-running completion when the target box was already checked corrupted the next phase entry.
