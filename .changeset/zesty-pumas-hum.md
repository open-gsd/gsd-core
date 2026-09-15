---
type: Fixed
pr: 4760
---
**Codex rollback no longer leaves a partially-installed payload behind** — the installer's rollback snapshot now covers every file the previous install's manifest recorded (CHANGELOG.md, scripts/, .gsd-runtime, the manifest itself) plus the whole `hooks/` directory, instead of only config.toml, hooks.json, skills/, agents/ and VERSION, so a failed install reverts to the true pre-install state. (#4544)
