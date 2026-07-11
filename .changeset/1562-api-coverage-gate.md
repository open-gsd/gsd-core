---
type: Added
pr: 2065
---
**Phases that integrate an external API/SDK/service can no longer seal without a decided coverage matrix** — a new `api-coverage` gate on the `ai-integration` capability blocks `/gsd:verify-work` until the phase produces a `COVERAGE.md` enumerating the API's full capability surface, with every non-integrated capability an explicit, reasoned opt-out. Full coverage is the default; the matrix is the subtraction record, so "we integrated the API" can no longer silently mean "we integrated whatever the first use case exercised." Toggleable via `workflow.api_coverage_gate` (on by default). (#1562)
