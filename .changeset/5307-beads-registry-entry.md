---
type: Added
pr: 5384
---
**The Community Capability Registry now lists Beads Lifecycle** — discover the independently maintained `davdittrich/gsd-beads` capability, which syncs plan tasks into Beads (`bd`) issues, closes them after each wave, and blocks `/gsd-ship` while `blocking_open` or `diverged` is not 0 (its `ship:pre` gate also blocks while `bd` is missing, unless `beads.ship_gate` is false), with exact install and uninstall commands. (#5307)
