---
type: Added
pr: 0
---
**Qoder runtime support** — register Qoder as the 17th supported runtime in the GSD Core installer. `node bin/install.js --global --qoder` installs GSD skills to `~/.qoder/skills/` and agents to `~/.qoder/agents/` using the `profile-marker-only` install surface (identical shape to Trae/Windsurf). Automatic path conversion rewrites `.claude/` → `.qoder/`, `CLAUDE.md` → `AGENTS.md`, and `Claude Code` → `Qoder`. Bare-form `.claude` references (`~/.claude`, `$HOME/.claude`, `./.claude`) are handled in the Qoder-specific converter with Cline-style word boundaries to preserve `CLAUDE_CONFIG_DIR`-style environment variable names.
