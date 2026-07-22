---
type: Added
pr: 0
---
**`--kimi-code --global` now installs a working Agent Skills surface at `~/.kimi-code/skills/gsd-*/SKILL.md`** — previously the kimi-code descriptor (Phase 1) carried an empty `artifactLayout`, so the install produced zero skills and Kimi Code's `merge_all_available_skills = true` auto-discovery found nothing. Phase 2 adds the `convertClaudeCommandToKimiCodeSkill` converter, fills the descriptor's `artifactLayout.global` with the skills kind entry, and removes the Phase 1 `SKIP_INSTALL_CONTRACT` skip by setting the install contract surface to `flat-skills` (NOT `kimi-skills-agents` — Kimi Code has no custom agents). Kimi Code auto-discovers the skills on next launch; no `agents/gsd.yaml` or `subagents/*.yaml` installed. (#2509)
