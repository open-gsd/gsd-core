---
type: Fixed
pr: 0
---
**`--json-errors` now emits a structured error even when a handler throws unexpectedly** — an unexpected (non-`ExitError`) throw fell through to a raw stack trace on stderr, breaking SDK structured-error parsing. (#965)
