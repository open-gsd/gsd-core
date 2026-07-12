---
type: Fixed
pr: 0
---
**`last_activity` now shows your local calendar day** — the clock seam derived the date by slicing a UTC instant, so in negative-UTC-offset zones during UTC's early evening the date-only `last_activity` field jumped a day ahead of the operator's actual date (and of `last_updated`'s local date). Operator-facing date fields now use a host-local calendar day while internal/cosmetic stamps stay UTC. (#2136)
