# Cross-runtime executor dispatch (#6303, ADR-3711)

Run inside the `orchestrator-worktree` block of `executor-isolation-dispatch.md`, for a plan whose
`dispatch-isolation` result carries a non-null `executorRuntime` and a null `fallback`. The plan
declared `executor_runtime: <id>`, `workflow.cross_runtime_execution` is `true`, and the route
resolved the target runtime's own `orchestratorExec`. The branch is the resolved `isolation`
(`orchestrator-worktree`), never a runtime id.

## Contract

- **One decision, one producer.** Call the route once per plan, with the plan identity, and use its
  answer. Do not re-derive isolation or exec in shell, and do not call `record-dispatch-isolation`
  for this plan: the route's write is the plan's record, and it names `producer: "dispatch-isolation"`
  and `executor_runtime`.

  ```bash
  EXEC_JSON=$(gsd_run query dispatch-isolation --json \
    --phase "${PHASE_NUMBER}" --plan "{plan_id}" \
    --cwd-target "$WT_PATH" --prompt "$EXECUTOR_PROMPT")
  EXECUTOR_RUNTIME=$(printf '%s' "$EXEC_JSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);process.stdout.write(j.executorRuntime&&!j.fallback?j.executorRuntime:"")}catch{}})')
  ```

- **Same prompt, one source.** `EXECUTOR_PROMPT` is the prompt `executor-isolation-dispatch.md` already
  builds for the process-spawn backend: same executor identity, `<execution_context>`, required reading
  and atomic-commit contract, and the `[gsd:dispatch phase="{phase_number}" plan="{plan_id}"]` marker
  (ADR-4630 Decision 1). Do not copy or reword the contract text for the foreign runtime.
- **Model is the target's.** `exec.args` already carries `execute.models.<runtime>` when that key is set
  and the target declares a model flag. Never append the host's model or effort.
- **Lifecycle record.** Record the launch with the target runtime, before any wait:

  ```bash
  gsd_run query worktree.worker-record --path "$WT_PATH" --pid "$WORKER_PID" --plan "{plan_number}" \
    --summary-path "{phase_dir}/{plan_padded}-SUMMARY.md" --log-file "${WT_PATH}.worker.log" \
    ${EXECUTOR_RUNTIME:+--executor-runtime "$EXECUTOR_RUNTIME"}
  ```

- **Completion is reconciliation.** A foreign worker is complete when `completion-reconciliation.md`
  finds its SUMMARY, plan-scoped commits and branch state, never when the process exits. Merge through
  the same manifest gauntlet, so declared scope (`files_modified`) is validated on the host.
- **Degrade, never halt.** When `fallback` is non-null the route has already printed one advisory line
  and returned the host's own dispatch; follow that dispatch unchanged.
- **No checkpoints.** Plans with `autonomous: false` or a checkpoint task cannot declare
  `executor_runtime` (refused at `verify plan-structure`), so the foreign worker never needs to raise one.
