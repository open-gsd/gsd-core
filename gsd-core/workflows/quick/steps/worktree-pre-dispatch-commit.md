**Step 5.6: Pre-dispatch artifact commit (worktree mode only)**

When `USE_WORKTREES !== "false"`, commit PLAN.md — plus CONTEXT.md and/or RESEARCH.md
when the discussion/research phases produced them — to the current branch **before**
spawning the executor. This ensures the worktree inherits these artifacts at its branch
HEAD so the executor can read them via a worktree-rooted path — avoiding the main-repo
path priming that triggers CC #36182 path-resolution drift, and avoiding the locked
decisions (CONTEXT.md) and research findings (RESEARCH.md) being stranded outside the
worktree while only PLAN.md reaches it (#4996).

Skip this step entirely if `USE_WORKTREES === "false"` (non-worktree mode: these artifacts
are committed in Step 8 as usual).

```bash
_GSD_SHIM_NAME="gsd-tools.cjs"; _GSD_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; GSD_TOOLS="${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}"; _gsd_at() { for _p; do if [ -f "$_p" ]; then GSD_TOOLS="$_p"; return 0; fi; done; return 1; }; _gsd_id_ok() { case "$("$1" runtime-identity --raw 2>/dev/null || true)" in '{"packageName":"@opengsd/gsd-core"'*'}') return 0;; *) return 1;; esac; }; _gsd_homes() { _gsd_at "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/gsd-core/bin/${_GSD_SHIM_NAME}" "${HERMES_HOME:-$HOME/.hermes}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CURSOR_CONFIG_DIR:-$HOME/.cursor}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CODEX_HOME:-$HOME/.codex}/gsd-core/bin/${_GSD_SHIM_NAME}" "${GEMINI_CONFIG_DIR:-$HOME/.gemini}/gsd-core/bin/${_GSD_SHIM_NAME}" "${COPILOT_CONFIG_DIR:-$HOME/.copilot}/gsd-core/bin/${_GSD_SHIM_NAME}" "${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}/gsd-core/bin/${_GSD_SHIM_NAME}" "${AUGMENT_CONFIG_DIR:-$HOME/.augment}/gsd-core/bin/${_GSD_SHIM_NAME}" "${TRAE_CONFIG_DIR:-$HOME/.trae}/gsd-core/bin/${_GSD_SHIM_NAME}" "${QWEN_CONFIG_DIR:-$HOME/.qwen}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CLINE_CONFIG_DIR:-$HOME/.cline}/gsd-core/bin/${_GSD_SHIM_NAME}" "${GROK_AGENTS_HOME:-$HOME/.agents}/gsd-core/bin/${_GSD_SHIM_NAME}" "${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}/gsd-core/bin/${_GSD_SHIM_NAME}" "${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/gsd-core/bin/${_GSD_SHIM_NAME}" "${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}/gsd-core/bin/${_GSD_SHIM_NAME}"; }; if _gsd_at "${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}"; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif _gsd_homes; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif unset -f gsd_run; _G="$(command -v gsd_run)"; [ -n "$_G" ] && _gsd_id_ok "$_G"; then GSD_TOOLS="$_G"; gsd_run() { "$GSD_TOOLS" "$@"; }; else echo "ERROR: gsd-tools.cjs not found at $GSD_TOOLS and no identity-proving gsd_run is on PATH. Run: npx -y @opengsd/gsd-core@latest --claude --local" >&2; exit 1; fi; GSD_IDENTITY_STATUS=unverified; _gsd_id_ok gsd_run && GSD_IDENTITY_STATUS=ok; export GSD_IDENTITY_STATUS; [ "$GSD_IDENTITY_STATUS" = ok ] || echo "WARNING: \"$GSD_TOOLS\" did not prove it is @opengsd/gsd-core - it is either a different package or an @opengsd/gsd-core older than the runtime-identity verb. See docs/how-to/diagnose-a-foreign-gsd-tools.md" >&2; if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -n "${GSD_TOOLS:-}" ]; then printf "export PATH='%s':\"\$PATH\"\n" "${GSD_TOOLS%/*}" >> "$CLAUDE_ENV_FILE" 2>/dev/null || true; fi
QUICK_PLAN_PARENT=""
QUICK_PLAN_COMMIT=""
if [ "${USE_WORKTREES}" != "false" ]; then
  QUICK_PLAN_PARENT=$(git rev-parse HEAD)
  COMMIT_DOCS=$(gsd_run query config-get commit_docs --raw 2>/dev/null || echo "true")
  if [ "$COMMIT_DOCS" != "false" ]; then
    # pre-dispatch plan commit — PLAN.md is always in scope. CONTEXT.md/RESEARCH.md
    # join it only when their phase actually ran AND actually produced a file — a
    # mode flag alone is not proof the file exists (#4996). An array (not a
    # space-joined string) keeps each path a single git argument under `set -u`
    # word-splitting rules (ShellCheck SC2086).
    QUICK_PREDISPATCH_PATHS=("${QUICK_DIR}/${quick_id}-PLAN.md")
    if [ "${DISCUSS_MODE}" = "true" ] && [ -f "${QUICK_DIR}/${quick_id}-CONTEXT.md" ]; then
      QUICK_PREDISPATCH_PATHS+=("${QUICK_DIR}/${quick_id}-CONTEXT.md")
    fi
    if [ "${RESEARCH_MODE}" = "true" ] && [ -f "${QUICK_DIR}/${quick_id}-RESEARCH.md" ]; then
      QUICK_PREDISPATCH_PATHS+=("${QUICK_DIR}/${quick_id}-RESEARCH.md")
    fi
    git add "${QUICK_PREDISPATCH_PATHS[@]}"
    # No-op skip if nothing actually staged (idempotent re-runs).
    if git diff --cached --quiet -- "${QUICK_PREDISPATCH_PATHS[@]}"; then
      echo "ℹ Pre-dispatch artifact commit skipped (no staged changes)"
    else
      # Run hooks normally (#2924). If a project opts out via
      # workflow.worktree_skip_hooks=true, honor that opt-in only.
      SKIP_HOOKS=$(gsd_run query config-get workflow.worktree_skip_hooks --raw 2>/dev/null || echo "false")
      if [ "$SKIP_HOOKS" = "true" ]; then
        git commit --no-verify -m "docs(${quick_id}): pre-dispatch artifacts for ${DESCRIPTION}" -- "${QUICK_PREDISPATCH_PATHS[@]}" \
          || { echo "ERROR: pre-dispatch artifact commit failed (--no-verify path). Aborting before executor dispatch." >&2; exit 1; }
      else
        git commit -m "docs(${quick_id}): pre-dispatch artifacts for ${DESCRIPTION}" -- "${QUICK_PREDISPATCH_PATHS[@]}" \
          || { echo "ERROR: pre-dispatch artifact commit failed — likely a pre-commit hook failure. Fix the hook output above (or set workflow.worktree_skip_hooks=true to bypass) and re-run." >&2; exit 1; }
      fi
      QUICK_PLAN_COMMIT=$(git rev-parse HEAD)
    fi
  fi
  if [ -z "$QUICK_PLAN_COMMIT" ]; then
    QUICK_PLAN_COMMIT=$(git rev-parse HEAD)
  fi
fi
```
