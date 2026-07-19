---
type: Fixed
pr: 2425
---
**`phase.add` no longer silently mistakes a goal-shaped description for a phase title** — a long or multi-sentence description used to land verbatim in the `### Phase N:` header with no signal anything was off; `phase.add` now returns a `warning` field when the description looks goal-shaped, and the phase-number auto-detect docs now correctly point callers at the orchestrating workflow instead of implying `gsd-tools.cjs` resolves it itself. (#2390)
