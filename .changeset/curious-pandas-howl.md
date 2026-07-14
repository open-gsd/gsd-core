---
type: Fixed
pr: 2253
---
**state record-metric no longer appends per-plan rows into the By-Phase velocity table** — it now maintains its own Per-Plan Metrics table (self-created on first use), and its auto-create scaffold header is corrected. (#2253)
