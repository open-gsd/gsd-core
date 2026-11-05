Apply response_language to all user-facing prose — narration between tool calls, status updates, progress notes, and findings included; preserve code, paths, and identifiers.

<step name="regression_gate">
Run prior phases' test suites to catch cross-phase regressions BEFORE verification.

**Skip if:** This is the first phase (no prior phases), or no prior VERIFICATION.md files exist.

**Step 1: Discover prior phases' test files**
```bash
# gsd-handoff:begin regression-files-reset
_GSD_HANDOFF="$( { git rev-parse --absolute-git-dir 2>/dev/null || echo "${TMPDIR:-/tmp}/gsd-$(pwd | cksum | cut -d' ' -f1)"; } )/gsd-handoff"; mkdir -p "$_GSD_HANDOFF"
rm -f "$_GSD_HANDOFF/regression-files"  # a list left by an earlier run must never reach this gate (#4915)
# gsd-handoff:end regression-files-reset
# Prior phases' VERIFICATION.md files under this scope's phases/ (the parent of init's `phase_dir`), minus those whose
# path below phases/ contains ${PHASE_NUMBER}: the root project's rule. The test never sees the checkout path (#5861).
CURRENT_PHASE_DIR="{phase_dir}"
if [ ! -d "$CURRENT_PHASE_DIR" ]; then
  echo "ERROR: regression gate: phase directory not resolved ('$CURRENT_PHASE_DIR'); substitute init's phase_dir." >&2
  exit 1
fi
PHASES_DIR=$(dirname "$CURRENT_PHASE_DIR")
PRIOR_VERIFICATIONS=$(find "$PHASES_DIR" -name "*-VERIFICATION.md" 2>/dev/null | while IFS= read -r f; do
  case "${f#"$PHASES_DIR"/}" in (*"${PHASE_NUMBER}"*) ;; (*) printf '%s\n' "$f" ;; esac
done)
```

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
