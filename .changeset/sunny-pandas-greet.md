---
type: Fixed
pr: 5412
---
**Plan duration no longer falls back to estimates** — the executor and inline plan workflow persist the start across fresh shells and continuations, reuse one measured completion duration for SUMMARY and STATE metrics, and clear completed-run markers before later reruns.
