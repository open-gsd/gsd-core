---
type: Added
pr: 565
---
**Milestone-prefixed phase ID convention (`Phase M-NN`) with migration tool and validation** — introduces globally unique phase IDs within a project, resolving cross-session reference ambiguity behind bugs #3537/#3287/#3297/#3298. Adds `getMilestoneFromPhaseId()` / `getPhaseDirFromPhaseId()` helpers to `core.cjs`, fixes `isDirInMilestone` to correctly match `GSD-02-01-setup` style dirs, extends heading regex to tolerate `[bracket-token]` scope prefixes, adds W021 validation rule for milestone-prefix mismatch, adds `gsd-tools roadmap validate` and `roadmap upgrade --convention milestone-prefixed` commands, and introduces the `phase_id_convention` config field (`null` default, fully backwards-compatible). Closes #39.
