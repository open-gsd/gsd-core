---
type: Fixed
pr: 320
---
Hoist static `byPhaseTablePattern` regex in `updatePerformanceMetricsSection` to module scope so it compiles once instead of on every call. (#320)
