---
type: Added
pr: 1597
---
**Plugin installs now expose GSD skills** — when GSD is installed as a Claude Code plugin (`claude plugin install`), its skills are available via `gsd-core:<skill>` the native way. Previously, plugin-only installs lacked the skill surface because `bin/install.js` never ran; agents that preload `global:gsd-core:<skill>` (PR #1261) now resolve against plugin-provided skills. (#1596)
