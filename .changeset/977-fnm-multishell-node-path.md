---
type: Fixed
pr: 0
---
**The installer now resolves a stable fnm node path instead of the ephemeral multishell shim on Windows** — managed `.js` hooks were pinned to `fnm_multishells/<id>/node.exe`, a per-shell-session path fnm later deletes, breaking every managed hook until reinstall. (#977)
