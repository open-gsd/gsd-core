# OpenCode V2 quick-batch lifecycle

Read this fragment only when `EXEC_JSON.exec.transport == "native-tool"`. It owns parent identity, active-round reconciliation, restart recovery, and the outer capacity-round loop. Native operations use only `gsd_worktree_task`; the notification is wake-up only, never status or authorization.

For `EXEC_TRANSPORT == "native-tool"`, this dedicated lifecycle and its dedicated
`opencode-v2-*.md` fragments are the exclusive native route. Process-based
`orchestrator-worktree` hosts retain the separate generic route. Before any V2 CLI
call, establish the canonical coordinator checkout and parent session identity:

```bash
ORCHESTRATOR_WT=$(git rev-parse --show-toplevel 2>/dev/null) || exit 1
ORCHESTRATOR_WT=$(cd "$ORCHESTRATOR_WT" && pwd -P) || exit 1
ORCH_BRANCH=$(git -C "$ORCHESTRATOR_WT" symbolic-ref --short HEAD 2>/dev/null) || exit 1
case "$ORCH_BRANCH" in
  agent-*|worktree-agent-*|worktree-wf_*)
    echo "FATAL: quick-batch coordinator is running in an agent worktree." >&2
    exit 1 ;;
esac
```

Call the exact descriptor-selected native model tool with
`{"action":"recover"}`. Require an object with a non-empty
`parent_session_id` matching `^ses`; set that returned value as
`PARENT_SESSION_ID`. Never guess it or derive it from environment, process,
path, or batch identifiers.

## Exclusive native Step 6–9 loop

This fragment is entered before generic Step 6. It is the only route that may run
for `EXEC_TRANSPORT == "native-tool"`; do **not** read or execute generic
`worktree-dispatch.md`, `merge-wave.md`, `verification-wave.md`, or `completion.md`.

For each active capacity round, read and execute these dedicated fragments in this
order:

1. `steps/opencode-v2-dispatch.md` — reconcile/allocate and create/start one exact
   complete seal. It may suspend after seal.
2. On a queued completion wake-up or explicit resume, `steps/opencode-v2-merge.md` —
   recover, obtain fresh status, attest, merge every round worktree, then teardown.
3. If `$VALIDATE_MODE`, `steps/opencode-v2-verification.md` — record the durable receipt.
4. `steps/opencode-v2-completion.md` — complete items, close/clean a fully completed
   round, reload eligibility, and loop to native dispatch.

A failed, blocked, or unfinished native round halts/preserves; it never falls
through to the generic Steps 6–9.

Run an outer lifecycle with at most `$ITEM_COUNT` new allocations. At the
start of each turn reconcile the sole active round:

```bash
_GSD_SHIM_NAME="gsd-tools.cjs"; _GSD_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; GSD_TOOLS="${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}"; _gsd_at() { for _p; do if [ -f "$_p" ]; then GSD_TOOLS="$_p"; return 0; fi; done; return 1; }; if _gsd_at "${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}"; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif unset -f gsd_run; _G="$(command -v gsd_run)"; then GSD_TOOLS="$_G"; gsd_run() { "$GSD_TOOLS" "$@"; }; elif _gsd_at "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/gsd-core/bin/${_GSD_SHIM_NAME}" "${HERMES_HOME:-$HOME/.hermes}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CURSOR_CONFIG_DIR:-$HOME/.cursor}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CODEX_HOME:-$HOME/.codex}/gsd-core/bin/${_GSD_SHIM_NAME}" "${GEMINI_CONFIG_DIR:-$HOME/.gemini}/gsd-core/bin/${_GSD_SHIM_NAME}" "${COPILOT_CONFIG_DIR:-$HOME/.copilot}/gsd-core/bin/${_GSD_SHIM_NAME}" "${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}/gsd-core/bin/${_GSD_SHIM_NAME}" "${AUGMENT_CONFIG_DIR:-$HOME/.augment}/gsd-core/bin/${_GSD_SHIM_NAME}" "${TRAE_CONFIG_DIR:-$HOME/.trae}/gsd-core/bin/${_GSD_SHIM_NAME}" "${QWEN_CONFIG_DIR:-$HOME/.qwen}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CLINE_CONFIG_DIR:-$HOME/.cline}/gsd-core/bin/${_GSD_SHIM_NAME}" "${GROK_AGENTS_HOME:-$HOME/.agents}/gsd-core/bin/${_GSD_SHIM_NAME}" "${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}/gsd-core/bin/${_GSD_SHIM_NAME}" "${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/gsd-core/bin/${_GSD_SHIM_NAME}" "${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}/gsd-core/bin/${_GSD_SHIM_NAME}"; then gsd_run() { node "$GSD_TOOLS" "$@"; }; else echo "ERROR: gsd-tools.cjs not found at $GSD_TOOLS and gsd_run is not on PATH. Run: npx -y @opengsd/gsd-core@latest --claude --local" >&2; exit 1; fi; GSD_IDENTITY_STATUS=unverified; case "$(gsd_run runtime-identity --raw 2>/dev/null || true)" in '{"packageName":"@opengsd/gsd-core"'*'}') GSD_IDENTITY_STATUS=ok;; esac; export GSD_IDENTITY_STATUS; [ "$GSD_IDENTITY_STATUS" = ok ] || echo "WARNING: \"$GSD_TOOLS\" did not prove it is @opengsd/gsd-core - it is either a different package or an @opengsd/gsd-core older than the runtime-identity verb. See docs/how-to/diagnose-a-foreign-gsd-tools.md" >&2; if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -n "${GSD_TOOLS:-}" ]; then printf "export PATH='%s':\"\$PATH\"\n" "${GSD_TOOLS%/*}" >> "$CLAUDE_ENV_FILE" 2>/dev/null || true; fi
QB_V2_RECONCILE=$(gsd_run quick-batch v2-reconcile \
  --parent-session "$PARENT_SESSION_ID" --batch "$BATCH_ID" --raw) || exit 1
```

The router unwraps a successful `{ok,value}` and exits nonzero for failure.
Every captured V2 payload must therefore be non-empty valid JSON with its
verb-specific emitted-value shape. Reject malformed/missing fields and retain
the active round. Resume `active` exactly; otherwise use `quick-batch resume`,
the existing DAG/spawn primitives, and Step 6 to allocate at most
`$EXEC_CONCURRENCY` items from the lowest eligible wave. Dependencies unlock
only after Step 9 records completion and the journal reaches `completed`.

After Step 6 seals the active capacity round as one exact complete wave,
end/suspend the current turn. Resume only from its queued
`gsd_worktree_wave_completed` notification or an explicit user resume. A
notification is only a wake-up signal; it never selects authoritative jobs or
authorizes merge. On every resume the same current parent calls `recover`
before journal reconciliation and then obtains fresh `status`. If OpenCode or
OpenChamber was restarted, resume the same parent session in the same canonical
project first; if either identity cannot be proved, halt with the round
preserved. Never poll, infer completion from files, or invoke a wait action.
Step 7 validates the complete sealed wave, merges every round item in original
order while every worktree remains present, and only then tears any item down.
Step 8 and the per-round portion of Step 9 follow.

When all round items are `completed`, Step 9 closes and cleans the round and
reloads the batch:

```bash
QB_ELIG_JSON=$(gsd_run quick-batch resume --batch "$BATCH_ID" --raw) || exit 1
```

Repeat while eligible work remains. A failed, blocked, or unfinished V2 round
stays active with its exact worktree/journal artifacts preserved. Only after
the outer loop terminates may Step 9 commit final artifacts and report.
SUMMARY files, old attestations, and historical notifications are evidence
only: they never skip V2 dispatch and never authorize a merge.
