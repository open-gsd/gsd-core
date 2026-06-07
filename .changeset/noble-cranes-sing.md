---
type: Fixed
pr: 749
---
**Phase execution no longer halts with `exit 42` (worktree base mismatch) when run on a branch diverged from the default branch (#683).** Claude Code forks worktree-isolated executors off the repository default branch (`origin/HEAD`), so running `/gsd-execute-phase` on an unmerged milestone/feature branch left every executor without the phase's plan files and tripped the `worktree-branch-check` guard (100% reproducible, all OSes). Execute-phase now detects this before dispatch and automatically degrades to sequential execution on the main working tree, recommending the permanent fix `worktree.baseRef:"head"`. Fresh Claude Code installs set `worktree.baseRef:"head"` in `.claude/settings.local.json` (no-clobber); existing installs can apply it on demand via `gsd-tools worktree set-baseref`. The `exit 42` guard remains as a backstop.
