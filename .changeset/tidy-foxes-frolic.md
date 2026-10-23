---
type: Fixed
pr: 5562
---
**Pi host capabilities match pi 1.3.0** — GSD declared Pi as a bun runtime with no reasoning-effort flag and knew 30 of its 41 extension events; the descriptor now records the Node runtime of the managed install, `--thinking <level>` as Pi's effort argument, and all 41 events, so `resolve-execution --host pi` renders `--thinking` instead of nothing. (#5557)
