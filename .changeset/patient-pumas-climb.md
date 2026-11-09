---
type: Fixed
pr: 5887
---
**`drift-guard phase-status` and workstream progress read milestone-prefixed phases correctly** — under `phase_id_convention: milestone-prefixed` every `M-NN` phase named in ROADMAP Progress rows or STATE.md read as the bare milestone, so phase-status compared STATE against the milestone's first phase and reported a false drift, and workstream progress collapsed the milestone's phases into one. (#5675)
