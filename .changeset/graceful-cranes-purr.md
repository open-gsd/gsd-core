---
type: Fixed
pr: 4833
---
**Checkpoint continuations are built from one prompt again** — `execute-phase`'s checkpoint step told the agent to spawn the continuation "using continuation-prompt.md template", but that template was removed in January 2026 and the reference was never updated, so for eight months every lane improvised the prompt around the four state values the step lists inline. The step now carries the prompt itself — a fenced skeleton with the same four placeholders, plus the fresh-agent warning that the completed tasks are not its own and each commit must be verified before continuing. (#4783)
