---
type: Fixed
pr: 1376
---
**Misconfigured agent skills no longer fail silently** — when an agent's configured `agent_skills` paths all fail to resolve (e.g. a missing `SKILL.md`), `gsd-tools query agent-skills` now emits an aggregate warning to stderr and adds a `warnings[]` field to its `--json` output, instead of returning an empty block with no signal. (#1376)
