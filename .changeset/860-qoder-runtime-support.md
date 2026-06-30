---
type: Added
pr: 1021
---
**Qoder runtime support** — register Qoder as the 17th supported runtime in the GSD Core installer. `node bin/install.js --global --qoder` installs GSD skills to `~/.qoder/skills/` and agents to `~/.qoder/agents/` using the `settings-json` install surface. GSD-managed hooks (prompt-guard, context-monitor, read-injection-scanner, worktree-path-guard, etc.) are registered in `~/.qoder/settings.json` (global) or `.qoder/settings.json` (local) via the `settings-json` hook surface with the Claude hook event dialect (`hookEvents: "claude"`, `extendedHookEvents: ["Stop"]`). Automatic path conversion rewrites `.claude/` → `.qoder/`, `CLAUDE.md` → `AGENTS.md`, and `Claude Code` → `Qoder`. Bare-form `.claude` references (`~/.claude`, `$HOME/.claude`, `./.claude`) are handled in the Qoder-specific converter with Cline-style word boundaries to preserve `CLAUDE_CONFIG_DIR`-style environment variable names.
