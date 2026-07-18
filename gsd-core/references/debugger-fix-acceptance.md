# Fix-Acceptance Guardrail (Anti-Overfitting)

Loaded by `gsd-debugger` via `@-include`. The multi-signal gate that prevents
accepting a fix that merely greens the test.

## Why this exists

`fix_and_verify`'s operational success signal — "the failing test now passes" —
is gameable. Automated Program Repair research (Smith et al., FSE 2015; Qi et
al., ISSTA 2015) found APR patches routinely overfit: ~98% of "plausible"
GenProg patches were functionality-deleting no-ops that vacuously satisfy a weak
oracle. An LLM optimizing "make the test green" is subject to the same failure
mode — suppress the symptom, delete the branch, weaken the assertion.

Per **Goodhart's Law**, the defense is not a better single metric — it is several
**independent** signals that pull in different directions, plus separating the
test that *drives* the fix from the check that *judges* it. That is this gate.

## The five signals

A fix is accepted only when **all applicable signals** agree. Any one failing
signal (that is not a justified technical-debt escape — see below) rejects the
fix and returns `## FIX REJECTED BY GUARDRAIL`.

1. **Target test greens** — the regression test that reproduced the bug now
   passes. (Existing bar; the driving test.)

2. **Mutation check** — run Stryker scoped to the changed line(s). The
   regression test must **kill** a mutant seeded at the fix site. A **surviving
   mutant** means the test asserts the symptom, not the root cause, and the fix
   is **rejected**. `mutationScore = killed / totalValid`.

3. **No-op / behavior-deleting detector** — inspect `git diff` of the fix. If
   the net change only **deletes** or short-circuits behavior (removed branches,
   early returns that skip logic, weakened assertions, comment-outs, blanket
   `return null`), the fix is **rejected** unless the `reasoning_checkpoint`
   RCA/root-cause analysis **explicitly justifies** a removal. This guards the
   "98% were deletions" failure mode.

4. **Adjacent / held-out tests green** — the existing regression-testing step,
   made a hard gate. Run tests touching the changed file's import graph. Any
   newly-broken neighbor **rejects** the fix.

5. **Revert-and-reconfirm** (Agans Rule 9 — "If you didn't fix it, it ain't
   fixed") — revert the fix, confirm the bug returns; reapply, confirm it is
   gone. Proves *this* change is what fixed it. Must run **before** a fix is
   accepted. If the fix cannot be cleanly reverted (it touched multiple
   concerns), that itself is a finding — the fix is not minimal; flag it.

## Graceful degradation (Gall's Law — each signal degrades onto the working agent)

Signals degrade onto whatever the environment provides. Every degradation is
**logged/recorded** in the debug file (Kernighan — the debugger stays
auditable); a skipped signal is never silently passed.

| Signal | When unavailable | Behavior |
|---|---|---|
| 2. Mutation check | no Stryker configured / Stryker absent / not configured | **skip** with a logged note (`mutation_check: skipped, reason`) — never assume pass |
| 4. Adjacent tests | no test suite touching the import graph | skip with a logged note |
| 1, 3, 5 | no test suite at all | guardrail **reduces** to signals 3 + 5 (no-op/deletion detector + revert-and-reconfirm) |
| 1, 3, 5 | no test suite AND no repro | cannot verify at all → return a `CHECKPOINT REACHED` to the human; do not silently pass |

The reduction path matters: with **no test suite**, the guardrail still bites via
the no-op/deletion detector (signal 3) and revert-and-reconfirm (signal 5).

## Per-signal results recorded to the debug file

Every signal's result is written to `Resolution.verification` as a structured
per-signal record (see `gsd-core/templates/DEBUG.md`):

```yaml
verification:
  target_test:        { result: pass | fail }
  mutation_check:     { result: pass | fail | skipped, reason_if_skipped, mutant_killed }
  no_op_deletion:     { result: pass | flagged, deletion_justified_by_rca: true | false }
  adjacent_tests:     { result: pass | fail | skipped, suites_run: [...] }
  revert_and_reconfirm: { result: pass | fail, bug_returned_on_revert: true | false, fixed_on_reapply: true | false }
  guardrail_verdict:  accepted | rejected
  rejected_signal:    <signal name, if rejected>
```

If the fix is accepted as documented technical debt (escape hatch below), record
`guardrail_verdict: accepted_debt` plus the justification.

## FIX REJECTED BY GUARDRAIL

When any applicable signal fails (and no technical-debt escape applies), do
**not** request human verification. Return:

```markdown
## FIX REJECTED BY GUARDRAIL

**Debug Session:** .planning/debug/{slug}.md
**Failing signal:** {signal 1–5 name}
**Evidence:** {why the signal failed — e.g. "mutant at fix site survived",
  "diff is deletion-only with no RCA justification", "bug did not return on revert"}

### Signals

- target_test: {pass|fail|skipped}
- mutation_check: {pass|fail|skipped — reason}
- no_op_deletion: {pass|flagged}
- adjacent_tests: {pass|fail|skipped}
- revert_and_reconfirm: {pass|fail|not-run}

### Next

Revise the fix so the failing signal passes, or accept as documented technical
debt (requires explicit justification recorded in the debug file).
```

The session-manager continuation loop handles this return: it surfaces the
failing signal and offers revise / accept-as-debt / abandon. It does **not** mark
the session resolved.

## Bounded subprocesses (CLAUDE.md gauntlet)

The mutation check shells out to Stryker. Every such subprocess is **bounded**
with a timeout (npm: 60s per CLAUDE.md). On timeout, the signal is recorded as
`skipped — mutation check timed out` (logged, never a silent pass) and the
guardrail proceeds on the remaining signals. Never run an unbounded Stryker;
never let the mutation check hang the debug session.

Scope Stryker to the changed lines (`--mutate` on the fix's diff hunk) so the run
is fast and the mutant is seeded exactly at the fix site.

## Escape hatch — documented technical debt

If a signal cannot be made to pass and the human (via the session-manager
continuation) accepts the fix anyway, record `guardrail_verdict: accepted_debt`
with an explicit justification and the name of the unmet signal. This is the only
way a fix lands without the gate passing, and it is never silent — the debt is
written to the debug file and surfaced in the resolution summary.

## Scope boundary (Zawinski's Law)

This guardrail hardens fix acceptance for **one bug**. It is not a test
framework, not a CI policy, and not an incident-management system. Where a signal
reuses existing structure (Stryker, the regression step), it reuses — it does not
build a parallel system.
