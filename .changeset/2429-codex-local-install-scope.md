---
type: Fixed
pr: 2553
---
**Codex `--local` installation no longer writes skills to `$HOME/.agents/skills`** — the skills-kind `home` override (which redirects skills to the user-global `.agents` directory) is now only applied for `--global` scope. When `--local` is specified, skills are installed under the project-local config directory, matching the scope the user selected. Previously, a `--local` Codex install created a split installation: project-local config but user-global skills. (#2429)
