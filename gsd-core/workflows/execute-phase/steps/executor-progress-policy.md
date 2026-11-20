Apply response_language to all user-facing prose — narration between tool calls, status updates, progress notes, and findings included; preserve code, paths, and identifiers.

# Executor Progress Policy (#4218)

Read this before treating any executor as stalled.

## A working executor is never steered

The stall threshold measures a period **without meaningful progress**. It is not a maximum
total runtime, and it is not a budget the executor has to finish inside. A plan with a long
verification or closeout tail legitimately spends many minutes between its last commit and
its SUMMARY.

Reconcile activity as well as artifacts:

- **Commits exist and SUMMARY.md is missing, with recent meaningful activity → KEEP
  WAITING.** Do not steer it, do not interrupt it, do not re-dispatch it. Recent
  RED/GREEN/REFACTOR commits, passing verification, or ongoing reasoning/tool telemetry
  from the child are all meaningful activity.
- **Only after `${EXECUTOR_STALL_THRESHOLD_MINUTES}` of no meaningful progress** — measured
  from the LAST sign of progress, not from dispatch — may the pause in step 3 fire, and it
  asks the user; it does not act on its own.

## Never inject urgency or finalization instructions into a live executor

Messages of the "Finalize immediately", "wrap up now", "you are taking too long" family are
forbidden: they arrive mid-verification and turn a correct run into a truncated one. If an
executor must be stopped, the pause in step 3 is the only route, and `kill and retry` is a
clean restart — not a nudge.

## The absence of a local OS test/build process is NOT idleness

The orchestrator cannot see the child's work that way. A native subagent runs in the
runtime's own session, not as a visible local process, and an executor between two tool
calls — reasoning, reading a file, waiting on a runtime round-trip — shows no process at
all. Judge progress ONLY by the signals this workflow names: commits on the expected
branch, the SUMMARY, and the child's own activity. A process listing is not one of them.

## A `harness-worktree` executor's commits are not on the expected branch (#6117)

For a plan dispatched with `isolation="worktree"` (its stored step-2.5 decision is `harness-worktree`), the executor
commits to its own temporary agent branch in its own worktree and writes its SUMMARY there. Both reach
`${EXPECTED_BRANCH}` and the phase directory only when step 5.5 merges the wave, so the `${EXPECTED_BRANCH}` probe
reads no progress from an executor that is committing normally. The agent branch is learned only after the `Agent()`
call returns (`worktree.record-agent`), so the probe asks the evaluation-scope resolver for the plan's commits across
every local branch (`--all-branches`, an explicit opt-in: the gates keep the reachable-from-ref contract), by the
token their subject carries (`type(<phase>-<plan>): …`, the same `${PHASE_NUMBER}-{plan_padded}` the completion
check above builds). Substitute `{plan_padded}` as the surrounding steps do.

```bash
_GSD_SHIM_NAME="gsd-tools.cjs"; _GSD_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; GSD_TOOLS="${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}"; _gsd_at() { for _p; do if [ -f "$_p" ]; then GSD_TOOLS="$_p"; return 0; fi; done; return 1; }; _gsd_id_ok() { case "$("$1" runtime-identity --raw 2>/dev/null || true)" in '{"packageName":"@opengsd/gsd-core"'*'}') return 0;; *) return 1;; esac; }; _gsd_homes() { set -- "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" "${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}" "$HOME/.gemini/antigravity-ide" "$HOME/.gemini/antigravity-cli" "${AUGMENT_CONFIG_DIR:-$HOME/.augment}" "${CLINE_CONFIG_DIR:-$HOME/.cline}" "${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}" "${CODEX_HOME:-$HOME/.codex}" "${COPILOT_CONFIG_DIR:-${COPILOT_HOME:-$HOME/.copilot}}" "${CURSOR_CONFIG_DIR:-$HOME/.cursor}" "${HERMES_HOME:-$HOME/.hermes}" "${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}" "${KIMI_CONFIG_DIR:-$HOME/.config/agents}" "$HOME/.agents" "${KIMI_CODE_HOME:-$HOME/.kimi-code}" "${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}" "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}" "${QWEN_CONFIG_DIR:-$HOME/.qwen}" "${TRAE_CONFIG_DIR:-$HOME/.trae}" "${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}" "${ZCODE_CONFIG_DIR:-$HOME/.zcode}" "${GROK_AGENTS_HOME:-$HOME/.agents}"; for _h; do _gsd_at "$_h/gsd-core/bin/${_GSD_SHIM_NAME}" && return 0; done; return 1; }; if _gsd_at "${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}"; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif _gsd_homes; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif unset -f gsd_run; _G="$(command -v gsd_run)"; [ -n "$_G" ] && _gsd_id_ok "$_G"; then GSD_TOOLS="$_G"; gsd_run() { "$GSD_TOOLS" "$@"; }; else echo "ERROR: gsd-tools.cjs not found at $GSD_TOOLS and no identity-proving gsd_run is on PATH. Run: npx -y @opengsd/gsd-core@latest --claude --local" >&2; exit 1; fi; GSD_IDENTITY_STATUS=unverified; _gsd_id_ok gsd_run && GSD_IDENTITY_STATUS=ok; export GSD_IDENTITY_STATUS; [ "$GSD_IDENTITY_STATUS" = ok ] || echo "WARNING: \"$GSD_TOOLS\" did not prove it is @opengsd/gsd-core - it is either a different package or an @opengsd/gsd-core older than the runtime-identity verb. See docs/how-to/diagnose-a-foreign-gsd-tools.md" >&2; if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -n "${GSD_TOOLS:-}" ]; then printf "export PATH='%s':\"\$PATH\"\n" "${GSD_TOOLS%/*}" >> "$CLAUDE_ENV_FILE" 2>/dev/null || true; fi
LAST_PLAN_COMMIT=$(gsd_run check evaluation-scope --plan "${PHASE_NUMBER}-{plan_padded}" --all-branches --commits-only --committed-since "${DISPATCH_TS}" --raw 2>/dev/null | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const t=JSON.parse(s).latestCommitTime;process.stdout.write(t?String(t):'')}catch{}})") || LAST_PLAN_COMMIT=""
```

Re-run it every `${EXECUTOR_STALL_INTERVAL_MINUTES}` minutes with the other probes. The no-progress clock runs from the
LATEST of: the dispatch, the newest `${EXPECTED_BRANCH}` commit, and `LAST_PLAN_COMMIT` (epoch seconds; an empty value
is no signal). The pause fires only when that moment is `${EXECUTOR_STALL_THRESHOLD_MINUTES}` or more minutes ago and
no completion signal and no SUMMARY exists. An empty result also covers a scope the resolver could not read: that
never counts as progress, and it never kills or steers the executor.

Only `harness-worktree` plans use this probe; plans on `none` (sequential) keep the `${EXPECTED_BRANCH}` probe. The
`orchestrator-worktree` and Cursor harness paths were not verified against this and keep the `${EXPECTED_BRANCH}`
probe too. The match is by commit subject and committer date, so a rebase or cherry-pick of an old plan commit, or a
concurrent run of the same phase and plan in another worktree, can read as progress; that errs toward waiting, which
is the safe side of the pause.

## If a stalled executor ran in an isolated worktree

`kill and switch to inline execution` edits the primary checkout — see worktree recovery
policy (`execute-phase/steps/worktree-recovery-policy.md`). Prefer `kill and retry` in a
fresh worktree; inline execution requires explicit confirmation, never the default.
