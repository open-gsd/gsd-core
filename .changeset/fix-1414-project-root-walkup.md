---
type: Changed
pr: 1423
---
**`gsd-tools` now resolves the project root from a descendant subdirectory** — `findProjectRoot` walks up to the nearest ancestor directory containing `.planning/` so config loads correctly when invoked outside the project root; previously it fell through to defaults for plain descendant paths (cwd-drift gap #1366). Sub_repos, multiRepo, and `.git`-based heuristics retain priority. (Part of #1411, P1 / #1414)

<!-- docs-exempt: internal resolution heuristic in project-root.cts — no public docs surface for findProjectRoot; behavior change surfaced via config loading, not a user-visible API -->

