# OpenCode V2 quick-batch verification

Read only for native-tool items. Receipt-backed V2 verification is the sole completion authority.

## `native-tool`: V2 verification journal routing

For V2, run the same verifier prompt only for an item whose journal phase is
`removed`. Preserve the global
model omission rule for `verifier_model`: omit the Agent model field when it is
empty or `inherit`; otherwise pass the configured selector. Do not infer the
result from SUMMARY or executor status.

Call the strict coordinate-only verification recorder directly. It resolves no
sibling and performs exactly one pre-receipt read of the exact
`${quick_id}-VERIFICATION.md` into a `Buffer`. It strict-admits, canonically
evaluates current fingerprint coverage/staleness, and SHA-256 hashes the same
captured buffer before binding the receipt and BATCH outcome to the journal.
The general `verification.status` query remains the process-runtime routing API;
its result is not V2 receipt authority. Generic `quick-batch complete` cannot
create this receipt, and arbitrary transition event JSON is never evidence:

```bash
_GSD_SHIM_NAME="gsd-tools.cjs"; _GSD_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; GSD_TOOLS="${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}"; _gsd_at() { for _p; do if [ -f "$_p" ]; then GSD_TOOLS="$_p"; return 0; fi; done; return 1; }; if _gsd_at "${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}"; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif unset -f gsd_run; _G="$(command -v gsd_run)"; then GSD_TOOLS="$_G"; gsd_run() { "$GSD_TOOLS" "$@"; }; elif _gsd_at "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/gsd-core/bin/${_GSD_SHIM_NAME}" "${HERMES_HOME:-$HOME/.hermes}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CURSOR_CONFIG_DIR:-$HOME/.cursor}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CODEX_HOME:-$HOME/.codex}/gsd-core/bin/${_GSD_SHIM_NAME}" "${GEMINI_CONFIG_DIR:-$HOME/.gemini}/gsd-core/bin/${_GSD_SHIM_NAME}" "${COPILOT_CONFIG_DIR:-$HOME/.copilot}/gsd-core/bin/${_GSD_SHIM_NAME}" "${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}/gsd-core/bin/${_GSD_SHIM_NAME}" "${AUGMENT_CONFIG_DIR:-$HOME/.augment}/gsd-core/bin/${_GSD_SHIM_NAME}" "${TRAE_CONFIG_DIR:-$HOME/.trae}/gsd-core/bin/${_GSD_SHIM_NAME}" "${QWEN_CONFIG_DIR:-$HOME/.qwen}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CLINE_CONFIG_DIR:-$HOME/.cline}/gsd-core/bin/${_GSD_SHIM_NAME}" "${GROK_AGENTS_HOME:-$HOME/.agents}/gsd-core/bin/${_GSD_SHIM_NAME}" "${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}/gsd-core/bin/${_GSD_SHIM_NAME}" "${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/gsd-core/bin/${_GSD_SHIM_NAME}" "${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}/gsd-core/bin/${_GSD_SHIM_NAME}"; then gsd_run() { node "$GSD_TOOLS" "$@"; }; else echo "ERROR: gsd-tools.cjs not found at $GSD_TOOLS and gsd_run is not on PATH. Run: npx -y @opengsd/gsd-core@latest --claude --local" >&2; exit 1; fi; GSD_IDENTITY_STATUS=unverified; case "$(gsd_run runtime-identity --raw 2>/dev/null || true)" in '{"packageName":"@opengsd/gsd-core"'*'}') GSD_IDENTITY_STATUS=ok;; esac; export GSD_IDENTITY_STATUS; [ "$GSD_IDENTITY_STATUS" = ok ] || echo "WARNING: \"$GSD_TOOLS\" did not prove it is @opengsd/gsd-core - it is either a different package or an @opengsd/gsd-core older than the runtime-identity verb. See docs/how-to/diagnose-a-foreign-gsd-tools.md" >&2; if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -n "${GSD_TOOLS:-}" ]; then printf "export PATH='%s':\"\$PATH\"\n" "${GSD_TOOLS%/*}" >> "$CLAUDE_ENV_FILE" 2>/dev/null || true; fi
QB_V2_VERIFY=$(gsd_run quick-batch v2-verify \
  --parent-session "$PARENT_SESSION_ID" --batch "$BATCH_ID" --round "$ROUND" \
  --item "$quick_id" --expected-revision "$ROUND_REVISION" --raw) || exit 1
```

- `passed` / action `complete`: require the recorder to return
  `pending_completion:true` and journal phase `verification_passed`, and only
  then route the item to Step 9. A lost response is reconciled by rerunning the
  exact coordinate command with its original expected revision. Replay succeeds
  only when path, bytes, status, current covered inputs, and determinate
  staleness still match; changed report or covered bytes fail closed.
- Current, well-formed, determinate `gaps_found`: persist a compatibility receipt
  with journal phase `verification_failed` and BATCH `failed`. It is
  non-authorizing and cannot complete or close a successful round.
- Current, well-formed, determinate `human_needed`: persist a compatibility
  receipt with journal phase `verification_blocked` and BATCH `blocked`. It is
  non-authorizing and cannot complete or close a successful round.
- Stale, malformed, missing, unknown, or staleness-indeterminate evidence:
  command failure, no receipt, no BATCH outcome mutation, and halt/preserve.

Require the exact successful emitted value and refresh `ROUND_REVISION` from
its `journal.revision`.
Every replay and `v2-complete`, `completed`, and `v2-close` boundary re-evaluates
current coverage/staleness; receipt path/hash/status equality alone is not
authorization. `verification_failed` and
`verification_blocked` leave the round active and halt/preserve; `v2-close`
will reject them. There is no automatic fix, rollback, completion, or cleanup.
When `$VALIDATE_MODE` is false, leave the item at `removed`; Step 9 may complete
it directly.
