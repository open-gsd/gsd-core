---
type: Changed
pr: 0
---
**An OpenCode install now points agents at `.opencode/skills/` and tells you to reinstall with `--opencode --global`** — the installed agents, skills and workflows named the Claude-only `.claude/skills/` project-skills path and a launcher error hint of `--claude --local`, and the post-install leak scan reported neither. Both are rewritten at install time for OpenCode only, and the scan now reports any that remain. (#4779)
