---
type: Fixed
pr: 2254
---
**Phase dirs whose slug leads with a multi-digit number (e.g. a year) resolve again** — a phase like `14-2026-photos-performance` (roadmap name "2026 Photos & Performance") had its phase token over-collected as `14-2026`, so `init.plan-phase`, `init.execute-phase`, `phase-plan-index`, `state.planned-phase`, and `roadmap.annotate-dependencies` reported `phase_dir=null` / `plan_count=0` while the directory existed. Continuation segments of a phase token are now capped at the exactly-2-digit zero-padded form the write side emits, via a single shared grammar source consumed by all five parsing sites (the residual case from #2043). (#2232)
