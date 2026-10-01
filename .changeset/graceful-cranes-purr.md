---
type: Fixed
pr: 4833
---
**Checkpoint continuations use a shipped prompt part** — `execute-phase` now routes the checkpoint handoff to `execute-phase/steps/checkpoint-continuation-prompt.md`, which holds the contracted placeholders and fresh-agent verification guidance without growing the host workflow. This replaces the obsolete bare template reference. (#4783)
