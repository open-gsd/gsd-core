---
type: Changed
pr: 0
---
**An OpenCode install now points agents at `.opencode/skills/` and tells you to reinstall with `--opencode --global`** — the installed agents, skills, workflows and the installed `gsd-core/commands|agents` copies named the Claude-only `.claude/skills/` project-skills path, a launcher error hint of `--claude --local` and `~/.claude` includes, and the post-install leak scan skipped the copies and reported neither new form. They are rewritten at install time for OpenCode only (the copies get path text only, so a refresh still converts them), and the scan now reports any that remain. (#4779)
