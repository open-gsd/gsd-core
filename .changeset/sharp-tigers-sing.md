---
type: Security
pr: 4666
---
**Path containment at every boundary that takes a directory or filename from the command line** — `todo complete` followed a traversal name outside the todos root and moved the file it found there, `check predicate --phase-dir` let a blocking gate return a passing verdict on evidence from a directory the caller chose, and the shared `resolvePath` helper — used by `check decision-coverage-plan` and `check gap-analysis.plan-post` — accepted a phase directory outside the project. All boundaries now validate against their managed root and reject with a usage error before touching the filesystem. (#4327, #4354)
