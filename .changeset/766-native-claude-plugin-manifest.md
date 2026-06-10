---
type: Added
pr: 797
---
**gsd-core can now be installed as a native Claude Code plugin** — a new `.claude-plugin/plugin.json` manifest enables installing gsd-core via `claude plugin install` or the zero-friction `~/.claude/skills/` auto-load path (`gsd-core@skills-dir`), with slash commands auto-namespaced as `/gsd-core:<command>` (e.g. `/gsd-core:plan-phase`) and lifecycle management via `claude plugin enable|disable|update`. gsd-core's always-on guard and update hooks are wired for the plugin path through `hooks/hooks.json` using `${CLAUDE_PLUGIN_ROOT}`. This is additive — the existing npm / file-copy installer is unchanged.
