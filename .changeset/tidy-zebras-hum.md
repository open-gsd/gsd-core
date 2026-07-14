---
type: Fixed
pr: 2262
---
**Phase-directory resolution fails loud on cross-project collisions** — when two unrelated GSD projects share a `.planning/phases/` tree, a bare phase number silently resolved to the first `0N-*` directory found. The fix detects multiple matches and surfaces an `ambiguous_matches` result. (#2237)
