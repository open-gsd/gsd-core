Apply response_language to all user-facing prose — narration between tool calls, status updates, progress notes, and findings included; preserve code, paths, and identifiers.

<step name="unpassed_resume">
Every plan is summarized, the phase is not marked complete, and a VERIFICATION.md exists whose
status is **not** `passed` — `gaps_found`, `human_needed`, or `unknown` (#4765). The report is
present but it is not a verdict that anything may be built on.

This is NOT the #3684 state. There the verdict was `passed` and only the roadmap write was
missing, so resuming at `update_roadmap` finished a run that had genuinely succeeded. Here the
old `VERIFY_STATUS ≠ missing` branch sent these three statuses down that same route, which
announced the phase as verified when it is not, skipped `verify_phase_goal`, and then
dead-ended at the completion gate — `phase.complete`
refuses a non-`passed` verdict, so the only possible outcome was an error contradicting the
message that led there.

Read the status's own routing rather than restating it here — `verification.status` is the single
owner of what each status means and what to do next, and a second copy in this workflow is how
the two came to disagree in the first place:

```bash
_GSD_SHIM_NAME="gsd-tools.cjs"; _GSD_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; GSD_TOOLS="${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}"; _gsd_at() { for _p; do if [ -f "$_p" ]; then GSD_TOOLS="$_p"; return 0; fi; done; return 1; }; _gsd_id_ok() { case "$("$1" runtime-identity --raw 2>/dev/null || true)" in '{"packageName":"@opengsd/gsd-core"'*'}') return 0;; *) return 1;; esac; }; _gsd_homes() { _gsd_at "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/gsd-core/bin/${_GSD_SHIM_NAME}" "${HERMES_HOME:-$HOME/.hermes}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CURSOR_CONFIG_DIR:-$HOME/.cursor}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CODEX_HOME:-$HOME/.codex}/gsd-core/bin/${_GSD_SHIM_NAME}" "${GEMINI_CONFIG_DIR:-$HOME/.gemini}/gsd-core/bin/${_GSD_SHIM_NAME}" "${COPILOT_CONFIG_DIR:-$HOME/.copilot}/gsd-core/bin/${_GSD_SHIM_NAME}" "${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}/gsd-core/bin/${_GSD_SHIM_NAME}" "${AUGMENT_CONFIG_DIR:-$HOME/.augment}/gsd-core/bin/${_GSD_SHIM_NAME}" "${TRAE_CONFIG_DIR:-$HOME/.trae}/gsd-core/bin/${_GSD_SHIM_NAME}" "${QWEN_CONFIG_DIR:-$HOME/.qwen}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CLINE_CONFIG_DIR:-$HOME/.cline}/gsd-core/bin/${_GSD_SHIM_NAME}" "${GROK_AGENTS_HOME:-$HOME/.agents}/gsd-core/bin/${_GSD_SHIM_NAME}" "${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}/gsd-core/bin/${_GSD_SHIM_NAME}" "${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/gsd-core/bin/${_GSD_SHIM_NAME}" "${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}/gsd-core/bin/${_GSD_SHIM_NAME}"; }; if _gsd_at "${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}"; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif _gsd_homes; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif unset -f gsd_run; _G="$(command -v gsd_run)"; [ -n "$_G" ] && _gsd_id_ok "$_G"; then GSD_TOOLS="$_G"; gsd_run() { "$GSD_TOOLS" "$@"; }; else echo "ERROR: gsd-tools.cjs not found at $GSD_TOOLS and no identity-proving gsd_run is on PATH. Run: npx -y @opengsd/gsd-core@latest --claude --local" >&2; exit 1; fi; GSD_IDENTITY_STATUS=unverified; _gsd_id_ok gsd_run && GSD_IDENTITY_STATUS=ok; export GSD_IDENTITY_STATUS; [ "$GSD_IDENTITY_STATUS" = ok ] || echo "WARNING: \"$GSD_TOOLS\" did not prove it is @opengsd/gsd-core - it is either a different package or an @opengsd/gsd-core older than the runtime-identity verb. See docs/how-to/diagnose-a-foreign-gsd-tools.md" >&2; if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -n "${GSD_TOOLS:-}" ]; then printf "export PATH='%s':\"\$PATH\"\n" "${GSD_TOOLS%/*}" >> "$CLAUDE_ENV_FILE" 2>/dev/null || true; fi
VERIFY_JSON=$(gsd_run query verification.status "${PHASE_DIR}" 2>/dev/null)
if [[ "$VERIFY_JSON" == @file:* ]]; then VERIFY_JSON=$(cat "${VERIFY_JSON#@file:}"); fi
VERIFY_NEXT_ACTION=$(printf '%s' "$VERIFY_JSON" | jq -r '.next_action // ""' 2>/dev/null || echo "")
VERIFY_NEXT_COMMAND=$(printf '%s' "$VERIFY_JSON" | jq -r '.next_command // ""' 2>/dev/null || echo "")
if [[ -z "$VERIFY_NEXT_ACTION" ]]; then
  VERIFY_NEXT_ACTION="Verification did not provide a next action. Inspect the report before continuing."
fi
```

Report, then exit — do NOT continue at `update_roadmap`, and do NOT claim the phase is verified:

```
"Phase {X}: every plan is summarized, but verification is {VERIFY_STATUS}, not passed.
{VERIFY_NEXT_ACTION}
Next: {VERIFY_NEXT_COMMAND}"
```

Omit the `Next:` line when `next_command` is empty.

**Why exit rather than re-verify.** Each of these three needs something this run cannot supply,
and each has a different owner:

| Status | Why re-running the verifier here would not help |
|---|---|
| `gaps_found` | The verifier already reported what is missing. Closing gaps is planning work — `next_command` routes to gap-closure planning, not to another verification pass over the same tree |
| `human_needed` | A person has to complete the phase's `*-UAT.md` first; re-dispatching the verifier before that produces the identical verdict |
| `unknown` | The status value is not one the verifier emits, so it was hand-set (a `failed`/`superseded` marker, say). Regenerating would overwrite a deliberate human record — `next_action` says as much, and the decision is the user's |

`stale` is the one non-`passed` status that re-verification DOES fix, and it is handled ahead of
this arm by `execute-phase/steps/stale-reverification.md` — there the report is only out of date
with the tree, not a standing negative verdict.
</step>
