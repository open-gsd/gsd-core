---
type: Fixed
pr: 0
---
**Installs into a nested or unusually named config directory keep correct paths** — the installer rewrote ~/.claude references in several passes, so a config dir such as ~/.claude/profiles/work or ~/.claude.d was rewritten again inside its own output; each reference is now rewritten once, in every runtime profile including qwen, hermes and Trae, and default installs are unchanged. (#5715)
