---
type: Security
pr: 2141
---
**Hardened phase/roadmap/plan markdown parsing against quadratic-time (ReDoS) CPU exhaustion** — a crafted `ROADMAP.md`, `STATE.md`, or `PLAN.md` with large runs of unclosed `(`, `[`, `<tag>`, `<!--`, or `<details>` could drive the phase-header, Plans-count, `files_modified`, and `<tag>`-block parsers into O(n²) scans (tens of seconds on a ~1.5 MB file). Every affected regex is now linear: header tag/bracket clauses are length-bounded, the Plans-count scan is section-local, and all `<tag>…</tag>` extraction routes through a single ReDoS-safe seam. (#2128)
