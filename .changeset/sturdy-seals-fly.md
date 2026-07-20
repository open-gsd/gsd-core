---
type: Fixed
pr: 0
---
**`~/.gsd/defaults.json` no longer silently drops `model_policy`, `model_profile_overrides`, and `runtime`** — the global-defaults path of config load now forwards these three keys identically to a project's `.planning/config.json`, so a machine-wide model policy / runtime / overrides specified globally is honored even outside a project. (#2069)
