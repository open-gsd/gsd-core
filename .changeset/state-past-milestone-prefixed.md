---
type: Fixed
pr: 5896
---
**`phase complete`, `state sync` and init progress read milestone-prefixed phase ids correctly** — under `phase_id_convention: milestone-prefixed`, re-completing a phase such as `3-01` while STATE.md was at `3-02` rewound STATE to the completed phase, a first-time completion advanced STATE to phase `3` named "02: beta", and roadmap checklist rows, phase headings and phase directories such as `03-02-beta` were not recognised by init progress, init manager (its checked-phase fallback), `find-phase` (which reported phase `03` named "02-beta") and the planning snapshot. (#5676)
