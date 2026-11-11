---
type: Fixed
pr: 5486
---
**A repeat `/gsd-pr-branch` publish no longer replays rounds you already published** — it carries only the commits after the working-branch tip that the last merged build came from, replaces a merged leftover `-pr`, and refuses an unmerged one, or a merged one changed after the build, by name with a discard command (and a re-anchor command when a build is recorded) (#5469).
