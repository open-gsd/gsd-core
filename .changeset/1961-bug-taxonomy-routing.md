---
type: Added
pr: 2407
---
**`gsd-debugger` now classifies each failure by bug class and routes the investigation technique accordingly, replacing the flat 11-technique menu with selection-by-class** — at a new Phase 1.75 the debugger assigns a `bug_class` (Bohrbug / Heisenbug-Mandelbug / Concurrency) and consults an explicit, inspectable routing table: Bohrbugs route to deterministic reproduction + SBFL (Phase 1.25) + git bisect; Heisenbugs/Mandelbugs route to record-replay (`rr`) + stability-stress + statistical sampling and **explicitly skip SBFL** (a flaky spectrum poisons the ranking); Concurrency bugs surface the atomicity/order/deadlock checklist before general techniques. The 11 techniques remain as routed targets, not an undifferentiated list (supersede, not append). `bug_class` + chosen strategy are written to the debug file; the common-bug-patterns catalog is cross-referenced to the taxonomy. Full rules live in `gsd-core/references/debugger-bug-taxonomy.md`. (#1961)
