---
type: Fixed
pr: 0
---
**`/gsd-pr-branch origin/main` hands `gh` the branch name, not the remote ref** — the printed `gh pr create --base` hint and the sub-repo companion PR used the target verbatim, so a remote-qualified target produced `--base origin/main`; both now use the bare branch name derived once from the target by removing a leading configured-remote name, while git operations keep the full ref. (#5972)
