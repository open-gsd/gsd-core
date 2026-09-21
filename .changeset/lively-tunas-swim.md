---
type: Fixed
pr: 0
---
**Codex agents with Write/Edit tool contracts now run under workspace-write** — the 17-role read-only hold is lifted: official OpenAI documentation establishes sandbox_mode as an enforced boundary, so each Codex agent's sandbox now derives purely from its own declared tools. (#4770)
