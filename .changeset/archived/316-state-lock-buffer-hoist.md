---
type: Fixed
pr: 316
---
acquireStateLock no longer allocates a fresh SharedArrayBuffer on every retry iteration — the sleep buffer is now hoisted before the retry loop and reused, eliminating per-retry heap pressure. (#316)
