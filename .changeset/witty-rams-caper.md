---
type: Deprecated
pr: 6070
---
**claude_orchestration.min_agent_sdk_version is deprecated and ignored** — the Workflow backend no longer gates on the Agent SDK version, so the key, the --agent-sdk-version flag and GSD_AGENT_SDK_VERSION have no effect; existing configs still load, and the key can be removed. (#4747)
