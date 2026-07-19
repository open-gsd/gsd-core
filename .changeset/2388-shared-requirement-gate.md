---
type: Fixed
pr: 2424
---
**Shared requirement IDs across multiple plans no longer read `Complete` before every declaring plan (and phase verification) has finished** — `execute-plan.md` now gates completion on sibling plans' `SUMMARY.md` files via a new read-only `requirements ready-ids` check, and a `gaps_found` phase verification reverts any requirement ID this phase owns back out of `Complete` before the gap report renders. Single-plan requirement IDs are unaffected — no added latency. (#2388)
