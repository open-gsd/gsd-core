# Project Skills Discovery

Before execution, find the project-defined skills that fit your task and apply them.

**Discovery steps (shared across all GSD agents):**
1. Check `.claude/skills/` or `.agents/skills/` directory — if neither exists, skip.
2. List available skills: the subdirectories that contain a `SKILL.md`, except GSD's own `gsd-*` directories.
3. If your agent file references `agent-skills-bootstrap.md`, its self-load already delivers the skills configured for your agent type. Run `gsd_run query config-get agent_skills.<YOUR-FRONTMATTER-NAME> --raw --default "[]"` to list them, separated by commas. Skip a skill from step 2 only when an entry, after dropping a leading `./` and a trailing `/`, equals its project-relative directory (for example `.claude/skills/<skill>`) and that directory's real path (symbolic links resolved) lies inside the project. Any other entry (`global:`, absolute, ending in `/SKILL.md`) or a failed command skips nothing.
4. For each remaining skill, read only the YAML frontmatter at the top of its `SKILL.md` (`name`, `description`). If a `SKILL.md` has no `description`, read it in full.
5. Read the full `SKILL.md` only for skills whose `description` fits the current task. A skill you did not read stays available: read its `SKILL.md` later if the task turns out to need it.
6. Load files a `SKILL.md` references (for example under `references/`, `scripts/`, or `rules/`) only when the task needs them.

**Application** — the calling agent's file states how its role applies the skills it loads.
