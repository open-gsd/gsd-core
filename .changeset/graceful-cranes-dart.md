---
type: Changed
pr: 769
---
**`/gsd-plan-phase`, `/gsd-execute-phase`, `/gsd-autonomous` now run in an isolated forked context on Claude Code** — `context: fork` in skill frontmatter protects the main session's context budget. These three heavy skills also declare `effort: xhigh`; quick-status skills `/gsd-progress` and `/gsd-stats` declare `effort: low`. The installer preserves both fields when converting commands to Claude SKILL.md files. Runtimes that do not recognise these fields silently ignore them — no behaviour change on non-Claude runtimes.
