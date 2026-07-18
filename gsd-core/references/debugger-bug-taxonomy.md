# Bug-Taxonomy Classification + Strategy Routing

Loaded by `gsd-debugger` via `@-include` from Phase 1.75 (classify the failure)
and the Technique Selection table. Classifies the failure early and **routes**
which investigation technique to use, **replacing** (not appending to) the flat
"pick something from the menu" habit with selection-by-class.

## Why this exists

The 11 investigation techniques are all still here — they are the *routed
targets*, not an undifferentiated list. But picking the right technique ad hoc
wastes cycles or actively misleads: a deterministic **Bohrbug** wants
reproduction + fault localization + bisection; a **Heisenbug/Mandelbug** will
*disappear or change* under naive repro-and-inspect and wants record-replay or
stability-stress; a **concurrency** bug wants the atomicity/order/deadlock
checklist before general techniques. Classification takes one sentence and
routes the rest.

## The taxonomy (Phase 1.75 — classify before forming hypotheses)

Record `bug_class` in Current Focus (lowercase-kebab value: `bohrbug`,
`heisenbug-mandelbug`, or `concurrency` — prose may use title-case for
readability) as one of:

- **Bohrbug** — solid, deterministic, always reproduces under the same inputs
  (named for the Bohr atom: solid, localized, easy to pin down).
- **Heisenbug / Mandelbug** — transient, non-deterministic, changes under
  observation; **Mandelbug** specifically covers aging-related failures
  (resource exhaustion, uptime-dependent state, slow accumulation) whose cause
  is tangled with the system rather than purely timing.
- **Concurrency** — atomicity-violation, order-violation, or deadlock (the Lu et
  al. 2008 classification) arising from interleaved execution.

If the class is genuinely unclear after one observation, gather one more piece
of evidence (does it reproduce on immediate retry? does it depend on uptime?)
rather than forcing a guess — but record the leading candidate as `bug_class`
and revise it as evidence accumulates.

## The routing table (explicit, inspectable — Kernighan: no opaque heuristic)

| bug_class | Route to | Revoke if already run |
|---|---|---|
| **Bohrbug** | deterministic reproduction → **SBFL (Phase 1.25)** → git bisect → binary search | — |
| **Heisenbug / Mandelbug** | record-replay (`rr`) → stability-stress → statistical sampling; for Mandelbug, look for resource-exhaustion / uptime-dependent patterns | **SBFL** — if Phase 1.25 already ran, **mark its Evidence entry revoked** (flaky spectrum poisons `failed(s)`) |
| **Concurrency** | the atomicity / order / deadlock checklist (below) FIRST, then general techniques | — |
| **General (any class — situation-cued)** | Binary search (large codebase), Working backwards (known desired output), Differential debugging (worked-before/works-elsewhere), Delta debugging (large change set), Comment out everything (many possible causes), Follow the indirection (constructed paths/URLs/keys), Rubber duck (confused), Observability first (always, before changes) | — |

The class-routed rows decide which technique to reach for **first**. The
General lane holds the situational techniques that apply regardless of class —
they are not orphaned; they are the second move once the class-specific route
has been exhausted or does not apply.

### The SBFL rule is retroactive revocation, not proactive skip

Note the ordering: Phase 1.25 (SBFL) runs **before** Phase 1.75 (classification),
so for a Heisenbug the SBFL-skip cannot fire proactively — it fires as
**retroactive revocation**. When the class later resolves to Heisenbug or
Mandelbug, mark the prior SBFL Evidence entry as revoked (do not delete — see
`debugger-sbfl.md`) and note why. A flaky "failing" test makes `failed(s)`
unreliable, so the Ochiai ranking is noise on a Heisenbug spectrum.

## The concurrency checklist (suspected Concurrency class)

Run this BEFORE general techniques:

1. **Atomicity** — is a read-modify-write non-atomic? (check-then-act without a
   lock, missing compare-and-swap, a "get then set" across an await/yield)
2. **Order** — can two operations legally interleave to produce the bad state?
   (missing happens-before / synchronization; publish-before-init; init order
   across async boundaries)
3. **Deadlock** — circular wait on locks/resources? (hold-and-wait, no
   preemption, mutual blocking on shared resources)

If any branch hits, that becomes the leading hypothesis for Phase 2 (and feeds
the RCA `candidate_causes` — concurrency bugs typically bridge code +
environment, per `debugger-rca-branching.md`).

## Relationship to the other disciplines

- **SBFL (Phase 1.25)** is the go-to pre-filter for Bohrbugs; it is explicitly
  not trusted on Heisenbug/Mandelbug spectra (retroactively revoked — see
  above).
- **RCA branching (Phase 2A)** still applies once the route lands you at a
  hypothesis — concurrency bugs almost always AND-gate (code race +
  environment/config amplification), so branch across categories.

## Bound the Heisenbug-chase runs (CLAUDE.md gauntlet — unbounded subprocess)

`rr record` on a real application, stability-stress runs, and statistical
sampling (N repeated executions) can each run minutes-to-hours. Bound them:
cap `rr record` and each stress/sampling loop (60s for npm-tier, scale with
suite size; a fixed iteration count for sampling), and **degrade to a logged
skip on timeout** — never let a Heisenbug chase hang the debug session. If a
run is cut short, note how far it got in Evidence.

## Supersede, not append (Zawinski's Law)

This **replaces** the flat "Technique Selection by situation" habit with
"Technique Selection by bug class." The 11 techniques remain available in
`<investigation_techniques>` as the routed targets: the three class rows route
the **first** move, and the General lane holds the situation-cued techniques
that apply to any class. Where a class route and a situation-based hunch
disagree, the class route wins (a situation table can't tell a Bohrbug from a
Heisenbug; the class can).

## Scope boundary

Classification + one routing table + the concurrency checklist. Not a new
subsystem, not a probability model, not an auto-classifier — the agent reads the
symptoms and assigns the class by judgment, then the table routes. The chosen
class and strategy are written to the debug file so the decision is inspectable.
