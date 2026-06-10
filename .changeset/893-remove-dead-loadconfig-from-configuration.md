---
type: Changed
pr: 893
---
Remove dead `loadConfig` export from `configuration.cts` — superseded by `config-loader.cts` (ADR-857 phase 2e, #885). All live callers already import `loadConfig` from `config-loader.cjs` or the `core.cjs` back-compat re-export; exhaustive grep confirms zero callers importing it from `configuration.cjs`. `configuration.cjs` now provides only the pure normalization and defaults primitives (`normalizeLegacyKeys`, `mergeDefaults`, `migrateOnDisk`, `CONFIG_DEFAULTS`) that `config-loader.cjs` depends on. (#893)

<!-- docs-exempt: internal dead-code removal, no user-facing behavior change -->
