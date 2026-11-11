---
type: Fixed
pr: 5408
---
**Git capability installs now honor pinned refs** — bare tags, typed tags, non-default branches, and full typed commit SHAs stage the requested tree even when it is behind the default tip; tip-local commit-ish spellings keep their prior shallow-checkout behavior, unsafe normalized refs and empty/invalid typed pins fail before retrieval, and Git hooks stay inactive during staging. `#sha:` now requires a full 40- or 64-hex object ID; short IDs and branch names are rejected, including when re-resolving previously recorded sources. Checkout retains the clone tree-write budget and a fixed origin name; refspec patterns are rejected.
