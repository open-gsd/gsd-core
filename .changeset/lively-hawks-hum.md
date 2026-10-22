---
type: Fixed
pr: 5632
---
**`--minimal` / `--profile=core` installs now stage the agents their skills spawn** — `/gsd-new-project`, `/gsd-plan-phase` and `/gsd-execute-phase` failed with "agent type not found" because a core install staged no agents. The core skill set is unchanged, and Codex registers the same agents as every other runtime. (#5503)
