---
type: Changed
pr: 5778
---
**ROADMAP phase-list entries are read with one grammar everywhere** — `validate`, `roadmap analyze`, `roadmap get-phase`, `phase insert`, `phase next-decimal` and `phase complete` now agree on `-` or `*` bullets, `[x]` or `[X]`, and `**` or `__` bold, so an entry one command could see no longer vanishes from another; an entry must start its line. (#5763)
