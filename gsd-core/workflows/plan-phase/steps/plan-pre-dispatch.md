# Plan:Pre Generic Step and Gate Dispatch (#5982)

Implements @gsd-core/references/loop-hook-dispatch.md for `plan:pre`. Read `activeHooks` from `PLAN_PRE_HOOKS_JSON` in-context. This runs in **manual and auto-chain mode alike**, before the planner is spawned — a resolved hook is dispatched, never silently dropped.

**Dedicated sections.** These `capId`s own a `plan:pre` step or gate that a named section of `plan-phase.md` already runs with its own mode-specific behavior. Skip their `step` and `gate` entries here so none runs twice; dispatch **every other** active `step` and `gate`, first-party or third-party, in array order. (Contributions are injected at §5.55 and §8, not here.)

| capId | Section | What that section owns |
|---|---|---|
| `research` | §5 | the research step, behind §5's research decision |
| `drift` | §4.6 | the context-drift gate (§4.6) and the codebase-drift gate (§5.65), both non-blocking |
| `ui` | §5.6 | the `ui-phase` step and the `ui.plan-gate` gate (Branches 2–6) |
| `ai-integration` | §5.6 | the AI-integration step (pipeline: skill; manual: recommendation) |
| `pattern-mapper` | §7.8 | the pattern-mapper agent step, which needs `RESEARCH_PATH` |
| `intel` | §7.9 | the `intel api-surface` command step, which sets `API_SURFACE_PATH` |

If no active `step` or `gate` remains after that, `PLAN_PRE_PRODUCTS` stays empty; return to §5.6. Otherwise make sure the phase values the dispatch lines carry are set — §1 already parsed them from `INIT`, so each is only filled when empty:

```bash
_GSD_SHIM_NAME="gsd-tools.cjs"; _GSD_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; GSD_TOOLS="${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}"; _gsd_at() { for _p; do if [ -f "$_p" ]; then GSD_TOOLS="$_p"; return 0; fi; done; return 1; }; _gsd_id_ok() { case "$("$1" runtime-identity --raw 2>/dev/null || true)" in '{"packageName":"@opengsd/gsd-core"'*'}') return 0;; *) return 1;; esac; }; _gsd_homes() { set -- "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" "${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}" "$HOME/.gemini/antigravity-ide" "$HOME/.gemini/antigravity-cli" "${AUGMENT_CONFIG_DIR:-$HOME/.augment}" "${CLINE_CONFIG_DIR:-$HOME/.cline}" "${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}" "${CODEX_HOME:-$HOME/.codex}" "${COPILOT_CONFIG_DIR:-${COPILOT_HOME:-$HOME/.copilot}}" "${CURSOR_CONFIG_DIR:-$HOME/.cursor}" "${HERMES_HOME:-$HOME/.hermes}" "${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}" "${KIMI_CONFIG_DIR:-$HOME/.config/agents}" "$HOME/.agents" "${KIMI_CODE_HOME:-$HOME/.kimi-code}" "${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}" "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}" "${QWEN_CONFIG_DIR:-$HOME/.qwen}" "${TRAE_CONFIG_DIR:-$HOME/.trae}" "${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}" "${ZCODE_CONFIG_DIR:-$HOME/.zcode}" "${GROK_AGENTS_HOME:-$HOME/.agents}"; for _h; do _gsd_at "$_h/gsd-core/bin/${_GSD_SHIM_NAME}" && return 0; done; return 1; }; if _gsd_at "${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}"; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif _gsd_homes; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif unset -f gsd_run; _G="$(command -v gsd_run)"; [ -n "$_G" ] && _gsd_id_ok "$_G"; then GSD_TOOLS="$_G"; gsd_run() { "$GSD_TOOLS" "$@"; }; else echo "ERROR: gsd-tools.cjs not found at $GSD_TOOLS and no identity-proving gsd_run is on PATH. Run: npx -y @opengsd/gsd-core@latest --claude --local" >&2; exit 1; fi; GSD_IDENTITY_STATUS=unverified; _gsd_id_ok gsd_run && GSD_IDENTITY_STATUS=ok; export GSD_IDENTITY_STATUS; [ "$GSD_IDENTITY_STATUS" = ok ] || echo "WARNING: \"$GSD_TOOLS\" did not prove it is @opengsd/gsd-core - it is either a different package or an @opengsd/gsd-core older than the runtime-identity verb. See docs/how-to/diagnose-a-foreign-gsd-tools.md" >&2; if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -n "${GSD_TOOLS:-}" ]; then printf "export PATH='%s':\"\$PATH\"\n" "${GSD_TOOLS%/*}" >> "$CLAUDE_ENV_FILE" 2>/dev/null || true; fi
IFS= read -rd '' GSD_ARGS <<'GSD_ARGS_END' || true
$ARGUMENTS
GSD_ARGS_END
GSD_ARGS=${GSD_ARGS%$'\n'}
GSD_WS=$(echo " $GSD_ARGS" | sed -nE 's/.* --ws +([A-Za-z0-9][A-Za-z0-9._-]*).*/--ws \1/p' | head -n 1)
PHASE_NUMBER="${PHASE_NUMBER:-$(gsd_run query init.plan-phase ${GSD_WS:+--ws=${GSD_WS##* }} "$PHASE" --pick phase_number 2>/dev/null)}"
PHASE_DIR="${PHASE_DIR:-$(gsd_run query init.plan-phase ${GSD_WS:+--ws=${GSD_WS##* }} "$PHASE" --pick phase_dir 2>/dev/null)}"
PHASE_DIR="${PHASE_DIR:-$(gsd_run query init.plan-phase ${GSD_WS:+--ws=${GSD_WS##* }} "$PHASE" --pick expected_phase_dir 2>/dev/null)}"
PHASE_REQ_IDS="${PHASE_REQ_IDS:-$(gsd_run query init.plan-phase ${GSD_WS:+--ws=${GSD_WS##* }} "$PHASE" --pick phase_req_ids 2>/dev/null)}"
PHASE_REQ_IDS="${PHASE_REQ_IDS:-TBD}"
AUTO_CHAIN=$(gsd_run query check auto-mode --pick auto_chain_active 2>/dev/null)
AUTO_CHAIN="${AUTO_CHAIN:-false}"
echo "PHASE_DIR=${PHASE_DIR}"
```

## Steps

For each remaining active entry where `kind == "step"` (exactly one of `ref.skill`, `ref.agent`, `ref.command` is set):

- **`ref.skill`** → `Skill(skill="gsd-${ref.skill}", args="${PHASE} ${GSD_WS}")`, appending `--auto` to `args` only when `AUTO_CHAIN` is `true`. Prepend `gsd-` to `ref.skill`.
- **`ref.agent`** → print `◆ Spawning ${ref.agent}... (runs in a subagent — no output until it returns; expected, not a freeze)`, then `Agent(prompt=filled_hook_fragment, subagent_type=ref.agent, model="{researcher_model}")` with the hook's `fragment.inline` as the prompt body, phase fields filled. Omit `model=` when `researcher_model` is `"inherit"` or empty (#2517).
- **`ref.command`** → validate it IN-CONTEXT before any shell use: the value must match `^[a-z][a-z0-9-]*( [a-z][a-z0-9-]*)*$`. Check it yourself — never by pasting it into a shell command to be tested there. A value that fails is a malformed manifest: record a warning naming the `capId`, skip it, continue. Only a value that passed is run:

  ```bash
  # shellcheck disable=SC2086 # the validated command is a family and subcommand: splitting it into two words is intended
  gsd_run ${ref.command} --phase "${PHASE_NUMBER}" --raw
  ```

Wait for each result before the next hook. A step is advisory: on error record a warning naming the `capId` and continue, unless `onError == "halt"` — then surface the error and stop the plan-phase workflow.

## Gates

For each remaining active entry where `kind == "gate"`, in array order. ⚠ **Validate `check` before shell use** (third-party manifest input; `loop-hook-dispatch.md` § `gate`): replace every `.` in `check.query` with `-`, check that normalized value against `^[a-z][a-z0-9]*(-[a-z0-9]+)*( [a-z][a-z0-9]*(-[a-z0-9]+)*)*$` in-context, and write the dot-normalized query wherever `${hook.check.query}` appears below. Serialize `check.predicate` to compact one-line JSON and pass it as a **single argv element** through the quoted heredoc below — never re-quote it into a shell string, where an apostrophe would close the literal. A malformed check is routed per `onError` in step 1, never run.

```bash
# named-query gate (the validated query may be several words; splitting it is intended):
# shellcheck disable=SC2086
GATE_RESULT=$(gsd_run check ${hook.check.query} "${PHASE_DIR}" "${PHASE_REQ_IDS}" --raw) && CHECK_EXIT=0 || CHECK_EXIT=$?
```
OR, for a `predicate` gate (ADR-2008):
```bash
IFS= read -rd '' PREDICATE_JSON <<'GSD_PREDICATE_END' || true
<hook.check.predicate as compact one-line JSON>
GSD_PREDICATE_END
PREDICATE_JSON=${PREDICATE_JSON%$'\n'}
GATE_RESULT=$(gsd_run check predicate --predicate "$PREDICATE_JSON" --phase-dir "${PHASE_DIR}" --phase-number "${PHASE_NUMBER}" --phase-req-ids "${PHASE_REQ_IDS}" --raw) && CHECK_EXIT=0 || CHECK_EXIT=$?
```

A gate carrying neither — including an `agentVerdict` check, which has no runner at `plan:pre` — cannot be evaluated here: record a warning naming the `capId` and treat it as a check-command failure in step 1, **never** as a silent pass.

**Step 1 — did the check command fail?** (malformed check, non-zero `CHECK_EXIT` including `69` UNAVAILABLE, empty output, or unparseable JSON — its `block` is not a verdict):
- `onError == "halt"` → surface `⚠ plan:pre gate check failed ({hook.capId})` with the error and stop the plan-phase workflow.
- otherwise → record a warning naming the `capId` and continue to the next gate.

**Step 2 — read `GATE_RESULT.block`:**
- `blocking == true` and `block == true` → output `⚠ Planning blocked by capability gate ({hook.capId}): {message}` (`check.message`, plus the result's own `message` when it has one) and **EXIT the plan-phase workflow. Do not spawn the planner.**
- `blocking == false` → advisory: surface the message when `block` is `true`, and continue.
- `block == false` → continue silently.

## Products for the planner (#5960)

A step dispatched above hands its declared `produces` files to the planner, so a capability's plan:pre output (for example MemPalace's `MEMORY-RECALL.md`) is read, and only when its step was active this run. Validate each `produces` entry IN-CONTEXT against `^[A-Za-z0-9][A-Za-z0-9._-]*$` (a bare file name: no `/`, no leading `.`); record a warning naming the `capId` and drop a name that fails. Then put the remaining names of the dispatched steps, space-separated, in place of the placeholder:

```bash
# Plan:pre products (#5960)
IFS= read -rd '' _PHASE_DIR_IN <<'GSD_PHASE_DIR_END' || true
<PHASE_DIR from the phase-value block above>
GSD_PHASE_DIR_END
PHASE_DIR="${PHASE_DIR:-${_PHASE_DIR_IN%$'\n'}}"
PLAN_PRE_PRODUCES='<validated produces names of the steps dispatched above, space-separated>'
[ -n "${PLAN_PRE_PRODUCES}" ] && [ -z "${PHASE_DIR}" ] && echo "WARNING: plan:pre products not collected — PHASE_DIR is empty" >&2
PLAN_PRE_PRODUCTS=""
# shellcheck disable=SC2046 # validated bare file names: splitting the substitution is intended
for _f in $(printf '%s' "$PLAN_PRE_PRODUCES"); do
  if [ -n "${PHASE_DIR}" ] && [ -f "${PHASE_DIR}/${_f}" ]; then PLAN_PRE_PRODUCTS="${PLAN_PRE_PRODUCTS:+${PLAN_PRE_PRODUCTS}, }${PHASE_DIR}/${_f}"; fi
done
echo "PLAN_PRE_PRODUCTS=${PLAN_PRE_PRODUCTS}"
```

`PLAN_PRE_PRODUCTS` is listed in the §8 planner `<required_reading>`; it stays empty when no dispatched step wrote its file. A dedicated-section capability's output (RESEARCH.md, PATTERNS.md, UI-SPEC.md, ...) reaches the planner through its own section, not this list. Shell variables do not survive between tool calls, so fill the `PHASE_DIR` value the phase-value block printed into the quoted heredoc as well.

When every remaining hook has been handled, return to §5.6.
