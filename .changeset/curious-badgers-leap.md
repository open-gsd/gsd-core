---
type: Fixed
pr: 5408
---
**Git capability installs now honor pinned refs** — bare tags, typed tags, non-default branches, and typed commit SHAs stage the requested tree even when it is behind the default tip; unsafe normalized refs and empty typed pins fail before retrieval, and Git hooks stay inactive during staging.
