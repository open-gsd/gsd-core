# Completion reconciliation (#4217, split A of #3754)

Read and follow this fragment from `execute-phase.md` step 4 whenever an executor's
completion is in question. It owns the whole reconciliation policy — both arms — so the
host wait step stays inside the ADR-857 Phase 6 byte ceiling (#1168).

**Reconcile FIRST, classify SECOND.** How the child's session ended is bookkeeping
about the transport; what it wrote to disk and to git is the evidence about the work.

## When this runs

1. **No terminal response** — a spawned agent does not return a normal terminal
   completion signal but appears to have finished its work (or may still be running).
2. **Abnormal end** — the child's session ended without a normal terminal completion
   response: interrupted, aborted, closed, killed, timed out, or ended `turn_aborted` —
   INCLUDING ends the orchestrator itself initiated. **An abnormally-ended child is
   not evidence of failure (#4217):** the orchestrator's own interrupt/close says
   nothing about whether the work completed; only the artifacts do.

This policy applies to EVERY runtime and every isolation path — harness `Agent()`
dispatches, orchestrator-worktree process spawns, and sequential dispatch alike. Never
block indefinitely waiting for a signal; verify via filesystem and git state.

## Probes (per plan in the wave)

```bash
_GSD_SHIM_NAME="gsd-tools.cjs"; _GSD_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; GSD_TOOLS="${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}"; _gsd_at() { for _p; do if [ -f "$_p" ]; then GSD_TOOLS="$_p"; return 0; fi; done; return 1; }; _gsd_id_ok() { case "$("$1" runtime-identity --raw 2>/dev/null || true)" in '{"packageName":"@opengsd/gsd-core"'*'}') return 0;; *) return 1;; esac; }; _gsd_homes() { _gsd_at "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/gsd-core/bin/${_GSD_SHIM_NAME}" "${HERMES_HOME:-$HOME/.hermes}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CURSOR_CONFIG_DIR:-$HOME/.cursor}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CODEX_HOME:-$HOME/.codex}/gsd-core/bin/${_GSD_SHIM_NAME}" "${GEMINI_CONFIG_DIR:-$HOME/.gemini}/gsd-core/bin/${_GSD_SHIM_NAME}" "${COPILOT_CONFIG_DIR:-$HOME/.copilot}/gsd-core/bin/${_GSD_SHIM_NAME}" "${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}/gsd-core/bin/${_GSD_SHIM_NAME}" "${AUGMENT_CONFIG_DIR:-$HOME/.augment}/gsd-core/bin/${_GSD_SHIM_NAME}" "${TRAE_CONFIG_DIR:-$HOME/.trae}/gsd-core/bin/${_GSD_SHIM_NAME}" "${QWEN_CONFIG_DIR:-$HOME/.qwen}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CLINE_CONFIG_DIR:-$HOME/.cline}/gsd-core/bin/${_GSD_SHIM_NAME}" "${GROK_AGENTS_HOME:-$HOME/.agents}/gsd-core/bin/${_GSD_SHIM_NAME}" "${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}/gsd-core/bin/${_GSD_SHIM_NAME}" "${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/gsd-core/bin/${_GSD_SHIM_NAME}" "${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}/gsd-core/bin/${_GSD_SHIM_NAME}"; }; if _gsd_at "${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}"; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif _gsd_homes; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif unset -f gsd_run; _G="$(command -v gsd_run)"; [ -n "$_G" ] && _gsd_id_ok "$_G"; then GSD_TOOLS="$_G"; gsd_run() { "$GSD_TOOLS" "$@"; }; else echo "ERROR: gsd-tools.cjs not found at $GSD_TOOLS and no identity-proving gsd_run is on PATH. Run: npx -y @opengsd/gsd-core@latest --claude --local" >&2; exit 1; fi; GSD_IDENTITY_STATUS=unverified; _gsd_id_ok gsd_run && GSD_IDENTITY_STATUS=ok; export GSD_IDENTITY_STATUS; [ "$GSD_IDENTITY_STATUS" = ok ] || echo "WARNING: \"$GSD_TOOLS\" did not prove it is @opengsd/gsd-core - it is either a different package or an @opengsd/gsd-core older than the runtime-identity verb. See docs/how-to/diagnose-a-foreign-gsd-tools.md" >&2; if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -n "${GSD_TOOLS:-}" ]; then printf "export PATH='%s':\"\$PATH\"\n" "${GSD_TOOLS%/*}" >> "$CLAUDE_ENV_FILE" 2>/dev/null || true; fi
# For each plan in this wave, check if the executor finished:
SUMMARY_EXISTS=$(test -f "{phase_dir}/{plan_number}-{plan_padded}-SUMMARY.md" && echo "true" || echo "false")
# #5164: the plan's commits come from the evaluation-scope resolver — anchored on the SUBJECT,
# zero-pad tolerant (#4003, #4619, #4748), reachable from THIS branch only (the former
# any-branch lookup let a commit on another branch satisfy the probe); the 1-hour window stays.
# Exit 69 (UNAVAILABLE) is the resolver saying "could not look": an empty COMMITS_FOUND is then NOT "no commits".
COMMITS_SCOPE=$(gsd_run check evaluation-scope --plan "{phase_number}-{plan_padded}" --ref "${EXPECTED_BRANCH}" --commits-only --committed-since "1 hour ago" --raw 2>/dev/null) && COMMITS_SCOPE_RC=0 || COMMITS_SCOPE_RC=$?
COMMITS_FOUND=""
if [ "$COMMITS_SCOPE_RC" -eq 0 ]; then COMMITS_FOUND=$(printf '%s' "$COMMITS_SCOPE" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const c=JSON.parse(s).commits;process.stdout.write(c.length?c[0].sha:'')}catch{}})"); fi
COMMITS_SINCE_DISPATCH=$(git log "${EXPECTED_BRANCH}" --since="${DISPATCH_TS}" --oneline | head -1)
```

## Verdicts

**If `COMMITS_SCOPE_RC` is non-zero** (`69` `UNAVAILABLE`: the commit scope could not be resolved, #5170): the commit probe has no answer. Do not read the empty `COMMITS_FOUND` as "no matching commits", do not route to the failure handler on it, and do not re-dispatch an executor: surface `⚠ Commit probe unavailable for {Plan ID} (evaluation-scope exit {COMMITS_SCOPE_RC})` and stop for the user.

**If SUMMARY.md exists AND matching commits are found:** the agent completed
successfully — treat the plan as complete WITHOUT requiring another terminal child
response, proceed to step 5, and do NOT re-dispatch a fresh executor for this plan:
the work is already committed, and a second executor would redo it on top of itself.
Log: `"✓ {Plan ID} completed (verified via spot-check — completion signal not received)"`.

**If SUMMARY.md does NOT exist after a reasonable wait:** the agent may still be
running or may have failed silently. Check `git log --oneline -5` for recent
activity. If commits are still appearing, wait longer. If no activity, report the
plan as failed and route to the failure handler in step 6.

Evidence is BOTH probes or neither: a SUMMARY without matching commits, and matching
commits without a SUMMARY, are each incomplete evidence — never auto-complete on one
of them. When an abnormal end reconciles to no completion evidence, it stays failed:
route to the failure handler exactly as a normal failure would, and let the
safe-resume gate handle any un-summarized commits on the next run.
