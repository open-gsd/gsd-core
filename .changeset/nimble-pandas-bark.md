---
type: Fixed
pr: 5670
---
**Under the `milestone-prefixed` phase-id convention the state contract and `state sync` no longer truncate `M-NN` ids** — `state.json` listed every phase of a milestone as number `3` (with `-01:` leaking into the name), and `state sync` rewrote `current_phase: 3-01` to `3`; the Progress-table, checklist and prose-phase readers now take the whole `3-01` when that convention is set, and every other convention parses as before. (#5626)
