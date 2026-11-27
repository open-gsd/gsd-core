---
type: Fixed
pr: 6644
---
**`state prune --keep-recent` takes a whole number >= 0** — `0` now keeps no recent phase instead of silently becoming 3, and a negative, fractional, non-numeric, empty or repeated value is refused as a usage error instead of being coerced (a negative value used to move the cutoff past the current phase and archive its entries). The default of 3 is unchanged.
