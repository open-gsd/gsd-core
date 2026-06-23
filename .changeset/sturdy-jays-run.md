---
type: Fixed
pr: 1410
---
**`query agent-skills` no longer returns empty output on Windows** — the plain (non-`--json`) path wrote the `<agent_skills>` block then immediately called `process.exit(0)`, which truncated the async stdout buffer on Windows pipes/files so every `${AGENT_SKILLS_*}` workflow capture expanded empty and configured per-agent skills were silently dropped. It now flushes synchronously via the same `writeAllSync` helper the `--json` path uses. (#1400)
