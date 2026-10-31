## Converge Dispatch (Background)

<!-- PHASE-ID-CONVENTION:START -->
Resolve phase_id_convention independently of phase_naming. Use returned paths; never derive them from display labels.
Use CLI display_id when present; otherwise use reference grammar. Before emitting identities, Read `~/.claude/gsd-core/references/phase-id-convention.md`.
<!-- PHASE-ID-CONVENTION:END -->

If `PLAN_STRATEGY=converge`, print: `◆ Spawning background plan-convergence loop for phase ${PHASE_NUM}... (runs in a subagent — no output until it returns, ~1–5 min; expected, not a freeze)`



```
Agent(
  description="Plan convergence phase ${PHASE_NUM}: ${PHASE_NAME}",
  run_in_background=true,
  prompt="Run plan convergence for phase ${PHASE_NUM}: Skill(skill=\"gsd-plan-review-convergence\", args=\"${PHASE_NUM} ${CONVERGENCE_ARGS}\")"
)
```
