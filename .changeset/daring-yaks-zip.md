---
type: Fixed
pr: 538
---
**`/gsd-plan-phase` §13e post-planning gap analysis now scopes to the phase's mapped REQ-IDs** — a phase that maps no requirements (`phase_req_ids` null/TBD) no longer reports every unrelated project requirement as "not covered". CONTEXT.md decisions remain in scope. Mapped REQ-IDs that are listed in the roadmap but absent from `REQUIREMENTS.md` are now surfaced as explicit "⚠ Missing from REQUIREMENTS.md" rows instead of being silently dropped, preventing false "all covered" reports when the requirements document has drifted.
