---
type: Fixed
pr: 4820
---
**phase complete no longer names an already-complete phase as next** — completing a reopened phase out of order (later phases already [x]) picked the numerically-next phase even when its checkbox was already ticked, persisting it to STATE.md as current_phase. next_phase now skips phases whose roadmap checkbox is already [x], agreeing with roadmap.analyze and init.progress. (#4699)
