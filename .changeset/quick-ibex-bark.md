---
type: Fixed
pr: 2314
---
**`claude_orchestration.enabled: true` now actually routes execute-phase waves through the Workflow backend** — the capability shipped registered-but-inert: nothing in `/gsd-execute-phase` ever called its backend detection, and the `execute:wave:pre` hook it needed was declared but never rendered, so enabling it had zero effect. execute-phase now renders `execute:wave:pre` before each wave and, when the capability is enabled and all gates pass, dispatches independent plans via the generated Workflow script; any gate miss or disabled config falls back to byte-identical inline dispatch. (#2285)
