---
type: Changed
pr: 1647
---
**Capability commands now emit dispatch audit records** — `graphify`, `intel`, `audit-uat`, and `audit-open` now route through the Command Routing Hub per ADR-959 §III(B), so `GSD_AUDIT=1` traces, the structured stderr JSON error envelope, and the typed Result contract cover them uniformly with all other command families. JSON-error `reason` values (`usage`, `sdk_unknown_command`) are preserved byte-identical. (#1646)
