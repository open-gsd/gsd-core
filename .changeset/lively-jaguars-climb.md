---
type: Fixed
pr: 5486
---
**A repeat `/gsd-pr-branch` publish no longer replays rounds whose merge it can prove** — it carries only the commits after the working-branch tip that the last merged build came from. A build counts as merged by ancestry, by content after a squash or rebase merge, or by a merged PR that `gh` reports when the target has since edited those paths. It replaces a merged leftover `-pr` branch, and it refuses an unmerged one by name with a discard command. It also refuses a merged `-pr` that holds commits after a pending build it cannot prove merged, such as an amended build whose content the target lacks, and the refusal prints a re-anchor command. When history is rewritten without a match, or a build with no later commits cannot be proven merged, it warns and replays from the last published tip or the target. A failed or timed-out read of the built `-pr` branch now stops the run before its checks pass on an empty list (#5469).
