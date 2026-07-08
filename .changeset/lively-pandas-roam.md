---
type: Fixed
pr: 2084
---
**`~/.gsd/defaults.json` `model_policy`, `model_profile_overrides`, and `runtime` are honored outside projects** — the global-defaults path silently dropped these keys, so a machine-wide model policy only took effect inside a project.
