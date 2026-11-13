---
type: Fixed
pr: 5959
---
**A symlinked Codex `config.toml` keeps its link when GSD content is stripped from it** — uninstall, and an install whose profile registers no Codex agent roles, deleted a GSD-only `config.toml`, which removed the dotfiles link and left the GSD block in the file it pointed at. With `GSD_ALLOW_SYMLINKED_DEST=1` the link now stays and its target is emptied, and a later uninstall leaves an emptied target alone. Without the opt-in both refuse a symlinked `config.toml` they would write, and they refuse before changing anything else, so a refused run leaves the install as it was. With the opt-in, uninstall also refuses up front a link whose target file is read-only, instead of failing after removing GSD's files. (#5716)
