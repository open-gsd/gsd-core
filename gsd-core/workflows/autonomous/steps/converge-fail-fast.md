## Converge Fail-Fast

#4600: an explicit `--converge` / `--cross-ai` on the command line OVERRIDES the
`workflow.plan_review_convergence` config gate. `PLAN_STRATEGY` is `converge` only when the
operator explicitly passed one of those flags, so this run performs plan-review convergence
regardless of the config value. The config remains the default for non-flag invocation: without
the flag, planning routes per the gate exactly as before (see `plan-phase.md`).

Nothing to enforce here — proceed directly to planning with convergence. Do not prompt, do not
attempt to `config-set` the gate on the operator's behalf, and do not downgrade to
non-converge planning: silently changing the plan-review contract is the outcome this step
must never produce.
