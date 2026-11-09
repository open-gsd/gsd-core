---
type: Fixed
pr: 5994
---
**The planner now reads MemPalace recall when planning a phase** — with the mempalace capability enabled, the `MEMORY-RECALL.md` file the `plan:pre` recall step writes into the phase directory was never named in the planner's required reading, so prior decisions, patterns and surprises recalled from the palace never reached planning. The planner is now told to read it whenever it exists; phases without it plan as before. (#5960)
