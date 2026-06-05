---
type: Fixed
pr: 407
---
`withPlanningLock` no longer allocates a fresh SharedArrayBuffer on every retry iteration — hoist the sleep buffer once before the loop (matches the #316/#399 fix for `acquireStateLock`).
