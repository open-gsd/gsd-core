---
type: Fixed
pr: 4848
---
**`/gsd:undo --phase` and `--plan` no longer decide which commits to revert with a regex built from the id** — both selectors interpolated the requested id into an unanchored pattern over `git log --oneline` text, so `--phase 23.1.2` also reverted phase `23.112`, `--phase 03+` silently targeted phase 03, and a commit that merely quoted `feat(03-01):` in its subject was reverted with it, while `feat(03-01)!:` was left behind. Selection now reads the scope each commit declares through the repository's one conventional-commit header matcher and compares it to the id as a value; `fixup!`, `squash!`, `amend!`, `Revert "` and `Reapply "` subjects are selected with the commit they wrap, so reverting the selection no longer leaves their half of the phase in the tree. A commit whose subject declares no scope — a `git merge --squash` commit, for one — is still not selected, as before. (#4661)
