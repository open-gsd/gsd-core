Apply response_language to all user-facing prose — narration between tool calls, status updates, progress notes, and findings included; preserve code, paths, and identifiers.

# Step: regression_gate_run

Run the resolved prior-phase test command one-shot, bounded by a timeout, so a
watch-mode runner (vitest defaults to watch in a TTY; jest `--watch`) cannot
hang this gate forever (#1857). Uses the shared `normalize-test-command` helper
— the same one the post-merge gate uses — so the two gate paths cannot drift.

Reads the prior step's test-file list from the handoff file `regression-files` (#4915); a shell variable
cannot carry it, because each fenced `bash` block runs as its own shell.

```bash
_GSD_SHIM_NAME="gsd-tools.cjs"; _GSD_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; GSD_TOOLS="${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}"; _gsd_at() { for _p; do if [ -f "$_p" ]; then GSD_TOOLS="$_p"; return 0; fi; done; return 1; }; _gsd_id_ok() { case "$("$1" runtime-identity --raw 2>/dev/null || true)" in '{"packageName":"@opengsd/gsd-core"'*'}') return 0;; *) return 1;; esac; }; _gsd_homes() { set -- "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" "${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}" "$HOME/.gemini/antigravity-ide" "$HOME/.gemini/antigravity-cli" "${AUGMENT_CONFIG_DIR:-$HOME/.augment}" "${CLINE_CONFIG_DIR:-$HOME/.cline}" "${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}" "${CODEX_HOME:-$HOME/.codex}" "${COPILOT_CONFIG_DIR:-${COPILOT_HOME:-$HOME/.copilot}}" "${CURSOR_CONFIG_DIR:-$HOME/.cursor}" "${HERMES_HOME:-$HOME/.hermes}" "${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}" "${KIMI_CONFIG_DIR:-$HOME/.config/agents}" "$HOME/.agents" "${KIMI_CODE_HOME:-$HOME/.kimi-code}" "${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}" "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}" "${QWEN_CONFIG_DIR:-$HOME/.qwen}" "${TRAE_CONFIG_DIR:-$HOME/.trae}" "${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}" "${ZCODE_CONFIG_DIR:-$HOME/.zcode}" "${GROK_AGENTS_HOME:-$HOME/.agents}"; for _h; do _gsd_at "$_h/gsd-core/bin/${_GSD_SHIM_NAME}" && return 0; done; return 1; }; if _gsd_at "${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}"; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif _gsd_homes; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif unset -f gsd_run; _G="$(command -v gsd_run)"; [ -n "$_G" ] && _gsd_id_ok "$_G"; then GSD_TOOLS="$_G"; gsd_run() { "$GSD_TOOLS" "$@"; }; else echo "ERROR: gsd-tools.cjs not found at $GSD_TOOLS and no identity-proving gsd_run is on PATH. Run: npx -y @opengsd/gsd-core@latest --claude --local" >&2; exit 1; fi; GSD_IDENTITY_STATUS=unverified; _gsd_id_ok gsd_run && GSD_IDENTITY_STATUS=ok; export GSD_IDENTITY_STATUS; [ "$GSD_IDENTITY_STATUS" = ok ] || echo "WARNING: \"$GSD_TOOLS\" did not prove it is @opengsd/gsd-core - it is either a different package or an @opengsd/gsd-core older than the runtime-identity verb. See docs/how-to/diagnose-a-foreign-gsd-tools.md" >&2; if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -n "${GSD_TOOLS:-}" ]; then printf "export PATH='%s':\"\$PATH\"\n" "${GSD_TOOLS%/*}" >> "$CLAUDE_ENV_FILE" 2>/dev/null || true; fi
# gsd-handoff:begin regression-files-read
_GSD_HANDOFF="$( { git rev-parse --absolute-git-dir 2>/dev/null || echo "${TMPDIR:-/tmp}/gsd-$(pwd | cksum | cut -d' ' -f1)"; } )/gsd-handoff"; mkdir -p "$_GSD_HANDOFF"
REGRESSION_FILES=""
if [ -s "$_GSD_HANDOFF/regression-files" ]; then
  while IFS= read -r _f; do
    if [ -n "$_f" ]; then REGRESSION_FILES="${REGRESSION_FILES}$(printf '%q ' "$_f")"; fi
  done < "$_GSD_HANDOFF/regression-files"
fi
# gsd-handoff:end regression-files-read
# Resolve test command: project config > Makefile > language sniff
REG_TEST_CMD=$(gsd_run query config-get workflow.test_command --default "" --raw 2>/dev/null || true)
if [ -z "$REG_TEST_CMD" ]; then
  if [ -f "Makefile" ] && grep -q "^test:" Makefile; then
    REG_TEST_CMD="make test"
  elif [ -f "Justfile" ] || [ -f "justfile" ]; then
    REG_TEST_CMD="just test"
  elif [ -f "package.json" ]; then
    REG_TEST_CMD=$(gsd_run query resolve-package-manager test --cwd . 2>/dev/null || echo "npm test")
    [ -n "$REG_TEST_CMD" ] || REG_TEST_CMD="npm test"
  elif [ -f "Cargo.toml" ]; then
    REG_TEST_CMD="cargo test"
  elif [ -f "go.mod" ]; then
    REG_TEST_CMD="go test ./..."
  elif [ -f "requirements.txt" ] || [ -f "pyproject.toml" ]; then
    # gsd-handoff:begin regression-pytest-arm
    if [ -n "$REGRESSION_FILES" ]; then
      REG_TEST_CMD="python -m pytest -q --tb=short -- ${REGRESSION_FILES}"
    else
      echo "⚠ Regression gate: no prior-phase test files were collected — skipping the scoped pytest run instead of falling back to the full suite."
      REG_TEST_CMD="true"
    fi
    # gsd-handoff:end regression-pytest-arm
  else
    REG_TEST_CMD="true"
  fi
fi
# #1857: normalize to a one-shot form (defeat vitest/jest watch mode) and bound
# with a timeout so a watch-mode runner cannot hang the gate indefinitely.
REG_TEST_CMD=$(gsd_run query normalize-test-command "$REG_TEST_CMD" --cwd . 2>/dev/null || echo "$REG_TEST_CMD")
TEST_GATE_TIMEOUT=$(gsd_run query config-get workflow.test_gate_timeout --raw 2>/dev/null || echo "600")
gsd_run run-with-timeout "$TEST_GATE_TIMEOUT" -- bash -c "$REG_TEST_CMD" 2>&1
REG_TEST_EXIT=$?
if [ "$REG_TEST_EXIT" -eq 124 ]; then
  echo "✗ REGRESSION GATE ABORTED — test runner did not exit within ${TEST_GATE_TIMEOUT}s, likely stuck in watch/dev mode (e.g. vitest without 'run'). Run tests one-shot (e.g. 'vitest run'), set workflow.test_command, or raise workflow.test_gate_timeout."
fi
```

**On `REG_TEST_EXIT` 124 (`REGRESSION GATE ABORTED`):** HALT — do not proceed to verification. The runner did not exit within the budget (watch/dev mode is the likely cause). Surface the watch-mode cause and the recovery options; never silently continue.
