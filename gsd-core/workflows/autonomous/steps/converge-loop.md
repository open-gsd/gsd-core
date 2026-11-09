## Converge Loop

<!-- PHASE-ID-CONVENTION:START -->
Resolve phase_id_convention independently of phase_naming. Use returned paths; never derive them from display labels.
Use CLI display_id when present; otherwise use reference grammar. Before emitting identities, Read `~/.claude/gsd-core/references/phase-id-convention.md`.
<!-- PHASE-ID-CONVENTION:END -->

If `PLAN_STRATEGY=converge`, run the convergence loop:



```
Skill(skill="gsd-plan-review-convergence", args="${PHASE_NUM} ${CONVERGENCE_ARGS}")
```
