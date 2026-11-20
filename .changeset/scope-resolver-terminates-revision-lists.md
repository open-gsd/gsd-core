---
type: Fixed
pr: 0
---
**Evaluation-scope resolution no longer fails when a root file is named like a commit id** — the resolver's `log` and `rev-list` calls that take commit ids now end them with `--`, so a repository-root file named like a task commit's sha is no longer read as a path (git exit 128), and every gate that shares the scope resolves instead of reporting it unresolvable. (#6179)
