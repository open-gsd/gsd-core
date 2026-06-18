---
type: Fixed
pr: 6
---
**Milestone handoff now archives completed non-backlog phase directories before clearing active phases** — `phases clear` fails closed unless archived parity is proven, preserving `999.x` backlog work and requiring `--confirm --force` for intentional unarchived deletion. (#5)
