---
type: Fixed
pr: 893
---
**`validate health` and `validate consistency` no longer emit false-positive W007 warnings for projects using checklist-style ROADMAP.md phases.** `buildRoadmapPhaseVariants()` in `src/validate.cts` previously used only a heading-style regex (`## Phase N: name`), silently ignoring the supported checklist format (`- [x] **Phase N: name**`). This caused every on-disk phase directory to trigger W007 ("exists on disk but not in ROADMAP.md") when the project's ROADMAP used checklist-only notation. The fix adds a second regex pass mirroring the existing `buildNotStartedPhaseVariants()` approach. Additionally, `cmdValidateConsistency()` in `src/verify.cts` had a duplicate inline heading-only regex with the same gap — refactored to delegate to `buildRoadmapPhaseVariants()` (DRY). (#892)
