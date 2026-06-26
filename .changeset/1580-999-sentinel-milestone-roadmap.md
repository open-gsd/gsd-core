---
type: Fixed
pr: 1691
---
`milestone complete` and `roadmap analyze` now exclude the Phase 0 / Phase 999 backlog sentinels. A milestone whose only directory-less ROADMAP heading is a backlog sentinel can be completed without `--force`, and `roadmap analyze` no longer counts the sentinel in `phase_count` or routes `next_phase` into it. Completes the `^999` exclusion #1445 added to the progress denominators.
