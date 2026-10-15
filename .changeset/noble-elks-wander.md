---
type: Changed
pr: 5079
---
**GSD's project-skills discovery now reads only the skills that fit the task** — the 21 discovery agents used to read every project `SKILL.md` in full on every spawn, following steps written for one skill pack (gsd-build/get-shit-done#672). The steps now live only in `references/project-skills-discovery.md` and follow the Agent Skills progressive-disclosure model: each skill's frontmatter first, the full `SKILL.md` only when its `description` fits the task, and referenced files only when the task needs them. GSD's own `gsd-*` skills are skipped, and agents that self-load `agent_skills` skip the project skills configured for their type where they can run `gsd_run`. The execute, plan and quick workflows still tell the executor, planner and phase researcher to read every `SKILL.md`; this change leaves those spawn prompts unchanged. (#4649)
