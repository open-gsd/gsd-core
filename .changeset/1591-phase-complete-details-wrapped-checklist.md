---
type: Fixed
pr: 1819
---
**`phase.complete` no longer reports a false `is_last_phase` on a `<details>`-wrapped checkbox checklist (#1591, #1752)** — when the active milestone's phase checklist was written as `- [ ] Phase N:` checkbox items inside a `<details>` block and the next phase had no directory on disk yet (still in planning), `phase.complete`'s `isLastPhase` roadmap-enumeration fallback used a heading-only pattern (`/#{2,4}\s*Phase…/`) that never matched checkbox items. It returned `is_last_phase: true, next_phase: null` on a mid-milestone phase and — via the milestone-complete cascade — wrongly flipped STATE.md to `Milestone complete` and decremented `progress.total_phases` (e.g. 8 → 7). The pattern now matches heading-style (`### Phase N:`), plain checkbox-list phases (`- [ ] Phase N:` / `- [x] Phase N:`), and the canonical **bold** checklist form the roadmap template emits (`- [ ] **Phase N: Name**`); `extractCurrentMilestone` already surfaces the `<details>`-wrapped checklist correctly, so no parser change was needed. Only the reproduced `phase.complete` fallback is changed; the heading-only sibling patterns elsewhere in `phase.cts` are untouched.

