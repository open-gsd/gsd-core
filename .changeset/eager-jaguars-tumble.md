---
type: Fixed
pr: 5283
---
**`evaluation-scope --plan` no longer reports an empty scope for a project-coded plan id** — a plan id carrying the project's configured `project_code` (`PRJ-01-01`) now resolves that plan's own commits in either spelling (`feat(PRJ-01-01):` and `feat(01-01):`) instead of matching literally against a subject no executor commit ever carries, which reported an empty scope at exit 0 for a plan that has already started. Only the CONFIGURED code is stripped: an id that merely looks coded (`AUTH-01-02`, `setup-1-2`) is still matched literally and so can never resolve another plan's commits. When no `project_code` is configured every id keeps its previous literal behaviour.
