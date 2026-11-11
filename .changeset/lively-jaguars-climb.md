---
type: Fixed
pr: 5486
---
**A repeat `/gsd-pr-branch` publish no longer replays rounds whose merge it can prove** — it carries only the commits after the working-branch tip that the last merged build came from. It replaces a merged leftover `-pr` branch, and it refuses an unmerged one by name with a discard command. It also refuses a merged `-pr` whose pending build it cannot prove merged, such as an amended build whose content the target lacks. When the pending build is not proven merged, a refusal also prints a re-anchor command. When history is rewritten without a match, or a build cannot be proven merged, it warns and replays from the last published tip or the target (#5469).
