---
type: Fixed
pr: 5750
---
**`phase add` and `phase add-batch` no longer reuse a phase number under the bracket convention** — with `phase_id_convention: bracket`, existing `[CODE.MM] NN` phases (heading, checklist bullet or directory) now count when the next number is allocated, so a roadmap whose only phase is `[GSD.02] 01` no longer gets a second phase numbered 1. In every convention, allocation now also steps past the 999 backlog sentinel and ignores unsafe integers, so a roadmap at Phase 998 allocates 1000, not 999. (#5528)
