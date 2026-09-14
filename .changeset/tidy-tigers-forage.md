---
type: Fixed
pr: 0
---
**Seeds no longer collide across parallel workstreams** — `/gsd:capture --seed` now mints `SEED-YYMMDD-xxx` ids from the local date plus a random suffix instead of counting files in `.planning/seeds/`, so two workstreams can plant a seed before either merges without both picking the same id; existing `SEED-NNN` seeds keep resolving in list, enrich, scan, and audit surfaces. (#4378)
