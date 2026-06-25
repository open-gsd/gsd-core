---
type: Fixed
pr: 1487
---
**`/gsd-surface` (`list`/`status`) works on Claude Code global installs** — the installer now writes a `.gsd-source` marker pointing at its `commands/gsd` source, so `findInstallSourceRoot` resolves on the global skills layout (which ships no `commands/gsd` tree) instead of throwing `could not locate commands/gsd`. (#1487)
