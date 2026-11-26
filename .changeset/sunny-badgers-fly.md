---
type: Added
pr: 6682
---
**A `type: tdd` plan can run its RED gate on a different model than GREEN and REFACTOR** — set `model_overrides` keys `gsd-executor:tdd-red` and `gsd-executor:tdd-green-refactor` (or the same keys for a specialist executor) and `execute-phase` dispatches the executor once for RED and once for GREEN/REFACTOR, each on its own model. With neither key set, dispatch is unchanged. (#4696)
