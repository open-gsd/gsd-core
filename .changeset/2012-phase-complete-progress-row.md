---
type: Fixed
pr: 2032
---
**`phase.complete` now updates the `## Progress` rollup row even when an earlier phase-numbered table precedes it** — the Progress-row writer used a non-global regex that matched *any* table row starting with the phase number, so it bound to the first such row (e.g. a `| Phase | Requirements | Count |` coverage table), no-op'd on the wrong 3-column row, and never reached the real Progress row. The regex is now scoped to the `## Progress` section so it binds to the correct table. The command still returned `roadmap_updated: true` (that field is `fs.existsSync(ROADMAP.md)`), masking the silent failure. (#2012)
