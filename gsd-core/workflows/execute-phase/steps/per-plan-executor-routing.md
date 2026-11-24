<!-- PHASE-ID-CONVENTION:START -->
Resolve phase_id_convention independently of phase_naming. Use returned paths; never derive them from display labels.
Use CLI display_id when present; otherwise use reference grammar. Before emitting identities, Read `~/.claude/gsd-core/references/phase-id-convention.md`.
<!-- PHASE-ID-CONVENTION:END -->

# Per-plan executor routing (#1689)

Run for each plan, immediately before its `Agent()` dispatch in step 3. Sets
`EXECUTOR_TYPE` so a plan can opt into a specialist executor instead of the
default `gsd-executor`. `plan_id` (the current plan's id, same scope step 2.5 uses) and
`PHASE_NUMBER` are in scope.

## Contract

- Default: `EXECUTOR_TYPE="gsd-executor"` — byte-identical to pre-#1689 dispatch.
- A plan opts into a specialist by declaring `agent_hint: <name>` in its PLAN.md
  frontmatter (parsed by `phase-plan-index`; unset means `gsd-executor`).
- When routing is enabled AND the hint is non-empty AND the named agent resolves
  on the active runtime, `EXECUTOR_TYPE` becomes the hint. Otherwise it stays
  `gsd-executor`.
- The resolved `EXECUTOR_TYPE` is used as `subagent_type` in BOTH worktree and
  sequential dispatch (sequential reuses the worktree-mode `Agent()` template).
- Routing and the record use the same resolution from the plan on disk (#6213): this block calls
  `resolve-agent --phase --plan`, and the `per-plan-worktree-gate.md` Part 2 `dispatch-isolation`
  call derives the recorded `executor_type` through that same function. Neither reads a value
  carried from the other, so it does not matter which tool call this block ran in.
- `EXECUTOR_MODEL` resolves by the hinted name, falling back to `gsd-executor`'s model when the
  hint has no `model_overrides` entry and no catalog tier. The block prints both values and the model source; the
  orchestrator uses the printed `EXECUTOR_TYPE` for `subagent_type="{EXECUTOR_TYPE}"` and, for THIS
  plan's dispatch, the printed `EXECUTOR_MODEL` as `{executor_model}` in the `Agent()` template,
  omitting `model=` when it is empty or `inherit` (the existing execute-phase rule). That omit
  rule applies only when `EXECUTOR_MODEL_SOURCE=resolved`. When the printed source is `init` the
  resolve failed: the orchestrator uses init's `{executor_model}` unchanged and ignores the empty
  `EXECUTOR_MODEL`.
- A hint naming a GSD non-executor role (for example `gsd-verifier`) is refused:
  `resolve-agent` prints a warning and `EXECUTOR_TYPE` stays `gsd-executor`.
- Effort comes from the hinted agent's own frontmatter; no `effort=` is passed.
- A plan may instead declare `executor_runtime: <id>` (never together with `agent_hint`; refused at
  validation). With `workflow.cross_runtime_execution` on, the `dispatch-isolation` route resolves it
  to that runtime's own process-spawn exec; `execute-phase/steps/cross-runtime-executor-dispatch.md`
  runs the launch. Every unhappy case falls back to this block's host dispatch (#6303).

## Resolution

```bash
_GSD_SHIM_NAME="gsd-tools.cjs"; _GSD_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; GSD_TOOLS="${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}"; _gsd_at() { for _p; do if [ -f "$_p" ]; then GSD_TOOLS="$_p"; return 0; fi; done; return 1; }; _gsd_id_ok() { case "$("$1" runtime-identity --raw 2>/dev/null || true)" in '{"packageName":"@opengsd/gsd-core"'*'}') return 0;; *) return 1;; esac; }; _gsd_homes() { set -- "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" "${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}" "$HOME/.gemini/antigravity-ide" "$HOME/.gemini/antigravity-cli" "${AUGMENT_CONFIG_DIR:-$HOME/.augment}" "${CLINE_CONFIG_DIR:-$HOME/.cline}" "${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}" "${CODEX_HOME:-$HOME/.codex}" "${COPILOT_CONFIG_DIR:-${COPILOT_HOME:-$HOME/.copilot}}" "${CURSOR_CONFIG_DIR:-$HOME/.cursor}" "${HERMES_HOME:-$HOME/.hermes}" "${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}" "${KIMI_CONFIG_DIR:-$HOME/.config/agents}" "$HOME/.agents" "${KIMI_CODE_HOME:-$HOME/.kimi-code}" "${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}" "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}" "${QWEN_CONFIG_DIR:-$HOME/.qwen}" "${TRAE_CONFIG_DIR:-$HOME/.trae}" "${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}" "${ZCODE_CONFIG_DIR:-$HOME/.zcode}" "${GROK_AGENTS_HOME:-$HOME/.agents}"; for _h; do _gsd_at "$_h/gsd-core/bin/${_GSD_SHIM_NAME}" && return 0; done; return 1; }; if _gsd_at "${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}"; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif _gsd_homes; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif unset -f gsd_run; _G="$(command -v gsd_run)"; [ -n "$_G" ] && _gsd_id_ok "$_G"; then GSD_TOOLS="$_G"; gsd_run() { "$GSD_TOOLS" "$@"; }; else echo "ERROR: gsd-tools.cjs not found at $GSD_TOOLS and no identity-proving gsd_run is on PATH. Run: npx -y @opengsd/gsd-core@latest --claude --local" >&2; exit 1; fi; GSD_IDENTITY_STATUS=unverified; _gsd_id_ok gsd_run && GSD_IDENTITY_STATUS=ok; export GSD_IDENTITY_STATUS; [ "$GSD_IDENTITY_STATUS" = ok ] || echo "WARNING: \"$GSD_TOOLS\" did not prove it is @opengsd/gsd-core - it is either a different package or an @opengsd/gsd-core older than the runtime-identity verb. See docs/how-to/diagnose-a-foreign-gsd-tools.md" >&2; if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -n "${GSD_TOOLS:-}" ]; then printf "export PATH='%s':\"\$PATH\"\n" "${GSD_TOOLS%/*}" >> "$CLAUDE_ENV_FILE" 2>/dev/null || true; fi
# One resolution from the plan on disk: the routing toggle (workflow.agent_hint_routing, default
# on), the plan's own agent_hint and the installed-agent check, the same one the dispatch-isolation
# record uses. stderr stays visible: a refused GSD-role hint prints its warning there (stdout is the name only).
EXECUTOR_TYPE=$(gsd_run query resolve-agent --phase "${PHASE_NUMBER:-}" --plan "$plan_id" --raw || echo "gsd-executor")

# #6213: the model follows the routed executor (hinted name first, gsd-executor's tier when the
# hint has no model_overrides entry and no catalog tier). A failed resolve is NOT "omit model=":
# it prints EXECUTOR_MODEL_SOURCE=init and the orchestrator keeps init's {executor_model}.
if EXECUTOR_MODEL=$(gsd_run query resolve-model "$EXECUTOR_TYPE" --fallback-agent gsd-executor --raw 2>/dev/null); then
  EXECUTOR_MODEL_SOURCE=resolved
else
  EXECUTOR_MODEL=""
  EXECUTOR_MODEL_SOURCE=init
fi

# #1689 v1 routes only the Agent()-based dispatch. On the orchestrator-worktree
# backend (process-spawn; no subagent_type) a routed hinted executor cannot be honored
# yet — surface it so a set hint is never silently ignored.
if [ "${ISOLATION:-}" = "orchestrator-worktree" ] && [ "$EXECUTOR_TYPE" != "gsd-executor" ]; then
  echo "note: plan ${plan_id} routed to executor '${EXECUTOR_TYPE}', but orchestrator-worktree dispatch does not route subagent types in this release — using the default executor." >&2
fi

# The orchestrator reads these three lines and substitutes them into the Agent() template.
printf 'EXECUTOR_TYPE=%s\nEXECUTOR_MODEL=%s\nEXECUTOR_MODEL_SOURCE=%s\n' "$EXECUTOR_TYPE" "$EXECUTOR_MODEL" "$EXECUTOR_MODEL_SOURCE"
```

`gsd_run query resolve-agent` consults the **active runtime's agent directory**
(both project-local and user-global, across runtime filename variants — `.md`,
`.agent.md`, `.toml`, the kimi `subagents/<name>.{yaml,md}` pair) and fails
closed to `gsd-executor` when the named agent does not resolve or on any error,
so a missing or misspelled hint never blocks dispatch.

## Scope

Routing applies to the `Agent()`-based dispatch (harness-worktree and sequential
modes). The `orchestrator-worktree` isolation backend spawns executors via a
separate process path that has no `subagent_type` and is not routed in this
release.

## Checkpoint gate rule (#3370)

Loaded with the routing resolution so the orchestrator reads it immediately
before composing each dispatch prompt, in every isolation mode.

On `checkpoint:human-verify` / `checkpoint:decision` tasks, `gate="blocking"`
(the default) is auto-approvable in auto-mode — that is the executor's own
`<checkpoint_protocol>` (`agents/gsd-executor.md`), and `checkpoints.md` (the
full gate table) is embedded in the dispatch `<execution_context>` verbatim.
Only `gate="blocking-human"` always surfaces to a human, regardless of
auto-mode. An unmet `<precondition>` checkpoint (executor step 0, `Blocked by:
Precondition not met` — unmet `user_setup` step, missing env var, absent
prior-phase artifact) reports `blocking-human` and therefore always surfaces
to a human, in every mode (#3210): the missing prerequisite is a fact only a
human can establish, not a verification step to rubber-stamp.

When composing the `Agent()` prompt, do NOT add text refusing or overriding
auto-approval for a `blocking` gate. Orchestrator-composed instructions that contradict the
executor's protocol win the executor's attention, stall autonomous runs at the
checkpoint, and defeat `_auto_chain_active`/auto-advance for the common case.
Executor-side gate semantics are already complete; compose nothing about gates
beyond what the template already embeds.
