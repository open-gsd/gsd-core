---
type: Changed
pr: 0
---
**Agents list project skills through `skill-manifest` instead of reading skill files** — the 21 agents that discover `.claude/skills/` or `.agents/skills/` now run `gsd_run skill-manifest --skills-dir <dir>` for each directory that exists and open a `SKILL.md` body only when its description fits the task or is empty, so the size of the listing no longer depends on how long the skill bodies are; the frontmatter-only read stays as the fallback when the command fails. `skill-manifest` now lists a skill that is installed through a directory symlink, which it used to skip without a message, and `docs/CLI-TOOLS.md` documents its real flags (`--write`, `--skills-dir`) instead of a `--output` flag that does not exist. (#6719)
