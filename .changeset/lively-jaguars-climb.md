---
type: Fixed
pr: 5486
---
**`/gsd-pr-branch` replays only commits after the last published tip and handles an existing `-pr` branch** — the last built tip becomes the published marker `refs/gsd/pr-published/<mode>/<target>/<working-branch>` once its `-pr` branch is merged (by ancestry, by matching content after a squash or rebase merge, or, where `gh` and a `timeout` binary exist, by a merged PR whose head was that tip), a merged leftover `-pr` is replaced and an unmerged one is refused with re-anchor and discard commands, and on a host without `timeout` (stock macOS) a squash merge whose files the target has since edited cannot be proven and is replayed (#5469).
