---
type: Fixed
pr: 2023
---
**`config-set` no longer silently coerces values into something the disk never sees** — `Number.isFinite` replaced `!isNaN` in the value parser so `Infinity`/`-Infinity` are no longer coerced to non-finite numbers that `JSON.stringify` then renders as `null` on disk while the CLI echoes `Infinity` (output ≠ disk). `context_window` now has a per-key validator requiring a finite positive integer (rejects `Infinity`, `0`, negatives, non-integers with a non-zero exit), and `project_code` is always persisted as a string so a leading-zero code like `007` survives verbatim instead of collapsing to `7`. Numeric coercion for genuine numeric keys (e.g. `granularity 42`) is unchanged. (#1581)
