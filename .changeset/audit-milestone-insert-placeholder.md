---
type: Fixed
pr: 5440
---
**The milestone audit's closure chain now targets the inserted phase** — after `/gsd:phase --insert <after-phase>`, the printed `/gsd:discuss-phase`, `/gsd:plan-phase` and `/gsd:execute-phase` lines use `<new-phase>`, the number the insert prints, instead of reusing the insert's argument, which resolved cleanly to the existing phase and left the closure phase empty. (#5287)
