---
type: Fixed
pr: 1367
---
**Project-local Claude Code install now produces `/gsd-<cmd>` (hyphen) slash commands** — the installer was writing command files to `.claude/commands/gsd/<cmd>.md` (subdirectory with bare names), causing Claude Code to namespace them as `/gsd:<cmd>` (colon form). The fix writes flat `gsd-<cmd>.md` files at `.claude/commands/` level so Claude Code registers `/gsd-<cmd>` (hyphen form), matching hooks, statusline, and all cross-command references. Legacy `commands/gsd/` directories from prior installs are cleaned up on reinstall and uninstall, with `dev-preferences.md` preserved. (#1367)
