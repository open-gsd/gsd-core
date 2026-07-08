---
type: Fixed
pr: 2105
---
**`init plan-phase` no longer collapses foreign-prefixed task/workstream IDs into numeric phases** — a query like `MEM-01` (where `MEM` is not the configured `project_code`) used to have its prefix stripped and resolve to the unrelated numeric Phase 01; it now reports `phase_found: false` unless a phase directory or roadmap entry literally carries that prefix. The configured `project_code`'s own prefixed phases (e.g. `LKML-01` under `project_code: LKML`) continue to resolve as before. (#2056)
