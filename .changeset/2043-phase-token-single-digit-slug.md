---
type: Fixed
pr: 2059
---
**Phase directories whose slug begins with a single digit now resolve correctly.** A phase like `46-6-rs-pipeline-orchestrator` (roadmap name "6 Rs Pipeline Orchestrator") had its phase token over-collected as `46-6` instead of `46`, so `gsd-tools` phase-by-number lookups resolved `phase_dir=null` / `has_context=false` (breaking `init.plan-phase`, `init.phase-op`, and downstream execute/verify/ship). Numeric phase-token components must now be zero-padded (≥2 digits), so a single-digit slug word is no longer absorbed into the token. Fixed consistently across every same-class implementation — `extractPhaseToken`, `PHASE_TOKEN_FROM_DIR_RE` and `canonicalPlanStem` (health checks / plan pairing), `isDirInMilestone`'s numeric matcher (milestone filtering), and `extractCanonicalPlanId` — so the health-check and milestone-filter subsystems are fixed alongside phase resolution.
