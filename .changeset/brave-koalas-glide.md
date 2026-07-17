---
type: Fixed
pr: 2386
---
**Cursor no longer shows every `/gsd-*` command twice** — a `--cursor` install wrote both a skill and a slash command for each action, so every GSD entry appeared twice in Cursor's `/` menu. GSD now installs Cursor skills as `user-invocable: false` (matching the existing CodeBuddy behavior), so the slash command is the single `/` entry point while skills remain model-invocable. (#2341)
