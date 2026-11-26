---
type: Fixed
pr: 0
---
**Seven documentation links that resolved to nothing now resolve** — `docs/FEATURES.md` linked a sibling fragment file, `docs/docs/CONFIGURATION.md`, and four `gsd-core/references/` files with the wrong number of `../`, and `docs/USER-GUIDE.md` linked `../explanation/security-model.md`; the fragments under `docs/features/` are corrected and `FEATURES.md` regenerated. (#6741)
