---
type: Added
pr: 0
---
**Opt-in advisor pre-filter before review gates** — with `workflow.advisor_prefilter` on, the orchestrator asks the Claude Code session advisor whether the phase output is final and consistent before the next review gate, so a reviewer subagent no longer spends its pass on output that changed after the last review. Off by default; a silent no-op when no advisor is configured. (#4795)
