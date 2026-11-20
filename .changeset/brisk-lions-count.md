---
type: Fixed
pr: 5424
---
**`state begin-phase --plans` and `state planned-phase --plans` reject anything but a non-negative integer** — `--plans 3.5` and `--plans 3abc` were truncated to 3 and `--plans -1` was accepted. They, digit strings above 9007199254740991, a `--plans` with no value and a repeated `--plans` now fail with a usage error before anything is written.
