---
type: Fixed
pr: 5510
---
**Gates now accept phase directories under a symlinked out-of-repo .planning** — check decision-coverage-plan, decision-coverage-verify, gap-analysis-plan-post, verify-command-paths --dir, evaluation-scope and predicate --phase-dir resolve their path argument through the shared containment helper and no longer fail with "path escapes its allowed directory"; paths outside the project and its own .planning are still refused. check tdd-red-evidence keeps its own single-root check and is not changed (#5474).
