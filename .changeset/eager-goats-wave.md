---
type: Fixed
pr: 6085
---
**Commit gates no longer halt in `planning.sub_repos` workspaces** — `check evaluation-scope` returned `unresolvable` (exit 69) whenever the workspace root was not a git repo, so the safe-resume gate, the TDD gate and the executor commit spot-check stopped `/gsd-execute-phase`. The resolver now reads each configured sub-repo and merges the commits newest first. (#5867)
