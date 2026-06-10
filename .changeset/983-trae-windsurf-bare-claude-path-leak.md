---
type: Fixed
pr: 0
---

**Trae and Windsurf installs no longer leak unreplaced `~/.claude` / `$HOME/.claude` paths** — both converters only rewrote trailing-slash `.claude/` forms, so bare home-path references survived conversion and pointed users at the wrong config dir; bare forms are now rewritten (Codex/Cline #570/#782 parity) and `CLAUDE_CONFIG_DIR` maps to the runtime's own var, with `.claude-plugin` preserved. (#983)
