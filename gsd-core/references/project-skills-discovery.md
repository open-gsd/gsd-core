# Project Skills Discovery

Before execution, check for project-defined skills and apply their rules.

**Discovery steps (shared across all GSD agents):**
1. Check `.claude/skills/` and `.agents/skills/` — if neither exists, skip.
2. For each one that exists, run `gsd_run skill-manifest --skills-dir <dir>` (define `gsd_run` first with the launcher in `~/.claude/gsd-core/references/gsd-run-resolver.md`, in the same bash call). It lists each skill's `name`, `description` and `file_path` (the file is `<dir>/<file_path>`), and no skill body. An empty list means no skills.
3. Read a skill's whole `SKILL.md` only when its `description` fits the task, or it has no `description`.
4. If the launcher or the command fails, list the subdirectories and read only the frontmatter (`name`, `description`) of each `SKILL.md`.
5. A skill you did not read in full stays available: read it when the task turns to its topic.
6. Load files a `SKILL.md` references (for example under `references/`, `scripts/`, or `rules/`) only as the task needs them.

**Application** — how to apply the loaded rules depends on the calling agent:
- Planners account for project skill patterns and conventions in the plan.
- Executors follow skill rules relevant to the task being implemented.
- Researchers ensure research output accounts for project skill patterns.
- Verifiers apply skill rules when scanning for anti-patterns and verifying quality.
- Debuggers follow skill rules relevant to the bug being investigated and the fix being applied.

The caller's agent file should specify which application applies.
