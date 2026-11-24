Apply response_language to all user-facing prose — narration between tool calls, status updates, progress notes, and findings included; preserve code, paths, and identifiers.


<!-- PHASE-ID-CONVENTION:START -->
Resolve phase_id_convention independently of phase_naming. Use returned paths; never derive them from display labels.
Use CLI display_id when present; otherwise use reference grammar. Before emitting identities, Read `~/.claude/gsd-core/references/phase-id-convention.md`.
<!-- PHASE-ID-CONVENTION:END -->

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
one advisory line and the plan takes the host's own dispatch: follow the phase-level dispatch unchanged.
Read only `executorRuntime` and `fallback` from the plan's answer; its `isolation` can be a held `none`
(#4904) that the per-plan gate has already replaced in the plan's record. A caller that forced the
plan's isolation (`--force-isolation`, the submodule gate, the base-check degrade) always wins: the
route reports `fallback: forced_isolation`.

## Contract

- **One decision, one producer.** The route's sentinel write is the plan's record and names
  `producer: "dispatch-isolation"` and `executor_runtime`. A query that holds a caller's `none` (#4904)
  writes nothing; the per-plan gate re-records that plan before the launch, so the exec read is the write. Never call `record-dispatch-isolation` for
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
_GSD_SHIM_NAME="gsd-tools.cjs"; _GSD_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; GSD_TOOLS="${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}"; _gsd_at() { for _p; do if [ -f "$_p" ]; then GSD_TOOLS="$_p"; return 0; fi; done; return 1; }; _gsd_id_ok() { case "$("$1" runtime-identity --raw 2>/dev/null || true)" in '{"packageName":"@opengsd/gsd-core"'*'}') return 0;; *) return 1;; esac; }; _gsd_homes() { set -- "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" "${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}" "$HOME/.gemini/antigravity-ide" "$HOME/.gemini/antigravity-cli" "${AUGMENT_CONFIG_DIR:-$HOME/.augment}" "${CLINE_CONFIG_DIR:-$HOME/.cline}" "${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}" "${CODEX_HOME:-$HOME/.codex}" "${COPILOT_CONFIG_DIR:-${COPILOT_HOME:-$HOME/.copilot}}" "${CURSOR_CONFIG_DIR:-$HOME/.cursor}" "${HERMES_HOME:-$HOME/.hermes}" "${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}" "${KIMI_CONFIG_DIR:-$HOME/.config/agents}" "$HOME/.agents" "${KIMI_CODE_HOME:-$HOME/.kimi-code}" "${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}" "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}" "${QWEN_CONFIG_DIR:-$HOME/.qwen}" "${TRAE_CONFIG_DIR:-$HOME/.trae}" "${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}" "${ZCODE_CONFIG_DIR:-$HOME/.zcode}" "${GROK_AGENTS_HOME:-$HOME/.agents}"; for _h; do _gsd_at "$_h/gsd-core/bin/${_GSD_SHIM_NAME}" && return 0; done; return 1; }; if _gsd_at "${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}"; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif _gsd_homes; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif unset -f gsd_run; _G="$(command -v gsd_run)"; [ -n "$_G" ] && _gsd_id_ok "$_G"; then GSD_TOOLS="$_G"; gsd_run() { "$GSD_TOOLS" "$@"; }; else echo "ERROR: gsd-tools.cjs not found at $GSD_TOOLS and no identity-proving gsd_run is on PATH. Run: npx -y @opengsd/gsd-core@latest --claude --local" >&2; exit 1; fi; GSD_IDENTITY_STATUS=unverified; _gsd_id_ok gsd_run && GSD_IDENTITY_STATUS=ok; export GSD_IDENTITY_STATUS; [ "$GSD_IDENTITY_STATUS" = ok ] || echo "WARNING: \"$GSD_TOOLS\" did not prove it is @opengsd/gsd-core - it is either a different package or an @opengsd/gsd-core older than the runtime-identity verb. See docs/how-to/diagnose-a-foreign-gsd-tools.md" >&2; if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -n "${GSD_TOOLS:-}" ]; then printf "export PATH='%s':\"\$PATH\"\n" "${GSD_TOOLS%/*}" >> "$CLAUDE_ENV_FILE" 2>/dev/null || true; fi
  EXECUTOR_RUNTIME=$(printf '%s' "$EXEC_JSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);process.stdout.write(j.executorRuntime&&!j.fallback?j.executorRuntime:"")}catch{}})')
  gsd_run query worktree.worker-record --path "$WT_PATH" --pid "$WORKER_PID" --plan "{plan_number}" \
    --summary-path "{phase_dir}/{plan_padded}-SUMMARY.md" --log-file "${WT_PATH}.worker.log" \
    ${EXECUTOR_RUNTIME:+--executor-runtime} ${EXECUTOR_RUNTIME:+"$EXECUTOR_RUNTIME"}
  ```

- **Completion is reconciliation.** A foreign worker is complete when `completion-reconciliation.md`
  finds its SUMMARY, plan-scoped commits and branch state, never when the process exits. It merges through
  the same manifest gauntlet, so declared scope (`files_modified`) is validated on the host.
- **No checkpoints.** Plans with `autonomous: false` or a checkpoint task cannot declare `executor_runtime`
  (refused at `verify plan-structure`), so the foreign worker never needs to raise one.
