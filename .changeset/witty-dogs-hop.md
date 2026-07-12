---
type: Fixed
pr: 2209
---
**Milestone audit no longer flags a not-yet-validated phase as a Nyquist failure** — a phase that was planned but never run through `validate-phase` now reports as NOT-VALIDATED (a "run validate-phase" TODO) instead of collapsing into PARTIAL alongside phases whose validation genuinely failed. (#2117)
