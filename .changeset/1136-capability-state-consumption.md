---
type: Changed
pr: 1153
---
**Capability hook rendering now consumes resolved Capability State** — `gsd-tools loop render-hooks` uses the same installed/surfaced/configured state reported by `gsd-tools capability state`, so disabling a migrated capability at the runtime surface removes its workflow hooks even when config defaults are enabled. Migrated capability config keys remain accepted through the generated capability registry/federated config path instead of duplicated central `VALID_CONFIG_KEYS` entries. (#1136)
