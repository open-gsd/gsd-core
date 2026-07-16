---
type: Fixed
pr: 2323
---
**`phases.clear` now archives phase history under the outgoing milestone version, not the newly-switched one** — because `new-milestone` advances the milestone before clearing leftover phases, the phase-history archive was silently misfiled under the new milestone's `<version>-phases/` directory. A new `--archive-version` override on `phases.clear` (threaded from the new-milestone workflow) files the archive under the previous milestone's version; without it, behavior is unchanged. (#2288)
