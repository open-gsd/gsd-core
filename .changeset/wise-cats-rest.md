---
type: Fixed
pr: 0
---
**Phase-directory resolution fails loud on cross-project collisions** — when two unrelated GSD projects share a `.planning/phases/` tree (e.g. from shared git history), a bare phase number resolved to whichever `0N-*` directory was found first, with no check against which project was active — risking silent cross-project file writes. The fix detects when multiple directories match the same bare phase number and surfaces an `ambiguous_matches` result listing the candidates, instead of silently taking the first match. Single-match resolution is unchanged. (#2237)
