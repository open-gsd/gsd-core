# Post-wave requirement completion (#6102)


<!-- PHASE-ID-CONVENTION:START -->
Resolve phase_id_convention independently of phase_naming. Use returned paths; never derive them from display labels.
Use CLI display_id when present; otherwise use reference grammar. Before emitting identities, Read `~/.claude/gsd-core/references/phase-id-convention.md`.
<!-- PHASE-ID-CONVENTION:END -->

Read and follow this fragment from `execute-phase.md` step 5.7 (the post-wave shared artifact update), after the
ROADMAP plan-progress loop and inside the same `TEST_EXIT` guard. Substitute `{completed_plan_ids}` exactly as that
loop does: the plan IDs that COMPLETED in this wave (each has a `*-SUMMARY.md`), written out as a literal list.

Each worktree executor runs `execute-plan.md`'s `update_requirements` against a tree that holds only ITS OWN
`*-SUMMARY.md`, so a requirement ID declared by two or more plans of the wave is blocked in every executor and none
marks it (the shared-ID gate, #2388, is correct; it just cannot see the sibling worktrees). The orchestrator is the
only place the merged tree exists, so it evaluates the same gate once there for the IDs the wave's plans declare and
marks the ones whose declaring plans all have summaries. An ID with an unfinished declaring plan stays unmarked, and
nothing is marked when the post-merge tests failed or timed out, exactly like the ROADMAP update. Single-plan IDs
were already marked by their executor; marking them again is a no-op.

```bash
_GSD_SHIM_NAME="gsd-tools.cjs"; _GSD_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; GSD_TOOLS="${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}"; _gsd_at() { for _p; do if [ -f "$_p" ]; then GSD_TOOLS="$_p"; return 0; fi; done; return 1; }; _gsd_id_ok() { case "$("$1" runtime-identity --raw 2>/dev/null || true)" in '{"packageName":"@opengsd/gsd-core"'*'}') return 0;; *) return 1;; esac; }; _gsd_homes() { set -- "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" "${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}" "$HOME/.gemini/antigravity-ide" "$HOME/.gemini/antigravity-cli" "${AUGMENT_CONFIG_DIR:-$HOME/.augment}" "${CLINE_CONFIG_DIR:-$HOME/.cline}" "${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}" "${CODEX_HOME:-$HOME/.codex}" "${COPILOT_CONFIG_DIR:-${COPILOT_HOME:-$HOME/.copilot}}" "${CURSOR_CONFIG_DIR:-$HOME/.cursor}" "${HERMES_HOME:-$HOME/.hermes}" "${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}" "${KIMI_CONFIG_DIR:-$HOME/.config/agents}" "$HOME/.agents" "${KIMI_CODE_HOME:-$HOME/.kimi-code}" "${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}" "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}" "${QWEN_CONFIG_DIR:-$HOME/.qwen}" "${TRAE_CONFIG_DIR:-$HOME/.trae}" "${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}" "${ZCODE_CONFIG_DIR:-$HOME/.zcode}" "${GROK_AGENTS_HOME:-$HOME/.agents}"; for _h; do _gsd_at "$_h/gsd-core/bin/${_GSD_SHIM_NAME}" && return 0; done; return 1; }; if _gsd_at "${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}"; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif _gsd_homes; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif unset -f gsd_run; _G="$(command -v gsd_run)"; [ -n "$_G" ] && _gsd_id_ok "$_G"; then GSD_TOOLS="$_G"; gsd_run() { "$GSD_TOOLS" "$@"; }; else echo "ERROR: gsd-tools.cjs not found at $GSD_TOOLS and no identity-proving gsd_run is on PATH. Run: npx -y @opengsd/gsd-core@latest --claude --local" >&2; exit 1; fi; GSD_IDENTITY_STATUS=unverified; _gsd_id_ok gsd_run && GSD_IDENTITY_STATUS=ok; export GSD_IDENTITY_STATUS; [ "$GSD_IDENTITY_STATUS" = ok ] || echo "WARNING: \"$GSD_TOOLS\" did not prove it is @opengsd/gsd-core - it is either a different package or an @opengsd/gsd-core older than the runtime-identity verb. See docs/how-to/diagnose-a-foreign-gsd-tools.md" >&2; if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -n "${GSD_TOOLS:-}" ]; then printf "export PATH='%s':\"\$PATH\"\n" "${GSD_TOOLS%/*}" >> "$CLAUDE_ENV_FILE" 2>/dev/null || true; fi
# shellcheck disable=SC2043,SC2046,SC2086  # {completed_plan_ids} is substituted by the orchestrator; ${GSD_WS:+--ws=...} and the ID lists expand to zero or several words on purpose
if [ "${TEST_EXIT}" -eq 0 ]; then
  for plan_id in {completed_plan_ids}; do
    # a plan id is the file stem (`01-01-api`) or, for a nested plan, its phase-relative path (`plans/PLAN-2.md`)
    case "$plan_id" in *.md) PLAN_PATH="${PHASE_DIR}/${plan_id}" ;; *) PLAN_PATH="${PHASE_DIR}/${plan_id}-PLAN.md" ;; esac
    [ -f "$PLAN_PATH" ] || continue
    REQ_IDS=$(gsd_run query frontmatter.get ${GSD_WS:+--ws=${GSD_WS##* }} "${PLAN_PATH}" requirements | jq -r '.requirements[]?' | tr '\n' ' ')
    [ -n "$(printf '%s' "$REQ_IDS" | tr -d '[:space:]')" ] || continue
    READY=$(gsd_run query requirements.ready-ids ${GSD_WS:+--ws=${GSD_WS##* }} "${PLAN_PATH}" $(printf '%s' "$REQ_IDS"))
    READY_IDS=$(printf '%s' "$READY" | jq -r '.ready[]' 2>/dev/null | tr '\n' ' ')
    if [ -n "$(printf '%s' "$READY_IDS" | tr -d '[:space:]')" ]; then
      gsd_run query requirements.mark-complete ${GSD_WS:+--ws=${GSD_WS##* }} $(printf '%s' "$READY_IDS")
    fi
  done
  if ! git diff --quiet {requirements_path} 2>/dev/null; then
    gsd_run query commit "docs(phase-${PHASE_NUMBER}): mark shared requirements complete after wave ${N}" --files "{requirements_path}"
  fi
fi
```

A later `gaps_found` verification still reverts what this pass marked: `requirements.revert-phase` works from the
phase's requirement IDs, not from who marked them (`execute-phase-requirement-revert.md`).
