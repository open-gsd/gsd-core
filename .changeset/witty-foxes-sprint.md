---
type: Fixed
pr: 0
---
**Agent dispatch no longer blocks on a project root that is not a git repository** — `worktree.base-check` now degrades to sequential when git definitively reports no repository, and the isolation guard's stale-sentinel fallback no longer demands `isolation="worktree"` where no worktree can be created (multi-repo workspace roots). Repos with a real HEAD behave exactly as before. (#4734)
