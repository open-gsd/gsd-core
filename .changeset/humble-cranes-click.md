---
type: Fixed
pr: 4509
---
**Whitespace-only planning scope values no longer create phantom directories** — `GSD_WORKSTREAM`, `GSD_PROJECT`, and their explicit equivalents now fall back to the root scope, while padded real names are normalized consistently.
