---
type: Changed
pr: 4742
---
**A workflow can no longer declare a loop-host agent role belonging to another step family** — the Loop Host Contract assigns each of the five loop steps a role family (orchestration, planning, execution), but nothing enforced it: adding `orchestrator` to an execute step `agent-roles` line compiled cleanly, and capability contributions could then target the orchestrator at execution points. Contract generation now rejects a cross-family role, a role outside the vocabulary, and an unknown step, reporting every offender rather than the first. No existing workflow or capability changes. (#4740)
