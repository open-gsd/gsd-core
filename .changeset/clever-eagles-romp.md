---
type: Fixed
pr: 2231
---
**`phase complete --phase N` now works alongside the positional form** — the phase verb family treated the first positional as the phase number, so `--phase 12` was passed as the literal phase name and failed with 'Phase --phase not found'. The phase family now accepts the --phase flag consistently with the state family, and unrecognized flags yield a usage error. (#2201)
