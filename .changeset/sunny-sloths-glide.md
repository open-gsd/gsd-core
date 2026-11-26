---
type: Fixed
pr: 6714
---
**A correct core or standard install no longer reports degraded health, and the `intel` capability now claims `gsd-intel-updater`** — `validate health` (W010) expected every catalog agent even when the install profile deliberately stages only the agents its skills spawn, so an untouched tiered install listed the omitted agents as missing; it now expects only the agents the `.gsd-profile` marker stages, a full install still reports a genuinely missing agent, and the agent the `intel` description names is now listed in that capability's `agents` array so the registry matches. (#6714)
