# Prevention / Blameless-Postmortem Output

Loaded by `gsd-debugger` via `@-include` from `archive_session`. Emits the
forward-looking half of a resolved debug session — not just *what* was wrong and
the fix, but **why it happened, why it wasn't caught, and the guard that
prevents its whole class from returning**.

## Why this exists

When a session resolves, the debugger records `root_cause` + `fix` and appends a
keyword entry to the knowledge base. What it did **not** produce is the
forward-looking half that industry incident practice (Google SRE Book, AWS COE)
treats as the whole point: a blameless postmortem / Correction of Error. The
bug gets fixed; the *class* of bug and the *reason it slipped through* are never
captured — so the same class recurs and no guardrail is added. This block closes
that gap. It reuses the existing debug file and knowledge base; it does not add a
new command or workflow.

## The Prevention block (three blame-free components)

At `archive_session`, after the fix is confirmed, emit a Prevention block and
fold its two structured fields (`why_not_caught`, `recurrence_guard`) into the
knowledge-base entry.

### 1. Blameless 5-Whys that BRANCHES (per Phase 2A RCA)

A causal chain — but **branch across ≥2 Ishikawa categories**, do not collapse to
a single linear "why" (the same single-cause bias Phase 2A guards the diagnosis
against applies to the postmortem). For each branch ask "why" until you reach an
actionable condition.

**Reuse the diagnosis branches:** the `reasoning_checkpoint.candidate_causes`
recorded at Phase 2A already enumerated the candidate causes across the four
categories (**code / config / environment / data** — see
`debugger-rca-branching.md`); start the postmortem from those branches and the
AND-gate answer rather than re-deriving a chain from scratch.

**Blame-free:** treat "agent error" / "human error" as a prompt for *"why was
that error possible?"* — not a terminal cause. A postmortem that stops at "the
engineer made a mistake" prevents nothing; one that asks "why was the mistake
possible / not caught" produces a guard. Never assign blame to a person.

### 2. "Why wasn't this caught?"

Name the **existing gate** that should have caught this bug class and didn't —
a test, a type check, a lint rule, code review, the verify step, the build. If
the honest answer is "no gate existed for this class," that itself is the finding
(and the recurrence guard below is "add the gate").

### 3. The recurrence guard

The **concrete artifact** that prevents this class from returning. Choose the
strongest applicable:

- a **regression test** (already produced by Test-First Debugging — reference it),
- an **assertion / precondition** (fail loud at runtime if the bad condition recurs),
- a **type refinement** (make the bad state unrepresentable — the strongest guard
  in a typed codebase; e.g., a branded type / exhaustive union that rules out the
  invalid value at compile time),
- a **config-default change** (eliminate the misconfiguration that enabled the
  bug — flip the default so the unsafe path is opt-in, not the path of least resistance),
- a **lint rule / broken-window ledger entry** (fail the build / surface in review),
- a **knowledge-base pattern** — this very entry, so a future Phase-0 recall
  surfaces the prior guard when a similar symptom appears.

State the guard concretely (which file, which rule, which test name) — not "add
a test" but "the regression test at `tests/foo.test.cjs:42` now covers this
class." **Verify the artifact exists before recording it** (the test passes, the
type compiles, the lint rule is registered) — a stale or unverified path is worse
than none, since a future Phase-0 match would surface it as if it were real.

## Knowledge-base entry: the two structured fields

The KB entry gains two fields (additive — see backward-compat below):

- **Why not caught:** {the existing gate that should have caught it, or "no gate existed for this class"}
- **Recurrence guard:** {the concrete artifact — regression test / assertion / lint rule / KB pattern — with its location}

These ride alongside the existing `Error patterns` / `Root cause(s)` / `Fix` /
`Files changed` fields so a future Phase-0 match surfaces not just the prior fix
but the prior *prevention*.

## Backward compatibility (additive — no format break)

Old knowledge-base entries without `why_not_caught` / `recurrence_guard`
**still load** unchanged. The matcher reads the `Error patterns` field (which
every entry has); the two new fields are consumed when present and ignored when
absent. A knowledge base with a mix of old and new entries works correctly —
there is no migration, no schema version bump.

## Scope boundary (Zawinski's Law)

A **block**, not an incident-management subsystem. It reuses the existing debug
file's `archive_session` step and the existing knowledge base; it adds two
fields and three prompt-level questions. It is not a new command, not a
reporting framework, not a metrics pipeline. Where a bug is trivial and the
postmortem would add nothing, a one-line recurrence guard suffices — the
discipline scales down.
