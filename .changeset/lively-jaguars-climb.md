---
type: Fixed
pr: 5486
---
**A repeat `/gsd-pr-branch` publish no longer replays rounds whose merge it can prove** — it carries only the commits after the working-branch tip that the last merged build came from (#5469).
