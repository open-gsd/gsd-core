---
type: Added
pr: 703
---
`/gsd:plan-phase` now accepts a `--granularity <coarse|standard|fine>` flag to override the configured planning granularity for a single invocation. The flag takes precedence over `granularities.planning`, top-level `granularity`, and `planning.granularity` config. Invalid values are rejected. (#703)
