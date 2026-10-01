Apply response_language to all user-facing prose — narration between tool calls, status updates, progress notes, and findings included; preserve code, paths, and identifiers.

<step name="verify_phase_goal_regeneration">
**The one verification action for a phase (#5118, ADR-5057 Phase 4).** The verification owner
routes `stale` (and `missing`) to `execute-phase`; this file is what that route runs, and it is the
ONLY place the verification sequence is written, whole and in this order: the `verify:post` hook
dispatch with the SECURITY threats-open gate (`verify_post_security_gate`), the code-review gate,
the gap-closure parent-artifact close, the manifest-gated regression gate, the verifier dispatch,
the covered-input fingerprint, and the owner's status read. Two workflows include it —
`execute-phase.md` step `verify_phase_goal` and `verify-work.md` step `complete_session` (a report
routed to `execute-phase`) — and both run every step below, in order, identically. There is no
per-caller branch; what stays in `execute-phase.md` is only its own bookkeeping (the wave summary
table in `aggregate_results`, the roadmap/state writes after a `passed` verdict).

**Inputs — one bundle for both callers.** The `gsd_run query init.execute-phase "${PHASE_NUMBER}"`
bundle (execute-phase loaded it in `initialize`; verify-work loads the same query before including
this file). From it: `phase_dir` (`PHASE_DIR`), `phase_number` (`PHASE_NUMBER`),
`verifier_model`, `phase_req_ids`, `requirements_path`, `section_manifest`, `response_language`.
The phase goal is the `**Goal**` of this phase in ROADMAP.md, loaded explicitly below as `PHASE_GOAL`
(`roadmap.get-phase --pick goal`, the query `verify-work/steps/mvp-uat-framing.md` uses) — the same
value for both callers, never left for the model to resolve. Resolve the rest the same way:

```bash
_GSD_SHIM_NAME="gsd-tools.cjs"; _GSD_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; GSD_TOOLS="${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}"; _gsd_at() { for _p; do if [ -f "$_p" ]; then GSD_TOOLS="$_p"; return 0; fi; done; return 1; }; _gsd_id_ok() { case "$("$1" runtime-identity --raw 2>/dev/null || true)" in '{"packageName":"@opengsd/gsd-core"'*'}') return 0;; *) return 1;; esac; }; _gsd_homes() { _gsd_at "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/gsd-core/bin/${_GSD_SHIM_NAME}" "${HERMES_HOME:-$HOME/.hermes}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CURSOR_CONFIG_DIR:-$HOME/.cursor}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CODEX_HOME:-$HOME/.codex}/gsd-core/bin/${_GSD_SHIM_NAME}" "${GEMINI_CONFIG_DIR:-$HOME/.gemini}/gsd-core/bin/${_GSD_SHIM_NAME}" "${COPILOT_CONFIG_DIR:-$HOME/.copilot}/gsd-core/bin/${_GSD_SHIM_NAME}" "${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}/gsd-core/bin/${_GSD_SHIM_NAME}" "${AUGMENT_CONFIG_DIR:-$HOME/.augment}/gsd-core/bin/${_GSD_SHIM_NAME}" "${TRAE_CONFIG_DIR:-$HOME/.trae}/gsd-core/bin/${_GSD_SHIM_NAME}" "${QWEN_CONFIG_DIR:-$HOME/.qwen}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CLINE_CONFIG_DIR:-$HOME/.cline}/gsd-core/bin/${_GSD_SHIM_NAME}" "${GROK_AGENTS_HOME:-$HOME/.agents}/gsd-core/bin/${_GSD_SHIM_NAME}" "${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}/gsd-core/bin/${_GSD_SHIM_NAME}" "${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/gsd-core/bin/${_GSD_SHIM_NAME}" "${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}/gsd-core/bin/${_GSD_SHIM_NAME}"; }; if _gsd_at "${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}"; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif _gsd_homes; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif unset -f gsd_run; _G="$(command -v gsd_run)"; [ -n "$_G" ] && _gsd_id_ok "$_G"; then GSD_TOOLS="$_G"; gsd_run() { "$GSD_TOOLS" "$@"; }; else echo "ERROR: gsd-tools.cjs not found at $GSD_TOOLS and no identity-proving gsd_run is on PATH. Run: npx -y @opengsd/gsd-core@latest --claude --local" >&2; exit 1; fi; GSD_IDENTITY_STATUS=unverified; _gsd_id_ok gsd_run && GSD_IDENTITY_STATUS=ok; export GSD_IDENTITY_STATUS; [ "$GSD_IDENTITY_STATUS" = ok ] || echo "WARNING: \"$GSD_TOOLS\" did not prove it is @opengsd/gsd-core - it is either a different package or an @opengsd/gsd-core older than the runtime-identity verb. See docs/how-to/diagnose-a-foreign-gsd-tools.md" >&2; if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -n "${GSD_TOOLS:-}" ]; then printf "export PATH='%s':\"\$PATH\"\n" "${GSD_TOOLS%/*}" >> "$CLAUDE_ENV_FILE" 2>/dev/null || true; fi
TDD_MODE=${TDD_MODE:-$(gsd_run loop render-hooks execute:post --active-cap tdd)}
# #4772: this file is Read, not textually substituted - write the parent command's original argument string in place of $ARGUMENTS so --ws reaches the query.
GSD_WS=$(echo " $ARGUMENTS" | sed -nE 's/.* --ws +([A-Za-z0-9][A-Za-z0-9._-]*).*/--ws \1/p' | head -n 1)
VERIFIER_SKILLS=$(gsd_run query agent-skills gsd-verifier ${GSD_WS:+--ws=${GSD_WS##* }})
CONTEXT_WINDOW=$(gsd_run query config-get context_window --raw 2>/dev/null || echo "200000")
PHASE_GOAL=$(gsd_run query roadmap.get-phase "${PHASE_NUMBER}" ${GSD_WS:+--ws} ${GSD_WS:+"${GSD_WS##*[[:space:]]}"} --pick goal)
```
</step>

<step name="verify_post_security_gate">
**`verify:post` hook dispatch and the SECURITY threats-open gate.** This runs BEFORE the verifier
writes (and fingerprints) the report, so the dispatch takes no `--after-fingerprint` — nothing is
fingerprinted yet, and gating on it here would be a no-op by construction (the allowlisted exception
in `scripts/lint-verify-lifecycle-writes.allowlist.json`).

```bash
VERIFY_POST_HOOKS_JSON=$(gsd_run loop render-hooks verify:post --raw)
SECURITY_FILE=$(ls "${PHASE_DIR}"/*-SECURITY.md 2>/dev/null | head -1)
```

Dispatch every `kind == "step"` hook per @gsd-core/references/loop-hook-dispatch.md (skip when none). The secure-phase routing below applies when that specific hook is active.

If no active secure-phase step hook exists: skip.

If an active secure-phase step hook exists AND `SECURITY_FILE` is empty (no SECURITY.md yet):
Include in the next-steps routing output:
```
⚠ Security enforcement enabled — run before advancing:
  /gsd:secure-phase {PHASE} ${GSD_WS}
```

If an active secure-phase step hook exists AND SECURITY.md exists: check frontmatter `threats_open`. If > 0:
```
⚠ Security gate: {threats_open} threats open
  /gsd:secure-phase {PHASE} — resolve before advancing
```
</step>

<step name="code_review_gate" required="true">
**This step is REQUIRED to evaluate the capability hook.** When the code-review capability is active, auto-invoke code review on the phase's source changes. Advisory only — never blocks execution flow. Also dispatches advisory execute:post gate hooks (e.g. tdd.review-checkpoint).

**Capability gate:**
```bash
EXECUTE_POST_HOOKS_JSON=${EXECUTE_POST_HOOKS_JSON:-$(gsd_run loop render-hooks execute:post --raw)}
```

Dispatch `kind == "step"` hooks per @gsd-core/references/loop-hook-dispatch.md. `ref.skill == "code-review"`:

If no active code-review step hook exists: display "Code review skipped (code-review capability inactive)" and proceed to gate dispatch.

**Invoke review:**
```
Skill(skill="gsd-${ref.skill}", args="${PHASE_NUMBER}")
```

**Report the review, and record what happened to each finding.** Read and execute `gsd-core/workflows/execute-phase/steps/code-review-disposition.md`.
It parses REVIEW.md's frontmatter, states the per-severity counts, and writes
`<NN>-REVIEW-DISPOSITION.md` — one row per finding, defaulting to `open` — so a triaged finding is
distinguishable downstream from a forgotten one. It consumes `PHASE_DIR` and `PHASE_NUMBER`, and is
advisory throughout: it never blocks.

**Error handling:** If the Skill invocation fails or throws, catch the error, display "Code review encountered an error (non-blocking): {error}" and proceed to gate dispatch. Review failures must never block execution.

**Execute:post gate hook dispatch.** After code review, dispatch all active gate hooks from `EXECUTE_POST_HOOKS_JSON` where `kind == "gate"`. ⚠ **Validate `check` before shell use** (third-party manifest input) — `loop-hook-dispatch.md` § `gate`. For each, run the form below, or — for a `predicate` gate (ADR-2008 / #2008) — `gsd_run check predicate --predicate '<predicate JSON>' --phase-number "${PHASE_NUMBER}" --raw`:

```bash
GATE_RESULT=$(gsd_run check ${hook.check.query} "${PHASE_NUMBER}" --raw) && CHECK_EXIT=0 || CHECK_EXIT=$?
```

`${hook.check.query}` is deliberately left unquoted: it is a multi-word query (verb plus flags) that must word-split, and it is safe only because it is charset-validated first per `loop-hook-dispatch.md` § `gate`.

**Gate evaluation** uses the same two-step contract as the `execute:wave:post` gates (`execute-phase/steps/wave-post-gate-hooks.md`).

**TDD review escalation (overrides the advisory default for the `tdd.review-checkpoint` gate only).** The tdd `execute:post` gate is declared `blocking: false`, so by the generic contract above it displays its `message`/table and continues. There is ONE documented exception (see `~/.claude/gsd-core/references/execute-mvp-tdd.md`): when `TDD_MODE=true` AND `GATE_RESULT.block == true` (one or more TDD plans miss a RED or GREEN gate commit; #4011 — no MVP condition), the end-of-phase TDD review escalates from advisory to **blocking under TDD** — refuse to mark the phase complete and present:

```
Phase blocked: {N} TDD plan(s) violate the RED→GREEN gate sequence under TDD.
Resolve and re-run /gsd:execute-phase, or override with /gsd:execute-phase {phase} --force-mvp-gate to ship anyway.
```

(`--force-mvp-gate` is the documented, not-yet-implemented escape hatch.) Outside TDD mode, TDD-review violations remain advisory (table shown, execution continues).

**Proceed rule:** If `TDD_MODE && GATE_RESULT.block == true` for `tdd.review-checkpoint`: STOP — do NOT proceed to `close_parent_artifacts`, `regression_gate`, the verifier, or `phase.complete`. Otherwise proceed normally.
</step>

<step name="close_parent_artifacts_dispatch">
**Gap-closure parent artifacts (its original place: after the code-review gate, before the regression
gate).** If `section_manifest` is `null` or `"gap-closure-artifacts"` is in its `included` list: read
and execute `gsd-core/workflows/execute-phase/steps/gap-closure-artifacts.md`. Otherwise skip — do
not read the file. It applies to decimal (gap-closure) phases only and is a no-op for any other phase.
</step>

<step name="regression_gate_dispatch">
**Regression gate, gated by the section manifest (#2932).** If `section_manifest` is `null` or
`"regression-gate"` is in its `included` list: read and execute
`gsd-core/workflows/execute-phase/steps/regression-gate.md`. Otherwise skip — do not read the file.
On `REGRESSION GATE ABORTED`, HALT — do not dispatch the verifier.
</step>

<step name="verifier_dispatch">
**Dispatch the verifier.** Verify the phase achieved its GOAL, not just completed tasks.

```
Agent(
  description="Verify phase {phase_number} goal achievement",
  prompt="Verify phase {phase_number} goal achievement.
Phase directory: {phase_dir}
Phase goal: {PHASE_GOAL}
Phase requirement IDs: {phase_req_ids}
Check must_haves against actual codebase.
Cross-reference requirement IDs from PLAN frontmatter against REQUIREMENTS.md — every ID MUST be accounted for.
Create VERIFICATION.md.
Use response_language {response_language} for all user-facing prose — narration between tool calls, status updates, progress notes, and findings included; preserve code and paths.

<required_reading>
Read these files before verification:
- {phase_dir}/*-PLAN.md (All plans — understand intent, check must_haves)
- {phase_dir}/*-SUMMARY.md (All summaries — cross-reference claimed vs actual)
- {requirements_path} (Requirement traceability)
${CONTEXT_WINDOW >= 500000 ? `- {phase_dir}/*-CONTEXT.md (User decisions — verify they were honored)
- {phase_dir}/*-RESEARCH.md (Known pitfalls — check for traps)
- Prior VERIFICATION.md files from earlier phases (regression check)
` : ''}
</required_reading>

${VERIFIER_SKILLS}",
  subagent_type="gsd-verifier",
  model="{verifier_model}"
)
```

(When `response_language` is unset, omit the `Use response_language …` line.)

> **ORCHESTRATOR RULE — CODEX RUNTIME**: After calling Agent() above, stop working on this task immediately. Do not read more files, edit code, or run tests related to this task while the subagent is active. Wait for the subagent to return its result. This prevents duplicate work, conflicting edits, and wasted context. Only resume when the subagent result is available. If the session ends abnormally (`turn_aborted`), reconcile via the `verification.status` query below — the session's terminal state is not evidence of failure (#4217).

**Regeneration.** The verifier — not the orchestrator — recomputes the covered-input fingerprint
through the CLI over the report's covered set and copies the command's `covered_files` /
`covered_digest` output verbatim into the new report (`agents/gsd-verifier.md` `<output>`):

```bash
# Run by gsd-verifier over the files the report covers — never computed by hand.
gsd_run query verification.fingerprint "${PHASE_DIR}" "${COVERED_FILES[@]}"
```

**Read the regenerated verdict** through the owner, keeping stderr:

```bash
VERIFICATION=$(gsd_run query verification.status "$PHASE_DIR") || { echo "verification.status refused this phase's report — see the error above. The report the verifier wrote carries a status outside passed | gaps_found | human_needed; fix its frontmatter before continuing." >&2; exit 1; }
STATUS=$(printf '%s' "$VERIFICATION" | jq -r '.status')
ROUTE=$(printf '%s' "$VERIFICATION" | jq -r '.route')
NEXT_ACTION=$(printf '%s' "$VERIFICATION" | jq -r '.next_action')
NEXT_COMMAND=$(printf '%s' "$VERIFICATION" | jq -r '.next_command')
```

A non-zero exit here is the write-time hard error (#5118): the report is rejected in the run that
produced it. Present the error verbatim and stop — never read it as "no status".

Never silently proceed past a stale gate: if `STATUS` is still `stale` after the verifier ran,
stop and present `$NEXT_ACTION` (#4623 covers what the digest hashes).

Otherwise return to the including step with `STATUS`, `ROUTE`, `NEXT_ACTION` and `NEXT_COMMAND`
set.
</step>
