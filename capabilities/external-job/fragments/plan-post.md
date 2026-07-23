<!-- external-job capability — plan:post fragment, injected into the planner (#1164). -->

## Tag runtime budgets on long tasks

For every `<task>` likely to exceed ~2 minutes of real compute, emit a
`<runtime_budget>` child element so execute can classify it:

- `<runtime_budget>quick</runtime_budget>` — under ~2 min; runs normally.
- `<runtime_budget>medium</runtime_budget>` — ~2–30 min; foreground, but with
  progress expectations.
- `<runtime_budget>unknown</runtime_budget>` — runtime not yet characterized;
  execute must run a first-health check and set a soft-review deadline before
  trusting the child timeout. Define a progress signal and an abort condition.
- `<runtime_budget>long_compute</runtime_budget>` — legitimately over ~30–60 min
  (HPC solver, model training, large simulations). Execute must **externalize**
  this as an async external job (see the execute:wave:post fragment) rather than
  blocking the agent turn.

For any `long_compute` task, also declare the async contract the executor will
need: the `submit_command`, the `expected_artifacts` the job must produce, and
the `verification_command` that proves the output before the plan can close.
Do not hardcode a cluster account, partition, or project path — the planner
never knows the scheduler layout; it declares the contract, the executor's
adapter fills the backend specifics.
