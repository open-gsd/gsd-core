---
type: Fixed
pr: 5408
---
**Git capability installs now honor pinned refs** — bare tags, typed tags, non-default branches, and full typed commit SHAs stage the requested tree even when it is behind the default tip; tip-local commit-ish spellings keep their prior shallow-checkout behavior, unsafe normalized refs and empty/invalid typed pins fail before retrieval, and Git hooks stay inactive during staging.
