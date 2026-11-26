# Project Skills Discovery

Before execution, check for project-defined skills and apply their rules.

**Discovery steps (shared across all GSD agents):**
1. Check `.claude/skills/` or `.agents/skills/` directory — if neither exists, skip.
2. List available skills (subdirectories).
3. Read only the frontmatter (`name`, `description`) of each skill's `SKILL.md`. Read the whole file only when its `description` fits the task, or when it has no `description`.
4. A skill you did not read in full stays available: read it when the task turns to its topic.
5. Load files a `SKILL.md` references (for example under `references/`, `scripts/`, or `rules/`) only as the task needs them.

**Application** — how to apply the loaded rules depends on the calling agent:
- Planners account for project skill patterns and conventions in the plan.
- Executors follow skill rules relevant to the task being implemented.
- Researchers ensure research output accounts for project skill patterns.
- Verifiers apply skill rules when scanning for anti-patterns and verifying quality.
- Debuggers follow skill rules relevant to the bug being investigated and the fix being applied.

The caller's agent file should specify which application applies.
