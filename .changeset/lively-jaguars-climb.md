---
type: Fixed
pr: 5486
---
**A repeat `/gsd-pr-branch` publish no longer replays rounds you already published** — it carries only the commits after the last merged `-pr` tip, replaces a merged leftover `-pr`, and refuses an unmerged one, or one whose merge it cannot confirm, by name with re-anchor and discard commands (#5469).
