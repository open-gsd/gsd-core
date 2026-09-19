---
type: Fixed
pr: 0
---
**Claude installs no longer stage the 29 compact agent variants** — agents/*.compact.md shipped beside their canonical siblings with identical name frontmatter, leaving the harness's pick unstated; Claude never selects compact (it is a non-Claude-runtime payload), so the Claude agents directory now holds only the canonical agents, and upgrading removes the stale copies. (#4782)
