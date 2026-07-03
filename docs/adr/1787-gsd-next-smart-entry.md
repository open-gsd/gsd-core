# ADR 1787: `/gsd:next` smart-entry front door delegates advancement to `/gsd:progress --next`

- **Status:** Accepted
- **Date:** 2026-07-03
- **Issue:** #1787
- **Implementation:** PR #1798 (`feat(#1787): add /gsd:next smart entry workflow`)
- **Supersedes context:** the removal of the flat `gsd-next` command (#3054)

## Context

gsd-core has no state-aware front door. A user must already know whether to
reach for `/gsd:progress`, `/gsd:plan-phase`, `/gsd:execute-phase`, `/gsd:quick`,
or `/gsd:new-project`. gsd-pi ships a `/gsd` smart-entry wizard (a state-aware
menu with one recommended action) that users run first; gsd-core wants the same
"run one command, get told what to do next" feel without gsd-pi's TUI, since
gsd-core is a markdown prompt framework installed into AI agents, not a Node app.

Two facts constrain the design:

1. **A `gsd-next` command already existed and was deliberately removed (#3054),**
   with `/gsd:progress --next` established as the canonical "advance to the next
   logical step" engine. `tests/bug-3054-stale-gsd-next-references.test.cjs`
   guards against user-facing surfaces re-referencing the removed flat command.
   Re-introducing a `next` entry point re-opens a settled question: it must not
   recreate the duplication that justified the removal.

2. **`/gsd:progress` is the "unified GSD situational command."** Its `--next`
   mode (`gsd-core/workflows/next.md`) is a *gated* advancement engine:
   - **Route 0** — the resume-incomplete-phase invariant (#160): if a session
     died mid-execution and `STATE.md`'s `current_phase` advanced past a phase
     that still has `PLAN.md` files without matching `SUMMARY.md`, `--next`
     resumes the *incomplete earlier* phase rather than the recorded current one.
   - **Gates 1–3** — unresolved checkpoint, error/failed state, and unchecked
     verification failures each hard-stop advancement.

The initial implementation of the new `smart-entry` classifier
(`src/smart-entry.cts`) re-derived in-project forward routing itself. For the
`executing` situation it recommended dispatching `/gsd:execute-phase` **directly**,
bypassing Route 0 and Gates 1–3. That reproduced exactly the duplication that got
`gsd-next` removed — two front doors that can route the *same* in-project state
to *different* phases — and introduced a correctness hazard (executing the
recorded current phase while an earlier phase is silently incomplete). A
maintainer (davesienkowski) flagged the overlap on PR #1798.

## Decision

Ship `/gsd:next` as a **menu front door only**, with a hard boundary against
re-implementing advancement:

1. **Detection + classification** live in Node as `gsd-tools smart-entry [--json]`
   (`src/smart-entry.cts`): a pure, unit-tested classifier over `.planning/STATE.md`,
   `ROADMAP.md`, and read-only git signals, producing one of 11 situations with a
   recommended action and an action menu. **Presentation + dispatch** live in the
   markdown layer (`commands/gsd/next.md` → `gsd-core/workflows/smart-entry.md`),
   using `AskUserQuestion` with a `--text` numbered-list fallback for non-Claude
   runtimes. The command carries no `requires` field so it works pre-project.

2. **In-project forward motion delegates to the single gated engine.** For the
   `planning`, `executing`, and `verify-pending` situations, the *recommended*
   action is `/gsd:progress --next`. smart-entry never re-derives forward routing;
   it hands linear advancement to `workflows/next.md` so Route 0 and Gates 1–3 are
   always honored. The specific command (`/gsd:plan-phase`, `/gsd:execute-phase`,
   `/gsd:verify-work`) remains available as an explicit secondary menu option for a
   user who deliberately wants to bypass advancement gating.

3. **smart-entry's distinct value is the states `--next` cannot reach.** For
   situations *off* the linear advance path it keeps direct recommendations, since
   these are precisely what `/gsd:progress --next` does not (or cannot, given its
   `requires: [phase]`) handle: `no-project` → `/gsd:new-project`, `paused` →
   `/gsd:resume-work`, `blocked` → `/gsd:debug`, `verify-failed` →
   `/gsd:verify-work`, `needs-first-phase` → `/gsd:discuss-phase`, `idle-stranded`
   → `/gsd:ship`, `complete` → `/gsd:new-milestone`, `unknown` → `/gsd:progress`.

This makes the spec's stated decision #4 ("complementary, not redundant") true in
the implementation, not just the prose: there is exactly one advancement engine,
and `/gsd:next` is a menu over it plus the off-path states.

## Consequences

### Positive

- **One advancement engine.** `/gsd:next` and `/gsd:progress --next` can never
  disagree about the next in-project step, and Route 0 / Gates 1–3 cannot be
  bypassed through the new front door. The #3054 duplication does not return.
- **Genuine new value, no overlap.** The front door adds pre-project, remediation,
  and lifecycle-exit routing that `--next` structurally cannot serve.
- **Testable boundary.** `tests/smart-entry.unit.test.cjs` asserts that every
  forward-motion situation recommends `/gsd:progress --next` and every off-path
  situation keeps its direct recommendation — the delegation is a regression-locked
  contract, not a convention.

### Negative / trade-offs

- One extra indirection hop for the common "just continue" case (`/gsd:next` →
  `/gsd:progress --next` → dispatched command) versus dispatching the phase command
  directly. Accepted: the hop is what buys gate-safety and single-engine behavior.
- The classifier reads STATE.md via shared primitives (`frontmatter.cjs`,
  `state-document.cjs`, `phase-id.cjs`) rather than through `workflows/next.md`'s
  own detection, so detection logic exists in two places. Accepted: they share
  parsing primitives and only the *routing decision* is centralized (in `--next`),
  which is where divergence would actually harm the user.

## Alternatives considered

1. **Keep smart-entry as an independent in-project router (as first implemented).**
   Rejected: reproduces the #3054 duplication and the Route 0 / Gates 1–3 bypass
   hazard.
2. **Fold everything into `/gsd:progress` (add a menu mode) and ship no new
   command.** Rejected: `/gsd:progress` carries `requires: [phase]` and cannot
   serve the pre-project `no-project` front-door case, which is a primary goal.
3. **Replace `workflows/next.md`'s inline detection with the new classifier so
   there is one detection *and* routing engine.** Rejected for this PR: `--next`
   couples detection to safety gates and convergence flags the classifier does not
   model; swapping its detection wholesale would risk regressing those invariants.
   Left as possible future consolidation.

## References

- Spec: `docs/superpowers/specs/2026-06-27-gsd-smart-entry-design.md`
- Removed flat command guard: `tests/bug-3054-stale-gsd-next-references.test.cjs`
- Gated engine: `gsd-core/workflows/next.md` (Route 0 = resume-incomplete-phase, #160)
- Classifier: `src/smart-entry.cts` → `gsd-core/bin/lib/smart-entry.cjs`
- Command contract naming (`gsd:*`): ADR-0002
