---
type: Changed
pr: 5800
---
**ROADMAP phase-list entries are rewritten with the same grammar they are read with** — `phase complete`, `phase remove`, `roadmap update-plan-progress` and `roadmap upgrade` now find, tick, delete, renumber and rewrite an entry in every form the readers accept (`*` bullets, `[X]`, `__` bold, an indented entry), so an entry a command could read no longer survives a rewrite untouched. A mention of a phase in the middle of a line is no longer deleted or renumbered by `phase remove`, and `phase complete` keeps an indented entry's indent. A bullet with no space after its marker (`-[ ] Phase 1`) is no longer an entry, and the plan rows `roadmap update-plan-progress` treats as nested under an entry now end at a less-indented line. (#5764)
