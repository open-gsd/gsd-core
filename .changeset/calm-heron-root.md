---
type: Changed
pr: 6071
---
**`gsd-tools commit` refuses to write outside the checkout it runs in** — a commit from a worktree now exits non-zero with `committed: false` and `reason: "outside_worktree"` when the working directory, a declared path, or the planning project it would write to lies outside that worktree, including a worktree inside a `planning.sub_repos` workspace whose `.planning/` belongs to the workspace; outside a repository it refuses with `not_git_repo`. Pass `--project-dir <checkout>` to commit in the checkout that owns the path. (#6043)
