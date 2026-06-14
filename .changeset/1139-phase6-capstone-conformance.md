---
"@opengsd/gsd-core": patch
type: Changed
issue: 1139
pr: 1158
---

Added ADR-857 Phase 6 capstone conformance coverage so migrated Capability activation keys cannot be read directly from host loop workflows, Capability-owned config keys stay out of the central schema, and the host loop workflow size budgets remain documented. The verify-work UI automation preflight now resolves UI activation through the Capability hook registry instead of reading `workflow.ui_phase` directly.
