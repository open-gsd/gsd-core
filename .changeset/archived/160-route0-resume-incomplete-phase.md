---
type: Fixed
pr: 160
---
`/gsd-next` and `/gsd-progress` no longer silently skip partially-executed phases when `current_phase` was advanced past unfinished work. New Route 0 invariant scans all phases for plans without summaries and routes to `/gsd-execute-phase <lowest-numbered>` before any current_phase-based routing decision. Opt out with `--no-resume` to use the existing prior-phase defer prompt instead; `--force` bypasses all gates.
