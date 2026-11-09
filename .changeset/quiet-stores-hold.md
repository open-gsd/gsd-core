---
type: Fixed
pr: 5510
---
**Gates now accept phase directories under a symlinked out-of-repo .planning** — check decision-coverage-plan, decision-coverage-verify, gap-analysis-plan-post, evaluation-scope and predicate --phase-dir no longer fail with "path escapes its allowed directory", and check verify-command-paths --dir no longer reports its unresolvable "--dir resolves outside the project root" result, for a phase directory under the project's own .planning; all six resolve their path argument through the shared containment helper, and paths outside the project and its own .planning are still refused. check tdd-red-evidence keeps its own single-root check and is not changed (#5474).
