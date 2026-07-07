---
type: Added
pr: 1835
---
`plan-phase` now authors edge and prohibition predicates into PLAN.md `must_haves` when a phase SPEC omits `## Edge Coverage` / `## Prohibitions`, so goal-backward verification still has predicates to check on a spec-less phase (ADR-857 Phase 6). Gated by the new default-on `workflow.specless_probe_fallback` toggle — disable it to skip the fallback (the skip is recorded visibly in the plan). Spec-less prohibitions are authored descriptor-less and disposed flagged/unverified (honest verifier #1154), never a silent pass.
