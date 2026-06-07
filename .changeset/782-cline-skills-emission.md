---
type: Changed
pr: 809
---
**Cline global installs now emit skills, not just rules:** gsd writes skills to `~/.cline/skills/<name>/SKILL.md` for Cline ≥ v3.48.0 (see [Cline skills docs](https://docs.cline.bot/customization/skills)), in addition to the existing `.clinerules` file. Each `SKILL.md` carries `name`/`description` frontmatter (agentskills.io) with paths rewritten to the `.cline/` convention. Local installs remain `.clinerules`-only. The `.clinerules` rules file continues to be emitted for compatibility, and upgrading over an existing rules-only install emits the new skills on the next run.
