---
type: Fixed
pr: 5486
---
**A repeat `/gsd-pr-branch` publish no longer replays rounds whose merge it can prove** — it carries only the commits after the working-branch tip that the last merged build came from. It replaces a merged leftover `-pr` branch, and it refuses an unmerged one by name with a discard command. It also refuses a merged `-pr` that was amended or rebased after the build. When a build is recorded, each refusal also prints a re-anchor command. When the run cannot prove that the last build merged, or the history was rewritten, it warns and replays from the target (#5469).
