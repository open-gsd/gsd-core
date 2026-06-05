---
type: Fixed
pr: 321
---
**`loadConfig` now clones config defaults with `structuredClone`** — avoids JSON round-trip fragility in defaults merging used by config loads and related tooling.
