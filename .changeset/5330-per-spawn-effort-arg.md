---
type: Changed
pr: 5814
---
**Subagents on Claude Code now run at your project's effort settings without an `effort sync`** — when the loaded config has an `effort` block, workflows pass the resolved effort on each subagent spawn through the Agent tool's `effort` argument (Claude Code 2.1.292 or later); the agents' installed `effort:` frontmatter still applies everywhere else, including other runtimes. Runtime descriptors declare the channel as `spawnEffortParam`, and `resolve-model` gains an `effort_arg` field. (#5330)
