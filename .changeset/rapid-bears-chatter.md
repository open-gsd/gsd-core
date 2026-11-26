---
type: Changed
pr: 6720
---
**Spawned executor, planner and phase researcher read project skills by description** — the project-skills line in the execute-phase, plan-phase and quick spawn prompts and the research plan-pre fragment now asks for each SKILL.md's frontmatter first and the full file only when its description fits, matching the shared discovery reference instead of contradicting it. (#5248)
