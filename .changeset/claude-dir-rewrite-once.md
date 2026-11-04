---
type: Fixed
pr: 0
---
**Installs into a nested or unusually named config directory keep correct paths** — the installer rewrote ~/.claude references in several passes, so a config dir such as ~/.claude/profiles/work or ~/.claude.d was rewritten again inside its own output; each reference is now rewritten once, in every runtime profile including qwen, hermes and Trae. Two pre-existing path bugs are fixed in the same pass: Windsurf global installs turned `~/.devin/skills/x` and `$HOME/.devin/skills/x` into `~/$HOME/.codeium/windsurf/skills/x` and `$HOME/$HOME/...` (now `$HOME/.codeium/windsurf/skills/x`), and Claude Code's own files such as `~/.claude.json`, `$HOME/.claude.json`, `~/.claude-plugin` and `./.claude-plugin` were rewritten into nonexistent names like `$HOME/.cline.json` (they now stay unchanged). Other default-install output is unchanged. (#5715)
