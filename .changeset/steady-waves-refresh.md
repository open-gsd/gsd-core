---
type: Changed
pr: 6099
---
**A plain `/gsd-execute-phase` run now re-reads the plan index at each wave boundary** — it read `phase-plan-index` once, so whether it continued into a wave whose plans became ready when an earlier wave finished was left to the agent. After each wave it now re-reads the index within the plans the run started with, dispatches what has become ready, and stops on a checkpoint awaiting you, an unresolved failure or no progress; a run that stops with incomplete plans names them and skips phase verification. `--wave N`, `--interactive` and Copilot's inline run are unchanged (#5966).
