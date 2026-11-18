# Cross-runtime executor dispatch (#6303, ADR-3711)

For a plan that declares `executor_runtime: <id>`. The decision is the plan's own `dispatch-isolation`
answer, taken in `per-plan-worktree-gate.md` Part 2 (the `PLAN_DISPATCH=` line): a non-null
`executorRuntime` with a null `fallback` and `isolation: orchestrator-worktree` means
`workflow.cross_runtime_execution` is on, every precondition held, and the target runtime's own
`orchestratorExec` resolves. The orchestrator branches on that resolved `isolation`, never on a runtime id.

## Per-plan override

When the plan's answer is `orchestrator-worktree` and the phase-level `ISOLATION` is not, dispatch THIS
plan through the `orchestrator-worktree` block of `executor-isolation-dispatch.md` (create the worktree,
call `dispatch-isolation --phase --plan --cwd-target --prompt` for the exec, spawn, record, reconcile).
Other plans in the wave keep the phase-level dispatch. When `fallback` is non-null the route has printed
one advisory line and returned the host's own dispatch: follow it unchanged. A caller that forced the
plan's isolation (`--force-isolation`, the submodule gate, the base-check degrade) always wins: the
route reports `fallback: forced_isolation`.

## Contract

- **One decision, one producer.** The route's sentinel write is the plan's record and names
  `producer: "dispatch-isolation"` and `executor_runtime`. Never call `record-dispatch-isolation` for
  this plan and never re-derive isolation or exec in shell.
- **Same prompt, one source.** `EXECUTOR_PROMPT` is the prompt `executor-isolation-dispatch.md` builds for
  the process-spawn backend: same executor identity, `<execution_context>`, required reading, atomic-commit
  contract and the `[gsd:dispatch phase="{phase_number}" plan="{plan_id}"]` marker (ADR-4630 Decision 1).
  Do not copy or reword that text for the foreign runtime.
- **Model is the target's.** `exec.args` carries `execute.models.<runtime>` when that key is set and the
  target declares a model flag. Never append the host's model or effort.
- **Lifecycle record.** Derive the runtime from the exec call's `EXEC_JSON` (the call in
  `executor-isolation-dispatch.md`) and record the launch with it, before any wait:

  ```bash
  EXECUTOR_RUNTIME=$(printf '%s' "$EXEC_JSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);process.stdout.write(j.executorRuntime&&!j.fallback?j.executorRuntime:"")}catch{}})')
  gsd_run query worktree.worker-record --path "$WT_PATH" --pid "$WORKER_PID" --plan "{plan_number}" \
    --summary-path "{phase_dir}/{plan_padded}-SUMMARY.md" --log-file "${WT_PATH}.worker.log" \
    ${EXECUTOR_RUNTIME:+--executor-runtime "$EXECUTOR_RUNTIME"}
  ```

- **Completion is reconciliation.** A foreign worker is complete when `completion-reconciliation.md`
  finds its SUMMARY, plan-scoped commits and branch state, never when the process exits. It merges through
  the same manifest gauntlet, so declared scope (`files_modified`) is validated on the host.
- **No checkpoints.** Plans with `autonomous: false` or a checkpoint task cannot declare `executor_runtime`
  (refused at `verify plan-structure`), so the foreign worker never needs to raise one.
