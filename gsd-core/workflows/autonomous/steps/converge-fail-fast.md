## Converge Fail-Fast

#4600: an explicit `--converge` / `--cross-ai` on the command line OVERRIDES the `workflow.plan_review_convergence` config gate. `PLAN_STRATEGY` is `converge` only when the
operator explicitly passed one of those flags, so this run performs plan-review convergence
regardless of the config value. The dispatched `gsd-plan-review-convergence` invocation carries `--override-gate` so its own §1.5 config gate cannot veto this run either.

For autonomous, the config is not consulted on the non-flag path at all: without the flag, `PLAN_STRATEGY` is `local` and planning routes through `gsd-plan-phase`. The gate (`workflow.plan_review_convergence`) governs standalone `/gsd:plan-review-convergence` and `/gsd:progress --next --converge`.

Nothing to enforce here — proceed directly to planning with convergence. Do not prompt, do not
attempt to `config-set` the gate on the operator's behalf, and do not downgrade to
non-converge planning: silently changing the plan-review contract is the outcome this step
must never produce.
