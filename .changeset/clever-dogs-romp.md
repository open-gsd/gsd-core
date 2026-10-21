---
type: Fixed
pr: 5579
---
**`/gsd-verify-work` auto-diagnosis spawns `gsd-debugger` with a defined prompt again** — `diagnose-issues` told the orchestrator to fill a `debug-subagent-prompt` template that no longer ships, so it improvised the prompt and could omit the pre-filled-symptoms flag and the debug-session file target. The prompt is now spelled out inline in the workflow. (#5203)
