---
type: Fixed
pr: 0
---
**Workflow, agent and reference shell fences resolve project and workstream paths** — under `GSD_PROJECT=<name>` or a workstream, the fences now read and commit the scoped STATE, ROADMAP, REQUIREMENTS, phases, quick, milestone and config files instead of the root project's, and writer verbs in those fences forward the workstream token so a scoped tracking commit is no longer empty. (#5861)
