---
type: Added
pr: 1429
---
**Claude orchestration capability preflight** - adds the default-off `claude-orchestration` capability, `workflow.claude_orchestration*` config keys, a `check claude-orchestration.preflight` gate at `execute:wave:pre`, and `query claude-orchestration.status` for inspecting the Claude execution policy before spawning wave agents.
