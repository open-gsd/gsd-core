---
type: Fixed
pr: 1845
---
**Roadmap phase lookup now ignores fenced examples and the backlog sentinel lane** — `roadmap get-phase` and `init plan-phase` no longer return fenced sample headings as real phases or treat `999.x` backlog items as active milestone work. (#1845)
