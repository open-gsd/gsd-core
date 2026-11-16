# Execute:pre Capability Dispatch (execute:pre)

The whole execute:pre dispatch, extracted from the host's `discover_and_group_plans` step (#5848; the host file carries a frozen pre-phase-6 byte ceiling, #1168, so dispatch lives here). The host reaches this step once, after plan discovery and before STATE.md records the phase start. For gates it mirrors `wave-post-gate-hooks.md`. The difference is what a block stops: here it stops the whole phase before any plan is dispatched and before STATE.md records the phase start.

```bash
_GSD_SHIM_NAME="gsd-tools.cjs"; _GSD_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; GSD_TOOLS="${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}"; _gsd_at() { for _p; do if [ -f "$_p" ]; then GSD_TOOLS="$_p"; return 0; fi; done; return 1; }; _gsd_id_ok() { case "$("$1" runtime-identity --raw 2>/dev/null || true)" in '{"packageName":"@opengsd/gsd-core"'*'}') return 0;; *) return 1;; esac; }; _gsd_homes() { set -- "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" "${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}" "$HOME/.gemini/antigravity-ide" "$HOME/.gemini/antigravity-cli" "${AUGMENT_CONFIG_DIR:-$HOME/.augment}" "${CLINE_CONFIG_DIR:-$HOME/.cline}" "${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}" "${CODEX_HOME:-$HOME/.codex}" "${COPILOT_CONFIG_DIR:-${COPILOT_HOME:-$HOME/.copilot}}" "${CURSOR_CONFIG_DIR:-$HOME/.cursor}" "${HERMES_HOME:-$HOME/.hermes}" "${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}" "${KIMI_CONFIG_DIR:-$HOME/.config/agents}" "$HOME/.agents" "${KIMI_CODE_HOME:-$HOME/.kimi-code}" "${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}" "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}" "${QWEN_CONFIG_DIR:-$HOME/.qwen}" "${TRAE_CONFIG_DIR:-$HOME/.trae}" "${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}" "${ZCODE_CONFIG_DIR:-$HOME/.zcode}" "${GROK_AGENTS_HOME:-$HOME/.agents}"; for _h; do _gsd_at "$_h/gsd-core/bin/${_GSD_SHIM_NAME}" && return 0; done; return 1; }; if _gsd_at "${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}"; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif _gsd_homes; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif unset -f gsd_run; _G="$(command -v gsd_run)"; [ -n "$_G" ] && _gsd_id_ok "$_G"; then GSD_TOOLS="$_G"; gsd_run() { "$GSD_TOOLS" "$@"; }; else echo "ERROR: gsd-tools.cjs not found at $GSD_TOOLS and no identity-proving gsd_run is on PATH. Run: npx -y @opengsd/gsd-core@latest --claude --local" >&2; exit 1; fi; GSD_IDENTITY_STATUS=unverified; _gsd_id_ok gsd_run && GSD_IDENTITY_STATUS=ok; export GSD_IDENTITY_STATUS; [ "$GSD_IDENTITY_STATUS" = ok ] || echo "WARNING: \"$GSD_TOOLS\" did not prove it is @opengsd/gsd-core - it is either a different package or an @opengsd/gsd-core older than the runtime-identity verb. See docs/how-to/diagnose-a-foreign-gsd-tools.md" >&2; if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -n "${GSD_TOOLS:-}" ]; then printf "export PATH='%s':\"\$PATH\"\n" "${GSD_TOOLS%/*}" >> "$CLAUDE_ENV_FILE" 2>/dev/null || true; fi
EXECUTE_PRE_HOOKS_JSON=$(gsd_run loop render-hooks execute:pre --raw)
```

Read `activeHooks` in-context. When it is empty, return to the host step silently.

**Contribution dispatch:** inject every `kind == "contribution"` fragment per @gsd-core/references/loop-hook-dispatch.md (skip when none).

**Step dispatch:** dispatch every `kind == "step"` hook per @gsd-core/references/loop-hook-dispatch.md. A step never blocks. ⚠ Validate `ref.command` in-context before any shell use.

## Gate evaluation

⚠ **Validate `check` before shell use** (third-party manifest input; wherever `${hook.check.query}` appears, write the dot-normalized query, each `.` as `-`, and validate and pass that same value) — `gsd-core/references/loop-hook-dispatch.md` § `gate`.

**For each active entry where `kind == "gate"`** (process in array order), run the gate check — a `predicate` gate uses the check CLI's `predicate` form with the predicate JSON, phase directory and phase number (shown in the second block below):

When `check.query` is set (a named-query gate):

```bash
# same shell as the block above: gsd_run is already defined by its preamble
GATE_RESULT=$(gsd_run check "${hook.check.query}" "${PHASE_NUMBER}" --raw) && CHECK_EXIT=0 || CHECK_EXIT=$?
```

When `check.predicate` is set (a predicate gate), pass every phase value this step holds (`phase_dir` and `phase_number` from the init bundle):

```bash
# same shell as the block above: gsd_run is already defined by its preamble
GATE_RESULT=$(gsd_run check predicate --predicate '<predicate JSON>' --phase-dir "${PHASE_DIR}" --phase-number "${PHASE_NUMBER}" --raw) && CHECK_EXIT=0 || CHECK_EXIT=$?
```

**Step 1 — did the CHECK COMMAND itself succeed?**

If the check command failed (non-zero `CHECK_EXIT`, empty output, or unparseable JSON):
- `onError == "halt"` → treat as a fatal error: HALT the phase, do NOT dispatch any plan and do NOT run `state.begin-phase`, and surface: `⚠ Gate check command failed ({hook.capId}): command error. Resolve before continuing.`
- `onError == "skip"` → log a warning and continue to the next hook. Do NOT read `GATE_RESULT.block`.

**Step 2 — read `GATE_RESULT.block` (boolean).** This step is only reached when the command succeeded.

- **Blocking gate (`hook.blocking == true`) AND `GATE_RESULT.block == true`:** HALT — do NOT dispatch any plan, do NOT run `state.begin-phase`, leave STATE.md unchanged, and present:

  ```
  ⚠ Phase {PHASE_NUMBER} execution blocked by capability gate ({hook.capId}): {GATE_RESULT.message}
  Resolve before re-running /gsd:execute-phase.
  ```

  This halt is **not** bypassed by `onError` — `onError` only covers command errors (step 1 above), not the gate's block decision.

- **Non-blocking gate (`hook.blocking == false`):** never halts. If `GATE_RESULT.block` is `true` (or non-empty `message`), print `⚠ {hook.capId} advisory (phase {PHASE_NUMBER}): {GATE_RESULT.message}` and continue. If block `false` and no `message`: continue silently.

- **Blocking gate (`hook.blocking == true`) AND `GATE_RESULT.block == false`:** continue silently.

**When all active gates are processed without a blocking halt:** continue to the STATE.md phase-start update in the host step.
