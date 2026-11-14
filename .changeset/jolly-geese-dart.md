---
type: Changed
pr: 0
---
**`resolve_model_ids: "omit"` no longer strips profile routing on Claude Code** — with an explicit project `"omit"`, every agent spawned with a blank model, so Claude Code ran it on `CLAUDE_CODE_SUBAGENT_MODEL` or the session model and a mapper profiled to a cheap tier ran on the orchestrator tier. On runtimes that accept tier aliases, `resolve-model` and the `init` payloads now return the profile tier alias (`opus` / `sonnet` / `haiku`) under `"omit"`, and `dynamic_routing` escalates by those aliases instead of `tier_models` IDs; every other runtime keeps the blank. (#3703)
