# Wave-boundary refresh (#5966)

Read and follow this fragment from `execute-phase.md` step 9 of `execute_waves`, and from
`cross_ai_delegation` when delegation leaves `execute_waves` no plan to run. It owns the rule for what a
plain run does after each wave, so the host stays inside its byte budget.

A plain run here is one without `--wave` or `--interactive`. `--wave N` keeps its meaning: one wave,
then `partial-wave.md` decides what follows. `--interactive`, and a Copilot run that takes
`check_interactive_mode`'s inline path (`COPILOT_SEQUENTIAL`), run plans inline instead of
`execute_waves` and never read this fragment.

## The run's original scope

`RUN_SCOPE` is fixed once, by step 1 of `discover_and_group_plans`: the ids of every incomplete plan in
that first read that the `--gaps-only` filter (when set) keeps, whatever its `ready` or `blocked_by`
value. A refresh never widens it. A plan id that was not in that first read is never dispatched by this
run, even when it is ready.

## After each wave

1. **Reconcile first.** Every plan in the finished wave has reached a terminal state, and steps 5 to 8
   have run for it.
2. **Stop instead of refreshing** when any of these holds:
   - a checkpoint is still awaiting the user's response;
   - a failure is unresolved: a plan of the finished wave failed, and neither a retry completed it nor
     the user chose to continue at step 6 or 7;
   - every plan of the finished wave failed: `failure_handling`'s systemic stop, whatever was chosen.
3. **Re-read the index** from the orchestrator's worktree. Fenced blocks are separate shells, so the block
   re-pins the root the way the `execute_waves` cwd-drift guard does (#48), failing closed:

   ```bash
_GSD_SHIM_NAME="gsd-tools.cjs"; _GSD_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; GSD_TOOLS="${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}"; _gsd_at() { for _p; do if [ -f "$_p" ]; then GSD_TOOLS="$_p"; return 0; fi; done; return 1; }; _gsd_id_ok() { case "$("$1" runtime-identity --raw 2>/dev/null || true)" in '{"packageName":"@opengsd/gsd-core"'*'}') return 0;; *) return 1;; esac; }; _gsd_homes() { set -- "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" "${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}" "$HOME/.gemini/antigravity-ide" "$HOME/.gemini/antigravity-cli" "${AUGMENT_CONFIG_DIR:-$HOME/.augment}" "${CLINE_CONFIG_DIR:-$HOME/.cline}" "${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}" "${CODEX_HOME:-$HOME/.codex}" "${COPILOT_CONFIG_DIR:-${COPILOT_HOME:-$HOME/.copilot}}" "${CURSOR_CONFIG_DIR:-$HOME/.cursor}" "${HERMES_HOME:-$HOME/.hermes}" "${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}" "${KIMI_CONFIG_DIR:-$HOME/.config/agents}" "$HOME/.agents" "${KIMI_CODE_HOME:-$HOME/.kimi-code}" "${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}" "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}" "${QWEN_CONFIG_DIR:-$HOME/.qwen}" "${TRAE_CONFIG_DIR:-$HOME/.trae}" "${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}" "${ZCODE_CONFIG_DIR:-$HOME/.zcode}" "${GROK_AGENTS_HOME:-$HOME/.agents}"; for _h; do _gsd_at "$_h/gsd-core/bin/${_GSD_SHIM_NAME}" && return 0; done; return 1; }; if _gsd_at "${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}"; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif _gsd_homes; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif unset -f gsd_run; _G="$(command -v gsd_run)"; [ -n "$_G" ] && _gsd_id_ok "$_G"; then GSD_TOOLS="$_G"; gsd_run() { "$GSD_TOOLS" "$@"; }; else echo "ERROR: gsd-tools.cjs not found at $GSD_TOOLS and no identity-proving gsd_run is on PATH. Run: npx -y @opengsd/gsd-core@latest --claude --local" >&2; exit 1; fi; GSD_IDENTITY_STATUS=unverified; _gsd_id_ok gsd_run && GSD_IDENTITY_STATUS=ok; export GSD_IDENTITY_STATUS; [ "$GSD_IDENTITY_STATUS" = ok ] || echo "WARNING: \"$GSD_TOOLS\" did not prove it is @opengsd/gsd-core - it is either a different package or an @opengsd/gsd-core older than the runtime-identity verb. See docs/how-to/diagnose-a-foreign-gsd-tools.md" >&2; if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -n "${GSD_TOOLS:-}" ]; then printf "export PATH='%s':\"\$PATH\"\n" "${GSD_TOOLS%/*}" >> "$CLAUDE_ENV_FILE" 2>/dev/null || true; fi
   ORCHESTRATOR_WT=$(git rev-parse --show-toplevel 2>/dev/null) || { echo "FATAL: not inside a git worktree (#48)." >&2; exit 1; }
   case "$(git rev-parse --abbrev-ref HEAD 2>/dev/null)" in agent-*|worktree-agent-*|worktree-wf_*) echo "FATAL: orchestrator cwd is inside an agent worktree; run the execute_waves cwd-drift guard (#48)." >&2; exit 1 ;; esac
   PLAN_INDEX=$(cd "$ORCHESTRATOR_WT" && gsd_run query phase-plan-index "${PHASE_NUMBER}") || { echo "FATAL: the phase-plan-index re-read failed; stop, never dispatch from an empty index." >&2; exit 1; }
   ```

   Apply § Filtering from step 1 again, the #4628 readiness skip and the `blocked_by` skip included, then:
   - keep only plans in `RUN_SCOPE`;
   - drop every plan this run already dispatched (a retry belongs to step 6 or 7, never to a refresh);
   - drop every plan that depends, directly or through another dropped plan, on a plan this run saw fail
     at step 6 or 7 and the user continued past. The index counts a written SUMMARY as complete even when
     its spot-check failed; continuing lets the run go on, never the failed plan's dependents.

   This re-read is the only thing that widens the selection: a plan that became ready because its
   predecessor finished is dispatched here, never earlier. From here on, a plan's JSON (`id`,
   `files_modified` and the rest) comes from this read, not step 1's.
4. **Stop on no progress:** the refreshed selection is empty while an incomplete plan in `RUN_SCOPE`
   remains. Because a refresh never selects a plan this run already dispatched, it can never select the
   same plans again: each refresh either dispatches plans no earlier wave ran or stops here.
5. **Dispatch** the earliest wave of the refreshed selection along the path step 1's selection took.
   First run the pre-wave dependency check (step 7b) on that wave's plans, since it ran before this
   refresh chose them. Then `cross_ai_delegation` over that wave's plans only, then `execute_waves` from
   its entry, the cwd-drift guard first, for the plans delegation did not handle. When delegation
   handles all of them, run this fragment again from step 1.

**When the refreshed selection is empty and no incomplete plan in `RUN_SCOPE` remains**, the wave loop is
done. If the index lists an incomplete plan whose id was not in step 1's read, stop as below and name it.
Otherwise continue to `aggregate_results` as before.

## When the run stops

Every stop above ends here, including one where the index counts every plan complete because a
failed plan wrote its SUMMARY: this run counts that plan as failed. This is the partial-wave rule
(`partial-wave.md`) applied to a plain run, and it replaces
`aggregate_results` for this run. Print the `aggregate_results` table for what did run, headed
`## Phase {X}: {Name} Execution Stopped` instead of `Execution Complete`, then:

- Report every failed or incomplete plan in `RUN_SCOPE` by name with its reason: blocked by halted
  `{blocked_by}`; waiting on incomplete predecessors `{unresolved_dependencies}` (2b's form, from
  `ready-wave-gate.md`); waiting on failed `{plan ids}`; failed; or awaiting a checkpoint. Name every
  incomplete plan whose id was not in step 1's read as added after this run started.
- Do NOT run `verify_phase_goal`, and do NOT mark the phase complete in ROADMAP or STATE.
- Present the footer below, then exit: skip the rest of `execute-phase.md`.

```markdown
## Phase {X}: stopped with incomplete plans

{incomplete plan ids, each with its reason}

/gsd:execute-phase {phase} ${GSD_WS}                # Continue remaining waves once the reasons above are cleared
```
