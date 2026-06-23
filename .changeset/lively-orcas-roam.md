---
type: Fixed
pr: 1504
---
`verify codebase-drift` now reads `workflow.drift_action` and `workflow.drift_threshold` from the correct nested config shape — previously both keys silently no-oped because `loadConfig()` returns a flattened object and `config?.workflow` was always `undefined`.
