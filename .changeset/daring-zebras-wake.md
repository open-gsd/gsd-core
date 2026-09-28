---
type: Fixed
pr: 4966
---
**`/gsd-pause-work` now detects the active phase** — context detection globbed a literal `PLAN.md`, so phases whose plans use the canonical `{phase}-{plan}-PLAN.md` name were never found and the handoff silently landed in `.planning/.continue-here.md` instead of the phase directory that `execute-phase` reads for blocking anti-patterns.
