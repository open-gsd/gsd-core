**Step 9: Completion**

For every item that merged successfully in Step 7 AND (NOT `$VALIDATE_MODE`,
OR Step 8 routed it to `complete`): call `completeQuickItem` via its CLI verb
— this is the ONLY writer of a "Quick Tasks Completed" STATE.md row and the
item's `complete` status; both happen inside ONE lock transaction, exactly
once per item (idempotent — re-running this step for an already-complete
item is a no-op, same guarantee `/gsd:quick` relies on):

```bash
_GSD_SHIM_NAME="gsd-tools.cjs"; _GSD_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; GSD_TOOLS="${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}"; _gsd_at() { for _p; do if [ -f "$_p" ]; then GSD_TOOLS="$_p"; return 0; fi; done; return 1; }; _gsd_id_ok() { case "$("$1" runtime-identity --raw 2>/dev/null || true)" in '{"packageName":"@opengsd/gsd-core"'*'}') return 0;; *) return 1;; esac; }; _gsd_homes() { set -- "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" "${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}" "$HOME/.gemini/antigravity-ide" "$HOME/.gemini/antigravity-cli" "${AUGMENT_CONFIG_DIR:-$HOME/.augment}" "${CLINE_CONFIG_DIR:-$HOME/.cline}" "${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}" "${CODEX_HOME:-$HOME/.codex}" "${COPILOT_CONFIG_DIR:-${COPILOT_HOME:-$HOME/.copilot}}" "${CURSOR_CONFIG_DIR:-$HOME/.cursor}" "${HERMES_HOME:-$HOME/.hermes}" "${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}" "${KIMI_CONFIG_DIR:-$HOME/.config/agents}" "$HOME/.agents" "${KIMI_CODE_HOME:-$HOME/.kimi-code}" "${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}" "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}" "${QWEN_CONFIG_DIR:-$HOME/.qwen}" "${TRAE_CONFIG_DIR:-$HOME/.trae}" "${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}" "${ZCODE_CONFIG_DIR:-$HOME/.zcode}" "${GROK_AGENTS_HOME:-$HOME/.agents}"; for _h; do _gsd_at "$_h/gsd-core/bin/${_GSD_SHIM_NAME}" && return 0; done; return 1; }; if _gsd_at "${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}"; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif _gsd_homes; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif unset -f gsd_run; _G="$(command -v gsd_run)"; [ -n "$_G" ] && _gsd_id_ok "$_G"; then GSD_TOOLS="$_G"; gsd_run() { "$GSD_TOOLS" "$@"; }; else echo "ERROR: gsd-tools.cjs not found at $GSD_TOOLS and no identity-proving gsd_run is on PATH. Run: npx -y @opengsd/gsd-core@latest --claude --local" >&2; exit 1; fi; GSD_IDENTITY_STATUS=unverified; _gsd_id_ok gsd_run && GSD_IDENTITY_STATUS=ok; export GSD_IDENTITY_STATUS; [ "$GSD_IDENTITY_STATUS" = ok ] || echo "WARNING: \"$GSD_TOOLS\" did not prove it is @opengsd/gsd-core - it is either a different package or an @opengsd/gsd-core older than the runtime-identity verb. See docs/how-to/diagnose-a-foreign-gsd-tools.md" >&2; if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -n "${GSD_TOOLS:-}" ]; then printf "export PATH='%s':\"\$PATH\"\n" "${GSD_TOOLS%/*}" >> "$CLAUDE_ENV_FILE" 2>/dev/null || true; fi
gsd_run quick-batch complete \
  --batch "$BATCH_ID" \
  --quick-id "$quick_id" \
  --description "$description" \
  --date "$date" \
  --commit "$commit_hash" \
  --directory "$ITEM_DIR" \
  --raw
```

The result's `warnings` is non-empty when the description was over 240 characters: the row is
still written in full (#5830). Show each warning under that item in the final report.

Items NOT reaching this call — `human_needed`, `failed` (planner/checker/
merge/verification failure), or still `blocked`/`pending` (a dependency
failed, row 32) — are left exactly as their respective routing step set
them. No STATE row, no `complete` status, worktree preserved where
applicable.

**Final commit.** Stage every artifact produced this run (PLAN.md, SUMMARY.md,
`--research` RESEARCH.md, `--validate` VERIFICATION.md, per item, plus
`.planning/STATE.md`) and commit:
`$BATCH_ARTIFACT_FILES` is a bash ARRAY (not a plain string — a plain
space-joined string re-splits unpredictably under `set -f`/globbing and
diverges between bash and zsh, the #4109 word-splitting bug class):
```bash
COMMIT_DOCS=$(gsd_run query config-get commit_docs --raw 2>/dev/null || echo "true")
if [ "$COMMIT_DOCS" != "false" ]; then
  git add "${BATCH_ARTIFACT_FILES[@]}" 2>/dev/null
  gsd_run query commit "docs(quick-batch-${BATCH_ID}): ${ITEM_COUNT} item(s)" --files "${BATCH_ARTIFACT_FILES[@]}"
fi
```

**Final report.** Re-load the batch (`gsd_run quick-batch resume --batch
"$BATCH_ID" --raw` — read-only in effect when nothing changed) and summarize
by status:

```
---
GSD > QUICK BATCH COMPLETE

Batch ${BATCH_ID}: ${ITEM_COUNT} item(s)
  Complete: ${complete_count}
  Failed: ${failed_count}${failed_count > 0 ? ' (' + failed_reasons + ')' : ''}
  Needs review: ${human_needed_count}
  Blocked: ${blocked_count}

${failed_count + human_needed_count > 0 ? 'Resume after resolving: /gsd:quick-batch --resume ' + BATCH_ID : ''}
---
```

If EVERY item is `complete`, this is a clean finish — no further action
needed. If any item is `failed`/`human_needed`/`blocked`, the batch stays
resumable: fix the underlying issue (or accept the failure), then re-run
`/gsd:quick-batch --resume ${BATCH_ID}` — `resumeBatch`'s own propagation
(unmodified from Phase 3) re-evaluates eligibility from the current state, no
special quick-batch-side recovery logic needed.
