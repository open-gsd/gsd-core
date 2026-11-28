# Why PR-branch filtering has a strict mode

> Explanation. The behavior of `/gsd-pr-branch` is in the
> [PR Branch Filtering feature entry](../FEATURES.md); the procedure is in
> [Publish PRs without planning artifacts](../how-to/publish-prs-without-planning-artifacts.md).

## Why strict mode exists

Strict mode exists because the two ways to keep planning private are not equivalent. Turning off `planning.commit_docs` keeps `.planning/` out of git, which also takes parallel executor worktrees with it — a worktree is checked out from a commit, so an untracked planning tree is simply absent inside it and the executor has no `PLAN.md` to read. Strict mode leaves planning committed, so worktrees and revert paths keep working, and moves the guarantee to the publication boundary instead. See [Publish PRs without planning artifacts](../how-to/publish-prs-without-planning-artifacts.md).

## Why filtering forces paths back instead of un-staging

Both modes filter by forcing the excluded paths back to whatever the target branch already tracks, in the index *and* the working tree. Un-staging alone would record a deletion of any planning file the target branch carries, and would leave the picked file untracked on disk, where it makes a later cherry-pick of the same path abort.
