---
type: Fixed
pr: 1701
---
**`gsd-tools state patch` of an unrelated field no longer clobbers a curated `current_phase_name`** — `syncStateFrontmatter` re-derives the scalar from the `## Current Position` Phase line on every write, so patching e.g. `--Status` silently reverted a curated `current_phase_name` to whatever the prose derived. A #1230-style delta guard now restores the curated value when the patch did not change the Phase line it derives from; `begin`/`planned`/`complete-phase` still advance it normally. (#1695)
