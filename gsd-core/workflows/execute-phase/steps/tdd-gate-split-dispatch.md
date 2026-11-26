# TDD gate split dispatch (#4696)

Apply response_language to all user-facing prose — narration between tool calls, status
updates, progress notes, and findings included; preserve code, paths, and identifiers.

A `type: tdd` plan normally runs as ONE executor dispatch. When `model_overrides` gives its RED gate and
its GREEN/REFACTOR gates different models, the plan instead runs as TWO sequential dispatches: a RED
dispatch, then a GREEN/REFACTOR dispatch, each on its own model. This file has two parts that run at
**different times**, like `per-plan-worktree-gate.md`: **Part 1** decides, for each plan, up front in
step 2.5; **Part 2** dispatches, in step 3.

## Contract

- The two gate models are the `model_overrides` entries `<executor-type>:tdd-red` and
  `<executor-type>:tdd-green-refactor`. A gate whose entry is unset, blank, not a string, or an object
  with no key for the active runtime uses the routed executor's own model. An entry of `inherit` is a
  real value: that gate runs on the session's model (`model=` omitted). With neither entry set the two
  models are equal and nothing splits.
- A plan splits only when ALL of these hold: `TDD_MODE` is `true`; the plan's `plan_type` (from
  `phase.tdd-applicable`) is `tdd`; the plan declares no `executor_runtime`; the phase-level `ISOLATION`
  is not `orchestrator-worktree`; every model resolve succeeded; and the two gate models differ
  (`inherit` and empty count as the same model).
- Any other case is a single dispatch, byte-identical to before. A failed resolve is never a split.
- A split plan runs in the orchestrator's own tree, in step 3's **Sequential mode**: a worktree is
  removed when its executor returns, and GREEN must start from the RED commit. Part 1 sets the plan's
  `USE_WORKTREES_FOR_PLAN` to `false`, so the plan never joins `WAVE_WORKTREE_PLANS`, Part 2 of
  `per-plan-worktree-gate.md` records isolation `none` for it, and `sequential-root-pin.md` serializes
  it against the rest of the wave.

## Part 1 — Decide (run for each plan in step 2.5, after Part 1 of `per-plan-worktree-gate.md`)

`plan_id`, `PHASE_NUMBER`, `ISOLATION`, `USE_WORKTREES_FOR_PLAN` and `plan_json` (the plan's JSON from
`phase-plan-index`) are in scope.

```bash
_GSD_SHIM_NAME="gsd-tools.cjs"; _GSD_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; GSD_TOOLS="${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}"; _gsd_at() { for _p; do if [ -f "$_p" ]; then GSD_TOOLS="$_p"; return 0; fi; done; return 1; }; _gsd_id_ok() { case "$("$1" runtime-identity --raw 2>/dev/null || true)" in '{"packageName":"@opengsd/gsd-core"'*'}') return 0;; *) return 1;; esac; }; _gsd_homes() { set -- "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" "${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}" "$HOME/.gemini/antigravity-ide" "$HOME/.gemini/antigravity-cli" "${AUGMENT_CONFIG_DIR:-$HOME/.augment}" "${CLINE_CONFIG_DIR:-$HOME/.cline}" "${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}" "${CODEX_HOME:-$HOME/.codex}" "${COPILOT_CONFIG_DIR:-${COPILOT_HOME:-$HOME/.copilot}}" "${CURSOR_CONFIG_DIR:-$HOME/.cursor}" "${HERMES_HOME:-$HOME/.hermes}" "${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}" "${KIMI_CONFIG_DIR:-$HOME/.config/agents}" "$HOME/.agents" "${KIMI_CODE_HOME:-$HOME/.kimi-code}" "${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}" "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}" "${QWEN_CONFIG_DIR:-$HOME/.qwen}" "${TRAE_CONFIG_DIR:-$HOME/.trae}" "${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}" "${ZCODE_CONFIG_DIR:-$HOME/.zcode}" "${GROK_AGENTS_HOME:-$HOME/.agents}"; for _h; do _gsd_at "$_h/gsd-core/bin/${_GSD_SHIM_NAME}" && return 0; done; return 1; }; if _gsd_at "${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}"; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif _gsd_homes; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif unset -f gsd_run; _G="$(command -v gsd_run)"; [ -n "$_G" ] && _gsd_id_ok "$_G"; then GSD_TOOLS="$_G"; gsd_run() { "$GSD_TOOLS" "$@"; }; else echo "ERROR: gsd-tools.cjs not found at $GSD_TOOLS and no identity-proving gsd_run is on PATH. Run: npx -y @opengsd/gsd-core@latest --claude --local" >&2; exit 1; fi; GSD_IDENTITY_STATUS=unverified; _gsd_id_ok gsd_run && GSD_IDENTITY_STATUS=ok; export GSD_IDENTITY_STATUS; [ "$GSD_IDENTITY_STATUS" = ok ] || echo "WARNING: \"$GSD_TOOLS\" did not prove it is @opengsd/gsd-core - it is either a different package or an @opengsd/gsd-core older than the runtime-identity verb. See docs/how-to/diagnose-a-foreign-gsd-tools.md" >&2; if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -n "${GSD_TOOLS:-}" ]; then printf "export PATH='%s':\"\$PATH\"\n" "${GSD_TOOLS%/*}" >> "$CLAUDE_ENV_FILE" 2>/dev/null || true; fi
TDD_GATE_SPLIT=false; TDD_RED_MODEL=""; TDD_GREEN_MODEL=""
TDD_MODE="${TDD_MODE:-$(gsd_run loop render-hooks execute:post --active-cap tdd 2>/dev/null || true)}"
TDD_PLAN_TYPE=$(gsd_run query phase.tdd-applicable "{phase_dir}/{plan_file}" --pick plan_type 2>/dev/null || echo "")
TDD_PLAN_RUNTIME=$(printf '%s' "${plan_json:-}" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);process.stdout.write(typeof j.executorRuntime==="string"?j.executorRuntime:"")}catch{}})')
if [ "$TDD_MODE" = "true" ] && [ "$TDD_PLAN_TYPE" = "tdd" ]; then
  if [ "${ISOLATION:-}" = "orchestrator-worktree" ] || [ -n "$TDD_PLAN_RUNTIME" ]; then
    echo "note: plan ${plan_id} keeps a single dispatch: the orchestrator-worktree backend and executor_runtime plans do not split TDD gates." >&2
  else
    # One model per gate. A gate whose key is unset resolves through the fallback role, and the answer says so
    # (fallback_agent): that gate then uses the routed executor's own model.
    tdd_gate_model() {
      _J=$(gsd_run query resolve-model "$1" --fallback-agent gsd-executor 2>/dev/null) || return 1
      printf '%s' "$_J" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);process.stdout.write(!j.fallback_agent&&typeof j.model==="string"&&j.model.trim()!==""?j.model:"")}catch{process.exit(1)}})'
    }
    # An empty model and `inherit` both mean "omit model=", so they are the same model.
    tdd_norm_model() {
      if [ -z "$1" ]; then echo inherit; else echo "$1"; fi
    }
    tdd_same_model() {
      [ "$(tdd_norm_model "$1")" = "$(tdd_norm_model "$2")" ]
    }
    TDD_EXECUTOR_TYPE=$(gsd_run query resolve-agent --phase "${PHASE_NUMBER:-}" --plan "$plan_id" --raw 2>/dev/null) || TDD_EXECUTOR_TYPE="gsd-executor"
    if TDD_BASE=$(gsd_run query resolve-model "$TDD_EXECUTOR_TYPE" --fallback-agent gsd-executor --raw 2>/dev/null) \
      && TDD_RED_KEY_MODEL=$(tdd_gate_model "${TDD_EXECUTOR_TYPE}:tdd-red") \
      && TDD_GREEN_KEY_MODEL=$(tdd_gate_model "${TDD_EXECUTOR_TYPE}:tdd-green-refactor"); then
      TDD_RED_MODEL="${TDD_RED_KEY_MODEL:-$TDD_BASE}"
      TDD_GREEN_MODEL="${TDD_GREEN_KEY_MODEL:-$TDD_BASE}"
      if ! tdd_same_model "$TDD_RED_MODEL" "$TDD_GREEN_MODEL"; then
        TDD_GATE_SPLIT=true
        USE_WORKTREES_FOR_PLAN=false
      fi
    else
      echo "note: plan ${plan_id} could not resolve its TDD gate models, so it keeps a single dispatch." >&2
      TDD_RED_MODEL=""; TDD_GREEN_MODEL=""
    fi
  fi
fi
printf 'TDD_GATE_SPLIT=%s\nTDD_RED_MODEL=%s\nTDD_GREEN_MODEL=%s\nUSE_WORKTREES_FOR_PLAN=%s\n' "$TDD_GATE_SPLIT" "$TDD_RED_MODEL" "$TDD_GREEN_MODEL" "${USE_WORKTREES_FOR_PLAN:-}"
```

When `TDD_GATE_SPLIT` is `true`, store it with the plan's decision (`plan_id → TDD_GATE_SPLIT`, `TDD_RED_MODEL`,
`TDD_GREEN_MODEL`) beside the stored `USE_WORKTREES_FOR_PLAN=false`, and do **not** append the plan to
`WAVE_WORKTREE_PLANS`. When it is `false`, the rest of this file does not apply: the plan's dispatch,
its model and its worktree decision are exactly what they were.

## Part 2 — Dispatch (run in step 3, for a plan stored as `TDD_GATE_SPLIT=true`)

Restore the plan's stored decision as step 3 already does. The plan is in Sequential mode, so follow step 3's
Sequential-mode instructions for BOTH dispatches below: omit `isolation="worktree"`, run
`sequential-root-pin.md`, and embed the `<sequential_execution>` and `<project_root_pin>` blocks. Both
dispatches are foreground: do not set `run_in_background`, because the second dispatch needs the first one's commit.

1. **Resume check.** Before the RED dispatch, run the RED-commit lookup of `gsd-core/references/tdd.md` ("Executor Gate
   Validation", the first `git log` command) with `PHASE` and `PLAN` set to this plan's numbers. If it already
   prints a RED commit and no `SUMMARY.md` exists for the plan, the RED gate already ran (a resumed plan): skip
   straight to step 4.
2. **RED dispatch.** Emit the plan-start heartbeat, then dispatch step 3's sequential `Agent()` prompt with `model`
   set to `TDD_RED_MODEL` (omit `model=` when it is `inherit` or empty, the existing rule), add
   `gsd-core/references/tdd-gate-dispatch.md` to the embedded `<execution_context>` list, and add the line
   `TDD_GATE=red` to the `<objective>`. Change three things in that prompt: drop the "Create SUMMARY.md" sentence from
   the `<objective>`; drop the `REQUIRED ORDER: Write SUMMARY.md` line from `<sequential_execution>`; and replace
   `<success_criteria>` with exactly `- [ ] The failing test is committed with the RED commit scope` and
   `- [ ] The RED evidence verdict is reported`. The prompt must ask for no `SUMMARY.md`, `STATE.md` or `ROADMAP.md` write.
3. **Verify the RED dispatch.** After it returns, run the same RED-commit lookup. Halt this plan, start no GREEN
   dispatch and surface the executor's report when any of these holds: the lookup prints nothing; the report carries a
   RED halt (`INVALID_RED`, or the test passed before any implementation); a `SUMMARY.md` exists for the plan; or
   an implementation commit for the plan exists. A halted plan follows the wave's normal failure handling.
4. **GREEN/REFACTOR dispatch.** Dispatch the same sequential prompt again with `model` set to `TDD_GREEN_MODEL` (same
   omit rule), `gsd-core/references/tdd-gate-dispatch.md` embedded, and the line `TDD_GATE=green-refactor`. Keep the
   sequential prompt's `SUMMARY.md`, `STATE.md` and `ROADMAP.md` success criteria: this dispatch finishes the plan.
5. **Continue as usual.** The wave's spot-checks, SUMMARY handling and STATE/ROADMAP reads use the second dispatch's
   result, exactly as they use a single dispatch's.

Add nothing about checkpoints or auto-approval to either prompt (#3370).
