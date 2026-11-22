---
type: Fixed
pr: 0
---
**`/gsd-phase --insert` passes the phase you typed to `init.phase-op` and `phase.insert`** — the insert-phase workflow handed both verbs unset variables, so the context step searched for an empty phase and reported it as not found, and the insertion call received an empty after-phase and description; both fences now take the after-phase and description from one split of the typed arguments (skipping `--ws` and other flags, and stripping quotes from the after-phase). (#5961)
