---
type: Fixed
pr: 1632
---
**`config-set` now rejects invalid config values instead of storing them silently** — out-of-enum strings, JSON array/object coercion (e.g. `["high"]` stored as an array in a scalar key), and wrong-typed values for capability-registry-owned keys are validated against each key's declared schema at set time. Previously these were accepted and persisted, mis-configuring GSD. (#1628)
