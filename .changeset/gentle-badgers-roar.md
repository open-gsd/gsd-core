---
type: Fixed
pr: 2048
---
**`model_overrides` Claude model IDs now resolve to Agent-tool aliases on the claude runtime** — a full Claude model ID (e.g. `claude-sonnet-5`) in `model_overrides` was returned verbatim and silently dropped by the Claude Agent tool (whose `model` parameter documents only tier aliases), causing the spawned subagent to inherit the parent session model instead of the configured one. It now maps to the tier alias (`sonnet`/`opus`/`haiku`/`fable`), consistent with the `model_policy` path (#1144). Bare aliases, non-Claude values, and non-Claude runtimes are unchanged; a Claude ID with no alias warns once and falls through to tier resolution. (#2041)
