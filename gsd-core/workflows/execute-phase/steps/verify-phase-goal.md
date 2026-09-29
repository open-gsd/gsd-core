Apply response_language to all user-facing prose — narration between tool calls, status updates, progress notes, and findings included; preserve code, paths, and identifiers.

<step name="verify_phase_goal_regeneration">
**The one regeneration action for a phase's VERIFICATION.md (#5118, ADR-5057 Phase 4).** The
verification owner routes `stale` (and `missing`) to `execute-phase`; this file is what that route
runs. It is included by BOTH surfaces that regenerate a report, so there is one route and one action:

- `execute-phase.md` step `verify_phase_goal` — reached after `aggregate_results` →
  `code_review_gate` → `regression_gate` in that workflow's own step order. Skip the entry gates
  below and start at **Dispatch the verifier**.
- `verify-work.md` step `complete_session`, stale arm — the security gate already ran in
  `complete_session`; run the entry gates below first.

**Inputs.** `PHASE_DIR`, `PHASE_NUMBER`, the phase goal (ROADMAP.md), and from
`gsd_run query init.execute-phase "${PHASE_NUMBER}"`: `verifier_model`, `phase_req_ids`,
`requirements_path`; `CONTEXT_WINDOW` from `gsd_run query config-get context_window` (default
`200000`).

**Entry gates (verify-work's stale arm only).** The gates execute-phase runs before its verifier,
in the same order — never skip one on this path:
1. Code review: run the `code_review_gate` step of `gsd-core/workflows/execute-phase.md` exactly as
   written (execute:post hooks; advisory, except the TDD escalation it documents).
2. Regression gate: read and execute `gsd-core/workflows/execute-phase/steps/regression-gate.md`
   (it skips itself when there are no prior phases).

**Dispatch the verifier.** Verify the phase achieved its GOAL, not just completed tasks.

```bash
VERIFIER_SKILLS=$(gsd_run query agent-skills gsd-verifier)
```

```
Agent(
  description="Verify phase {phase_number} goal achievement",
  prompt="Verify phase {phase_number} goal achievement.
Phase directory: {phase_dir}
Phase goal: {goal from ROADMAP.md}
Phase requirement IDs: {phase_req_ids}
Check must_haves against actual codebase.
Cross-reference requirement IDs from PLAN frontmatter against REQUIREMENTS.md — every ID MUST be accounted for.
Create VERIFICATION.md.

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
set: execute-phase presents the per-status outcome; verify-work continues at its completion
predicate.
</step>
