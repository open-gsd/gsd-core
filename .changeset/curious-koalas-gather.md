---
type: Fixed
pr: 1722
---
**`/gsd:verify-work` no longer silently terminates when all remaining UAT tests are blocked** — sessions with `blocked_count > 0` and `pending_count == 0` now route to `complete_session` as expected, enabling the zero-issues auto-transition path.
