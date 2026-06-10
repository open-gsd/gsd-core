---
type: Fixed
pr: 924
---
**Claude global install reverted to flat skill layout so concrete skills are discoverable.** PR #883 introduced nested skill layout for Claude (`~/.claude/skills/gsd-ns-<router>/skills/<stem>/SKILL.md`), but Claude Code's skill discovery scans only one level under `~/.claude/skills/` — nested concrete skills were never listed in the Skill-tool available-skills list and direct `Skill(skill="gsd-plan-phase")` calls stopped working. This fix reverts Claude to the flat layout (`~/.claude/skills/gsd-<name>/SKILL.md`) so all ~61 concrete skills are top-level and immediately discoverable. The 6 other runtimes that confirmed non-recursive scanning (cline, qwen, hermes, augment, trae, antigravity) retain their nested layout. (#924)
