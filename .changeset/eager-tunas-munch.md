---
type: Added
pr: 5575
---
**Pi can run GSD agent roles** — Pi has no subagent primitive, so GSD workflows stopped at every `gsd-*` agent step. The Pi install now adds a `gsd_dispatch` tool that runs an installed role in an isolated child `pi` process, installs the roles under the Pi config home (without the `.compact.md` variants), and rewrites workflow `Agent(...)` calls to `gsd_dispatch(role=..., task=...)`. Dispatch is one level deep, so `/gsd-debug` reports that it is unsupported on Pi. (#5569)
