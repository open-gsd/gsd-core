---
type: Fixed
pr: 5486
---
**A repeat `/gsd-pr-branch` publish no longer replays rounds whose merge it can prove** — it carries only the commits after the working-branch tip that the last merged build came from. A build counts as merged by ancestry. It also counts after a squash or rebase merge, and when `gh` reports a merged PR although the target has since edited those paths. A merged leftover `-pr` branch is replaced. An unmerged one is refused by name, with a discard command. A merged `-pr` that holds commits after a pending build it cannot prove merged is also refused, with a re-anchor command. An amended build whose content the target lacks is such a case. The run warns and replays from the last published tip or the target in two cases. History was rewritten without a match. Or a build with no later commits cannot be proven merged. A failed or timed-out read of the built `-pr` branch now stops the run before its checks pass on an empty list (#5469).
