---
type: Fixed
pr: 5424
---
**`state begin-phase --plans` rejects anything but a non-negative integer** — `--plans 3.5` and `--plans 3abc` were truncated to 3 and `--plans -1` was accepted. They and digit strings above 9007199254740991 now fail with a usage error before anything is written. (#5320)
