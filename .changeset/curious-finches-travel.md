---
type: Fixed
pr: 4769
---
**Deferred UAT follow-ups stop blocking phase completion** — `/gsd-verify-work` deferrals (skipped with a "Deferred follow-up" reason) no longer fail the phase-completion predicate, and completing a session with deferrals now offers to promote them into a `999.x` ROADMAP backlog entry; plain unresolved skips still block as before. (#4546)
