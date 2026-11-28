Apply response_language to all user-facing prose — narration between tool calls, status updates, progress notes, and findings included; preserve code, paths, and identifiers.

<step name="regression_gate">
Run prior phases' test suites to catch cross-phase regressions BEFORE verification.

**Skip if:** This is the first phase (no prior phases), or no prior VERIFICATION.md files exist.

**Step 1: Discover prior phases' test files**
```bash
IFS= read -rd '' GSD_ARGS <<'GSD_ARGS_END' || true
$ARGUMENTS
GSD_ARGS_END
GSD_ARGS=${GSD_ARGS%$'\n'}
# gsd-handoff:begin regression-files-reset
_GSD_HANDOFF="$( { git rev-parse --absolute-git-dir 2>/dev/null || echo "${TMPDIR:-/tmp}/gsd-$(pwd | cksum | cut -d' ' -f1)"; } )/gsd-handoff"; mkdir -p "$_GSD_HANDOFF"
rm -f "$_GSD_HANDOFF/regression-files"  # a list left by an earlier run must never reach this gate (#4915)
# gsd-handoff:end regression-files-reset
_GSD_SHIM_NAME="gsd-tools.cjs"; _GSD_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; GSD_TOOLS="${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}"; _gsd_at() { for _p; do if [ -f "$_p" ]; then GSD_TOOLS="$_p"; return 0; fi; done; return 1; }; _gsd_id_ok() { case "$("$1" runtime-identity --raw 2>/dev/null || true)" in '{"packageName":"@opengsd/gsd-core"'*'}') return 0;; *) return 1;; esac; }; _gsd_homes() { set -- "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" "${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}" "$HOME/.gemini/antigravity-ide" "$HOME/.gemini/antigravity-cli" "${AUGMENT_CONFIG_DIR:-$HOME/.augment}" "${CLINE_CONFIG_DIR:-$HOME/.cline}" "${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}" "${CODEX_HOME:-$HOME/.codex}" "${COPILOT_CONFIG_DIR:-${COPILOT_HOME:-$HOME/.copilot}}" "${CURSOR_CONFIG_DIR:-$HOME/.cursor}" "${HERMES_HOME:-$HOME/.hermes}" "${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}" "${KIMI_CONFIG_DIR:-$HOME/.config/agents}" "$HOME/.agents" "${KIMI_CODE_HOME:-$HOME/.kimi-code}" "${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}" "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}" "${QWEN_CONFIG_DIR:-$HOME/.qwen}" "${TRAE_CONFIG_DIR:-$HOME/.trae}" "${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}" "${ZCODE_CONFIG_DIR:-$HOME/.zcode}" "${GROK_AGENTS_HOME:-$HOME/.agents}"; for _h; do _gsd_at "$_h/gsd-core/bin/${_GSD_SHIM_NAME}" && return 0; done; return 1; }; if _gsd_at "${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}"; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif _gsd_homes; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif unset -f gsd_run; _G="$(command -v gsd_run)"; [ -n "$_G" ] && _gsd_id_ok "$_G"; then GSD_TOOLS="$_G"; gsd_run() { "$GSD_TOOLS" "$@"; }; else echo "ERROR: gsd-tools.cjs not found at $GSD_TOOLS and no identity-proving gsd_run is on PATH. Run: npx -y @opengsd/gsd-core@latest --claude --local" >&2; exit 1; fi; GSD_IDENTITY_STATUS=unverified; _gsd_id_ok gsd_run && GSD_IDENTITY_STATUS=ok; export GSD_IDENTITY_STATUS; [ "$GSD_IDENTITY_STATUS" = ok ] || echo "WARNING: \"$GSD_TOOLS\" did not prove it is @opengsd/gsd-core - it is either a different package or an @opengsd/gsd-core older than the runtime-identity verb. See docs/how-to/diagnose-a-foreign-gsd-tools.md" >&2; if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -n "${GSD_TOOLS:-}" ]; then printf "export PATH='%s':\"\$PATH\"\n" "${GSD_TOOLS%/*}" >> "$CLAUDE_ENV_FILE" 2>/dev/null || true; fi
# #4772: this file is Read, not textually substituted - write the parent command's original argument string in place of $ARGUMENTS so --ws reaches the query.
GSD_WS=$(echo " $GSD_ARGS" | sed -nE 's/.* --ws +["'\'']?([A-Za-z0-9][A-Za-z0-9._-]*).*/--ws \1/p' | head -1)
PLANNING_ROOT=$(gsd_run query planning.inspect ${GSD_WS:+--ws=${GSD_WS##* }} --pick generated_from.planning_root)
: "${PLANNING_ROOT:?}"
# #6813: write this phase's number in place of {phase_number}. The current phase is excluded by its resolved
# directory, never by a pattern on its number. A decimal phase (03.1 after 03) is a phase of its own, as in
# init's has-prior-phases check, so it is kept.
PHASE_NUMBER="{phase_number}"
PROJECT_ROOT=$(gsd_run query planning.inspect --pick generated_from.cwd)
PHASE_REL=$(gsd_run query find-phase ${GSD_WS:+--ws=${GSD_WS##* }} "${PHASE_NUMBER}" --pick directory)
PHASE_DIR="${PROJECT_ROOT}/${PHASE_REL}"
[ -n "$PHASE_REL" ] && [ -d "$PHASE_DIR" ] || { echo "ERROR: phase ${PHASE_NUMBER} does not resolve to exactly one phase directory; check the phase number with: gsd_run query find-phase ${GSD_WS:+--ws=${GSD_WS##* } }${PHASE_NUMBER}" >&2; exit 1; }
# Find all VERIFICATION.md files from prior phases in current milestone
PRIOR_VERIFICATIONS=$(find -H "${PLANNING_ROOT}/phases" -mindepth 1 -maxdepth 1 2>/dev/null | while IFS= read -r _d; do [ "$_d" -ef "$PHASE_DIR" ] || find -H "$_d" -name "*-VERIFICATION.md" 2>/dev/null; done)
```

If this block exits non-zero, HALT: the regression set could not be determined, which is not "no prior phases". Do not proceed to verification.

**Step 2: Extract test file lists from prior verifications**

For each VERIFICATION.md found, look for test file references:
- Lines containing `test`, `spec`, or `__tests__` paths
- The "Test Suite" or "Automated Checks" section
- File patterns from `key-files.created` in corresponding SUMMARY.md files that match `*.test.*` or `*.spec.*`

Write all unique test file paths to the handoff file, one path per line (#4915). Each fenced
`bash` block is dispatched as its own shell, so a shell variable assigned here would never reach
`regression-gate-run.md` — the file is the hand-off. Replace the example lines with the real paths;
write none when no test file was found:

```bash
# gsd-handoff:begin regression-files-write
_GSD_HANDOFF="$( { git rev-parse --absolute-git-dir 2>/dev/null || echo "${TMPDIR:-/tmp}/gsd-$(pwd | cksum | cut -d' ' -f1)"; } )/gsd-handoff"; mkdir -p "$_GSD_HANDOFF"
cat > "$_GSD_HANDOFF/regression-files" <<'GSD_REGRESSION_FILES'
tests/test_example_one.py
tests/test_example_two.py
GSD_REGRESSION_FILES
# gsd-handoff:end regression-files-write
```

**Step 3: Run regression tests (if any found)** — Read and execute `gsd-core/workflows/execute-phase/steps/regression-gate-run.md`. It resolves the project test command, normalizes it to a one-shot form (defeating vitest/jest watch mode via the shared `normalize-test-command` helper), runs it under `workflow.test_gate_timeout`, and aborts on timeout with a watch-mode hint (#1857). On `REGRESSION GATE ABORTED` (exit 124), HALT — do not proceed to verification.

**Step 4: Report results**

If all tests pass:
```
✓ Regression gate: {N} prior-phase test files passed — no regressions detected
```
→ Proceed to verify_phase_goal

If any tests fail:
```
## ⚠ Cross-Phase Regression Detected

Phase {X} execution may have broken functionality from prior phases.

| Test File | Phase | Status | Detail |
|-----------|-------|--------|--------|
| {file} | {origin_phase} | FAILED | {first_failure_line} |

Options:
1. Fix regressions before verification (recommended)
2. Continue to verification anyway (regressions will compound)
3. Abort phase — roll back and re-plan
```

If `TEXT_MODE` is true, present as a plain-text numbered list and ask the user to type their choice number. Otherwise, use AskUserQuestion to present the options.
</step>
