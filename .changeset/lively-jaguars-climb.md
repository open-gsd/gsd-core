---
type: Fixed
pr: 5486
---
**A repeat `/gsd-pr-branch` publish no longer replays rounds whose merge it can prove** — each publish replayed every commit after the target, including rounds an earlier merged build had already sent, so a second PR repeated the first; it now carries only the commits after the working-branch tip that the last merged build came from. (#5469)
