---
type: Changed
pr: 6717
---
**Agents read each project skill's frontmatter before its body** — the 21 agents that discover `.claude/skills/` or `.agents/skills/` now read only each `SKILL.md` `name` and `description` and open the whole file when the description fits the task (or is missing), instead of reading every full `SKILL.md` on every spawn. A skill that was not read stays available, and the files a `SKILL.md` references load on demand. All 21 agents and 15 compact variants share one instruction, and the non-Claude converters no longer strip an AGENTS.md sentence, which left an empty numbered item on Codex, Copilot, Antigravity, Kimi, OpenCode and Kilo. The execute, plan and quick spawn prompts still ask for every SKILL.md; that part is tracked in #5248. (#4649)
