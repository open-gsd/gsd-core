---
type: Changed
pr: 1868
---
**GSD subagents now self-load configured agent_skills regardless of orchestrator bash** — projects that map skills via `.planning/config.json` `agent_skills.<agent-type>` no longer silently lose them on `/gsd-autonomous` or Cursor, where `Skill()`-delegated workflow bash init did not reliably run. Each of the 22 consumer agents queries its own type at init and reads the listed skills, with a dedup guard so runtimes that also inject orchestrator-side (Claude Code) never carry two copies. (#1866)
