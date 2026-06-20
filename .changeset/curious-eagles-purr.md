---
type: Fixed
pr: 1500
---
**`workflow.mvp_mode` now accepted by `config-set`; three undocumented workflow keys added to references** — `workflow.mvp_mode`, `workflow.code_review_command`, and `workflow.plan_chunked` were consumed by planning-pipeline code but could not be set via `config-set` (they were missing from `VALID_CONFIG_KEYS`) or discovered via reference docs. All three are now in the schema and documented in `references/planning-config.md`. (#1500)
