---
type: Fixed
pr: 0
---
**Workflows no longer run a foreign or outdated `gsd_run` from PATH** — the runtime launcher now resolves a project-local or runtime-config-directory install ahead of PATH, and a PATH `gsd_run` is used only when it proves it is @opengsd/gsd-core, so a leftover global install can no longer shadow a local one and trip the pre-commit branch guard. (#4834)
