---
type: Fixed
pr: 0
---
**Clearing the chaining flag no longer modifies a committed `.planning/config.json` that lacks it** — every plan-phase, execute-phase and transition run clears `workflow._auto_chain_active`, and in a project created without `--auto` that wrote the key (`false`, which absent already means) and left the tracked config dirty. `config-set workflow._auto_chain_active false` now leaves the file untouched when the key is absent; clearing a stale `true`, setting `true`, and every other `config-set` still write. (#6124)
