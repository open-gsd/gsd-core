---
type: Fixed
pr: 0
---
**The executor stall check now sees a worktree executor's commits before the wave merges** — with `isolation="worktree"` an executor commits to its own unmerged agent branch and writes its SUMMARY there, so the `${EXPECTED_BRANCH}` probe read no progress and the pause (`continue waiting` / `kill and retry` / `kill and switch to inline execution`) fired for an executor that was committing normally; the stall surveillance now asks the evaluation-scope resolver for the plan's commits since dispatch across every local branch (a new opt-in `check evaluation-scope --all-branches`, plan and quick units only, which reports `latestCommitTime`) and a commit resets the no-progress clock, while sequential mode keeps its probe, the gates keep their reachable-from-ref contract, and an executor with no commits and no SUMMARY past the threshold still reaches the pause. (#6117)
