---
type: Fixed
pr: 5928
---
**Verifier no longer drops pre-verified human checks** — an auto task's `<human-check>` whose `<expected>` already recorded a verdict could be omitted from the end-of-phase human verification list; every such block is now harvested with its expected text unchanged. (#5741)
