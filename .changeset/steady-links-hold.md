---
type: Fixed
pr: 5877
---
**A symlinked Codex `config.toml` keeps its link when GSD content is stripped from it** — uninstall, and an install whose profile registers no Codex agent roles, deleted a GSD-only `config.toml`, which removed the dotfiles link and left the GSD block in the file it pointed at; with `GSD_ALLOW_SYMLINKED_DEST=1` the link now stays and its target is emptied, and without the opt-in both refuse a symlinked `config.toml` they would write. (#5716)
