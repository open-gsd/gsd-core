---
type: Fixed
pr: 2436
---
**Codex local installs no longer write GSD skills into the global user scope** — `--codex --local` previously installed skills under `$HOME/.agents/skills`; it now installs them under `<project>/.codex/skills`, while global Codex installs remain unchanged. (#2429)
