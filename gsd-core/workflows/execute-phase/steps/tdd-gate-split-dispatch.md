# TDD gate split dispatch (#4696)

Run for each plan, immediately after TDD-applicability resolution and before composing that plan's
`Agent()` prompt in step 3. It decides whether a `type: tdd` plan runs as ONE executor dispatch (the
default, byte-identical to before) or as TWO sequential dispatches: a RED dispatch, then a
GREEN/REFACTOR dispatch, each on its own model. `EXECUTOR_TYPE`, `EXECUTOR_MODEL`,
`EXECUTOR_MODEL_SOURCE`, `TDD_MODE`, `ISOLATION`, `plan_id` and `PHASE_NUMBER` are in scope.

## Contract

- The two gate models are `model_overrides` entries named `<executor-type>:tdd-red` and
  `<executor-type>:tdd-green-refactor`. An absent entry falls back to `EXECUTOR_TYPE`'s own model.
  There is no other configuration: with neither entry set the two models are equal and nothing splits.
- A plan splits only when ALL of these hold: `TDD_MODE` is `true`; the plan's `plan_type` (from
  `phase.tdd-applicable`) is `tdd`; the routing step resolved a model (`EXECUTOR_MODEL_SOURCE=resolved`);
  the dispatch is the `Agent()` path (not `orchestrator-worktree`, and not a plan routed to a foreign
  runtime by `executor_runtime`, which keep their single dispatch); and the two resolved models differ.
- A failed model resolve is not a split: the plan keeps its single dispatch on init's `{executor_model}`.

## Resolution

```bash
_GSD_SHIM_NAME="gsd-tools.cjs"; _GSD_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; GSD_TOOLS="${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}"; _gsd_at() { for _p; do if [ -f "$_p" ]; then GSD_TOOLS="$_p"; return 0; fi; done; return 1; }; _gsd_id_ok() { case "$("$1" runtime-identity --raw 2>/dev/null || true)" in '{"packageName":"@opengsd/gsd-core"'*'}') return 0;; *) return 1;; esac; }; _gsd_homes() { set -- "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" "${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}" "$HOME/.gemini/antigravity-ide" "$HOME/.gemini/antigravity-cli" "${AUGMENT_CONFIG_DIR:-$HOME/.augment}" "${CLINE_CONFIG_DIR:-$HOME/.cline}" "${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}" "${CODEX_HOME:-$HOME/.codex}" "${COPILOT_CONFIG_DIR:-${COPILOT_HOME:-$HOME/.copilot}}" "${CURSOR_CONFIG_DIR:-$HOME/.cursor}" "${HERMES_HOME:-$HOME/.hermes}" "${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}" "${KIMI_CONFIG_DIR:-$HOME/.config/agents}" "$HOME/.agents" "${KIMI_CODE_HOME:-$HOME/.kimi-code}" "${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}" "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}" "${QWEN_CONFIG_DIR:-$HOME/.qwen}" "${TRAE_CONFIG_DIR:-$HOME/.trae}" "${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}" "${ZCODE_CONFIG_DIR:-$HOME/.zcode}" "${GROK_AGENTS_HOME:-$HOME/.agents}"; for _h; do _gsd_at "$_h/gsd-core/bin/${_GSD_SHIM_NAME}" && return 0; done; return 1; }; if _gsd_at "${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}"; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif _gsd_homes; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif unset -f gsd_run; _G="$(command -v gsd_run)"; [ -n "$_G" ] && _gsd_id_ok "$_G"; then GSD_TOOLS="$_G"; gsd_run() { "$GSD_TOOLS" "$@"; }; else echo "ERROR: gsd-tools.cjs not found at $GSD_TOOLS and no identity-proving gsd_run is on PATH. Run: npx -y @opengsd/gsd-core@latest --claude --local" >&2; exit 1; fi; GSD_IDENTITY_STATUS=unverified; _gsd_id_ok gsd_run && GSD_IDENTITY_STATUS=ok; export GSD_IDENTITY_STATUS; [ "$GSD_IDENTITY_STATUS" = ok ] || echo "WARNING: \"$GSD_TOOLS\" did not prove it is @opengsd/gsd-core - it is either a different package or an @opengsd/gsd-core older than the runtime-identity verb. See docs/how-to/diagnose-a-foreign-gsd-tools.md" >&2; if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -n "${GSD_TOOLS:-}" ]; then printf "export PATH='%s':\"\$PATH\"\n" "${GSD_TOOLS%/*}" >> "$CLAUDE_ENV_FILE" 2>/dev/null || true; fi
TDD_GATE_SPLIT=false
TDD_PLAN_TYPE=$(gsd_run query phase.tdd-applicable "{phase_dir}/{plan_file}" --pick plan_type 2>/dev/null || echo "")
if [ "$TDD_MODE" = "true" ] && [ "$TDD_PLAN_TYPE" = "tdd" ] && [ "${EXECUTOR_MODEL_SOURCE:-}" = "resolved" ] && [ "${ISOLATION:-}" != "orchestrator-worktree" ]; then
  if TDD_RED_MODEL=$(gsd_run query resolve-model "${EXECUTOR_TYPE}:tdd-red" --fallback-agent "$EXECUTOR_TYPE" --raw 2>/dev/null) \
    && TDD_GREEN_MODEL=$(gsd_run query resolve-model "${EXECUTOR_TYPE}:tdd-green-refactor" --fallback-agent "$EXECUTOR_TYPE" --raw 2>/dev/null); then
    [ "$TDD_RED_MODEL" != "$TDD_GREEN_MODEL" ] && TDD_GATE_SPLIT=true
  else
    echo "note: plan ${plan_id} could not resolve its TDD gate models, so it keeps a single dispatch." >&2
  fi
fi
printf 'TDD_GATE_SPLIT=%s\nTDD_RED_MODEL=%s\nTDD_GREEN_MODEL=%s\n' "$TDD_GATE_SPLIT" "${TDD_RED_MODEL:-}" "${TDD_GREEN_MODEL:-}"
```

When the printed `TDD_GATE_SPLIT` is `false`, stop here: dispatch exactly as step 3 says, with
`EXECUTOR_MODEL`. The rest of this file applies only when it is `true`.

## Split dispatch

A worktree is force-removed when its executor returns, and the GREEN dispatch must start from the RED
commit, so a split plan runs in the orchestrator's own tree, one dispatch after the other. The other
plans of the wave keep their isolation and their parallelism.

1. **Run in-tree.** Before each of the two dispatches, re-record the plan's isolation as `none`:

   ```bash
   gsd_run query dispatch-isolation --raw --phase "${PHASE_NUMBER:-}" --plan "$plan_id" --force-isolation none >/dev/null 2>&1 || true
   ```

   Treat `ISOLATION` as `none` for both dispatches: omit `{harnessFlag}`, embed no
   `<worktree_branch_check>` block, and register no worktree for this plan in the wave manifest.
2. **RED dispatch.** Emit the plan-start heartbeat, then dispatch the same `Agent()` prompt as step 3 with
   `model` set to `TDD_RED_MODEL` (omit `model=` when it is `inherit` or empty, the existing rule), add
   `gsd-core/references/tdd-gate-dispatch.md` to the embedded `<execution_context>` list, and add the
   line `TDD_GATE=red` to the `<objective>`. Drop the "Create SUMMARY.md" sentence from that objective.
3. **Verify the RED commit.** After the RED dispatch returns, confirm the git log holds the RED commit
   `test({phase}-{plan})` for this plan, using the commit-scope match in `references/tdd.md`
   ("Executor Gate Validation"). If it is absent, or the report carries a RED halt (`INVALID_RED`,
   unexpected pass), halt this plan: surface the executor's report, start no GREEN dispatch, and let
   the wave's normal failure handling apply.
4. **GREEN/REFACTOR dispatch.** Dispatch the same prompt again with `model` set to `TDD_GREEN_MODEL`
   (same omit rule), `gsd-core/references/tdd-gate-dispatch.md` embedded, and the line
   `TDD_GATE=green-refactor`. This dispatch creates `SUMMARY.md`; keep the "Create SUMMARY.md" sentence.
5. **Continue as usual.** The wave's spot-checks, SUMMARY handling and STATE/ROADMAP writes read the
   second dispatch's result, exactly as they read a single dispatch's.

Add nothing about checkpoints or auto-approval to either prompt (#3370).
