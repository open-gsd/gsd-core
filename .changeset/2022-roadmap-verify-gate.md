---
type: Fixed
pr: 2030
---
**`roadmap update-plan-progress` no longer checks the phase checkbox without verification** — the command stamped the phase-level ROADMAP checkbox and completion date the moment the last plan summary landed (called routinely after every wave and every plan), with **no verification gate** — unlike `phase.complete` which correctly requires `readVerificationStatus(...).status === 'passed'`. Now `isComplete` requires both all plan summaries AND a passed verification, matching the `cmdPhaseComplete` contract, so the checkbox only fires after `gsd-verifier` has confirmed the phase. (#2022)
