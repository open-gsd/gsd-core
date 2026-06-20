---
type: Fixed
pr: 1487
---
**`/gsd-surface` works on Claude Code global installs** — the installer now writes a `.gsd-source` marker and install-exports resolve in the deployed layout, so `list`/`status` and `profile`/`enable`/`disable`/`reset` no longer throw `could not locate commands/gsd` or `MODULE_NOT_FOUND`.
