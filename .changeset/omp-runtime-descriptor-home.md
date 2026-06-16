---
type: Changed
pr: 3
---
**OMP installs now use the descriptor-driven runtime registry and current Oh My Pi agent-home semantics** — `--omp` installs commands, nested skills, agents, raw rules, and the `gsd-core` extension through the generated capability registry. Global OMP installs honor `PI_CODING_AGENT_DIR`, `PI_CONFIG_DIR`, `OMP_PROFILE`, and `PI_PROFILE` instead of the removed `OMP_CONFIG_DIR` path.
