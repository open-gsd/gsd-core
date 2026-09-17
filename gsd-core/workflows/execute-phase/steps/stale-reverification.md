<step name="stale_reverification">
Covered source files changed after the verifier last ran — the recorded digest no longer
matches, so the report cannot be trusted until the verifier re-runs (#4682). The plans are all
summarized: there is no wave work to do.

Report:
```
"Verification is stale — covered source changed after the verifier ran (#4682). Re-running the verifier for this phase."
```

SKIP `cross_ai_delegation`, `execute_waves` and `checkpoint_handling` — there is no wave work —
and continue directly at `aggregate_results` exactly as the `missing` route (#2868): the tail
steps re-run in their normal order (`aggregate_results` → `code_review_gate` →
`close_parent_artifacts` → `regression_gate` → `verify_phase_goal` → `update_roadmap`), and
`verify_phase_goal` re-dispatches the `gsd-verifier`, regenerating VERIFICATION.md and its
digest. This holds whether or not the phase was already marked complete — a stale report on a
marked phase is refreshed the same way. `verification.status`'s `next_command` routes here for
exactly this state.

Never silently proceed past a stale gate: if the re-run verifier still produces a stale report,
stop and present it (#4623 covers what the digest hashes).
</step>
