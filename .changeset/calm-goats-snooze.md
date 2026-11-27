---
type: Changed
pr: 0
---
**Capability consent and the project capability overlay use the resolved project root** — from a linked worktree with no `.planning/` of its own, project-scope consent and the project overlay now resolve to the main checkout instead of the worktree directory, matching where `.planning/` and the rest of the project live; consent recorded from such a worktree before this release is no longer found and the capability asks for consent again. The `verification` verbs also take their project root from the resolved context, so `--project-dir` reaches them without a process-wide global. (#6820)
