---
type: Fixed
pr: 6673
---
**A TDD-mode phase blocked at the end-of-phase review can now be released by a recorded, attributed acceptance** — the "Phase blocked" message named `--force-mvp-gate`, but no parser accepted it and the review gate had no acceptance input, so a phase whose violations were all accepted deviations could never reach `phase.complete`; `--force-mvp-gate "<reason>"` now records one attributed deviation per violating plan in the phase's `TDD-DEVIATIONS.md` (reason, author, timestamp — the same shape as verification overrides), the gate releases recorded acceptances while keeping the FAIL rows visible, and an unreadable record fails closed. (#6451)
