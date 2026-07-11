---
type: Added
pr: 2159
---
**GSD's lifecycle hooks now run under Kimi CLI** — installing GSD into Kimi wires its session-state, phase-boundary, graphify, and guard hooks into Kimi's own native `config.toml` `[[hooks]]` bus (Beta on Kimi's side) instead of silently no-op'ing, and GSD's Kimi subagents can now run in the background. Kimi's install is driven by its negotiated capability descriptor instead of hardcoded runtime special-cases. (#2095)
