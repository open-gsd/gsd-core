# ADR-1769: STATE.md Transition Module — intent-based transitions over scattered RMW callbacks

- **Status:** Accepted (Phase 7 closeout — all 10 lifecycle/maintenance transitions migrated; bug cluster #1760/#1761/#1743/#1695/#1264/#1255/#1257/#3242 retired)
- **Date:** 2026-06-27 (Phase 0); Phase 7 closeout 2026-06-27
- **Issue:** [#1769](https://github.com/open-gsd/gsd-core/issues/1769) — epic
- **Supersedes:** the policy portions of `syncStateFrontmatter` (`src/state.cts:1667–1743`),
  `readModifyWriteStateMd`'s post-sync preservation block (`src/state.cts:2008–2119`), and
  the format-detection duplication across 14 RMW callbacks in `state.cts` plus direct
  `writeStateMd` callers in `phase.cts:1770` and `milestone.cts:352`. Does NOT supersede
  `state-document.cjs`'s parse/extract/replace primitives — those are deep and stay.

## Context

`CONTEXT.md`'s "STATE.md Document Module" entry describes a deep leaf: parse, extract,
replace primitives, no persistence or locking. The friction lives in the **adapter layer**
above it.

STATE.md writes happen via three mechanisms today:

1. **`readModifyWriteStateMd(statePath, transformFn, cwd, options, clock)`** — the RMW seam.
   Called from 14 sites in `state.cts`, each passing a closure that re-encodes format
   detection, field preservation, and section mutation.
2. **Direct `writeStateMd` / `syncStateFrontmatter` calls** in `milestone.cts:352`
   (milestone complete), `verify.cts:1899` (regenerateState recovery), and
   `phase.cts:1770` (phase complete state-half, inside `writePlanningFileSet`).
3. **`cmdStateBuildFrontmatter`** — Encoding 3 of the preservation policy, used by the
   read path (`cmdStateJson`).

The **preservation policy** ("which fields win when frontmatter and body disagree?") is
encoded in **three places that drift independently**:

- `syncStateFrontmatter` (`state.cts:1667–1743`) — preserves status when derived='unknown',
  preserves milestone_name vs. placeholder, preserves stopped_at/paused_at/current_phase/
  current_phase_name/current_plan/progress when derived is empty.
- `readModifyWriteStateMd` post-sync block (`state.cts:2069–2113`) — restores progress
  block when `resync=false`, preserves status/stopped_at when body source field unchanged
  (#1230 delta heuristic).
- `cmdStateBuildFrontmatter` (`state.cts:1469+`) — own copies of the status/progress
  preservation rules.

The same field has different rules in different encodings. `progress` has two rules.
`status` has three. `stopped_at` has two.

**Bug cluster this produces:** #1760 (prune no-ops), #1761 (sync writes wrong progress),
#1743 (patch clobbers curated field), #1695 (patch clobbers current_phase_name), #1264
(resync=false restore), #1255/#1257 (format mismatch), #3242 (curated-progress ratchet).
Every fix is per-call-site and doesn't touch the other 13.

The friction shape: ADR-857/1372/1508/3660 correctly identified the **leaf modules** and
gave them depth. The remaining friction is in the **adapter layer** that didn't finish
thinning. The recurring pattern is *"seam adopted for locating, hand-rolled code retained
for mutating"* — `tokenizeHeadings` was adopted, `replaceSection` was not.

## Decision

Introduce a **STATE.md Transition Module** as a sibling/super-module of the STATE.md Document
Module. Seven design decisions, resolved via `/grilling`:

### 1. Module shape: Transition Module owns the full transaction

The Module owns lock → read → apply transition → preserve policy → write. Interface is
intent-based: `beginPhase(statePath, phaseNum)`, `advancePlan(statePath, planId)`, etc.
The 14 RMW callbacks collapse to 14 one-line transition calls.

*Rejected:* (B) Field Policy Module (locks stay outside) — leaves lock/scan bugs tangled
with policy bugs. (C) Widen state-document — shallow; format-detection + I/O concerns
leak in.

### 2. Method set: 10 transitions (lifecycle + maintenance + milestoneComplete)

`beginPhase`, `advancePlan`, `completePhase`, `plannedPhase`, `milestoneSwitch`,
`milestoneComplete`, `patch`, `sync`, `prune`, `update`.

*Rejected:* (i) Lifecycle only (5) — leaves maintenance bugs #1760/#1743 alive.
(iii) All 16 writers — interface balloons, hurting depth.

### 3. I/O shape: pure core + injected deps

`transitionCore(content, intent, deps) → newContent` where
`deps = { progressProvider, writer, locker, clock }`. A thin adapter wires the real I/O.
Tests pass stubs.

*Rejected:* (a) Absorb all four I/O concerns — too much fs surface in the core.
(b) Own transaction + lock; delegate disk scan — awkward coupling.

This shape also enables `phase.cts:1770`'s use case: the transition core is called inside
`writePlanningFileSet(writes)` (multi-file transaction), not just inside `writeStateMd`.
Pure function = leverage across multiple orchestration shapes. Concretely: in Phase 3,
`completePhase` runs inside the multi-file ROADMAP+REQUIREMENTS+STATE transaction without
the transition core knowing it is inside a transaction. The core only sees
`(content, intent, deps) → newContent`; the orchestrator handles lock acquisition,
multi-file atomicity, and write ordering. This isolates the atomicity risk to the
orchestration layer, where the existing `writePlanningFileSet` already owns it.

### 4. Policy model: field-classification table

Each STATE.md field has a row: `{ source: body|disk|external|curated|free, preservation:
derive|preserve-when-unchanged|preserve-always|clear }`. Transitions declare which body
fields they touch; the core consults the table.

*Rejected:* (α) Per-transition hardcoded policy — duplicates the rule × 10 transitions =
today's pain. (γ) Per-transition DSL — adds learning cost, still drifts.

The table kills the bug class by construction: `patch` consulting the table sees
`current_phase_name` is `curated` and refuses to overwrite unless explicitly named. #1743
impossible.

### 5. External writers: 2 migrate, 1 stays

- `milestone.cts:352` (milestone complete) → migrates to `milestoneComplete` transition.
- `phase.cts:1770` (phase complete state-half) → migrates to `completePhase` transition,
  called as pure function inside the existing multi-file transaction.
- `verify.cts:1899` (`regenerateState` recovery) → **stays as direct `writeStateMd`**.
  Factory-reset primitive, not a transition; nothing to preserve.

### 6. Core scope: writes only

Core owns the table + 10 transitions + format detection + preservation + frontmatter/body
invariant. Body section structure (`## Current Position`, `## Session`, etc.) lives as a
constants block at the top of the core.

*Outside the core:*

- Append-only transitions (`addDecision`, `addBlocker`, etc.) — stay on today's RMW. They
  don't touch curated fields; routing them through the core adds interface width without
  buying depth.
- Read path (`cmdStateBuildFrontmatter`, Encoding 3) — different concern (interpretation,
  not preservation). Stays separate.
- `verify.cts:1899` regenerateState — factory reset, not a transition.

*Rejected:* (B) Widen to reads — grows the table past preservation into interpretation.
(C) Absorb append-only — interface balloons to ~17 methods.

### 7. Migration: substrate first, then transition-by-transition

Per ADR-1372 §T6's "high risk, load-bearing, surgical, last" rating, big-bang is the wrong
shape. The migration sequence:

- **Phase 0:** ADR + CONTEXT.md update (this PR).
- **Phase 1:** Substrate — transition core skeleton + table + section constants +
  `beginPhase` migration + characterization tests.
- **Phase 2:** `advancePlan`.
- **Phase 3:** `completePhase` + `phase.cts:1770` migration (proves pure-core-inside-
  multi-file-transaction).
- **Phase 4:** `plannedPhase`, `milestoneSwitch`.
- **Phase 5:** `milestoneComplete` + `milestone.cts:352` migration.
- **Phase 6:** `patch` (covers #1743, #1695).
- **Phase 7:** `sync`, `prune`, `update` (covers #1760, #1761).

Per-transition discipline: characterization tests first (capture current behavior including
the bug-preservation we want to keep, e.g. #1230's delta heuristic), then migrate, then
verify old tests still pass, then add bug-fix tests for what the migration fixes.

*Rejected:* (A) Big-bang — half-finished migration is what we're fixing. (C) Substrate
alongside, leave callbacks — parallel worlds don't converge (ADR-857's failure mode).

## Consequences

**Positive:**

- Bug cluster killed structurally: #1760/#1761/#1743/#1695/#1264/#1255/#1257/#3242 each
  become impossible-by-construction or one-row table fixes.
- ADR-1372 §T6 completed: `replaceSection` from the markdown sectionizer becomes the
  body-mutation primitive inside the transition core.
- Test surface improves: tests pass `deps` stubs, no `.planning/phases/*` fixtures required
  for policy tests.
- `phase.cts:1770` and `milestone.cts:352` stop reimplementing format detection and
  section regexes (the `// allow-adhoc-markdown: pre-seam section write-modify` lint
  suppressions in `milestone.cts` are deleted).

**Negative:**

- 10 transitions × characterization tests = substantial test volume in Phase 1 substrate.
- The field-classification table is a new shared artifact — adding a new STATE.md field
  means one table row, but a new field *class* means updating every transition that
  declares which classes it touches. (Single-enum: 5 classes; expected to be stable.)
- Migration is sequenced (8 phases, 8 PRs) — the codebase carries both old and new shapes
  between Phase 1 and Phase 7. Each PR is independently shippable; the old shape is fully
  retired only at Phase 7.

**Neutral:**

- `readModifyWriteStateMd` and `writeStateMd` stay exported during the migration; they're
  used by the 7 append-only callbacks that aren't migrating.
- `cmdStateBuildFrontmatter` (Encoding 3) stays as the read path; future work may converge
  it with the table, but that's out of scope here.

## Alternatives considered

1. **Widen STATE.md Document Module to absorb the policy.** Rejected — Document Module owns
   pure parse/extract/replace; widening pulls format detection and preservation policy into
   the leaf, hurting its depth.
2. **Per-transition hardcoded policy (option α in design).** Rejected — duplicates the rule
   per transition; same field has different rules in different transitions = today's pain.
3. **All 16 writers in core (option iii in design).** Rejected — interface balloons to ~17
   methods, hurting depth. Append-only transitions don't touch curated fields.
4. **Big-bang migration (option A in design).** Rejected — ADR-1372 §T6 rates this surface
   "high risk, surgical." Half-finished migration is what we're fixing.
5. **Substrate alongside, leave callbacks (option C in design).** Rejected — parallel worlds
   don't converge. ADR-857's "decompose Core" produced today's half-finished state precisely
   because new code moved and old code stayed.
6. **Defer until ADR-1372 §T6 finishes independently.** Rejected — §T6 has been deferred for
   over a year precisely because there's no consumer for `replaceSection` in the state path.
   The Transition Module is the consumer; the two land together.

## Phases

| Phase | Scope | Closes issue | Bug coverage |
|---|---|---|---|
| 0 | ADR + CONTEXT.md update | #1769 | — |
| 1 | Substrate + `beginPhase` | #1771 | #1255, #1257, #3242 |
| 2 | `advancePlan` | #1782 | — |
| 3 | `completePhase` + `phase.cts:1770` | #1784 | — |
| 4 | `plannedPhase` + `milestoneSwitch` | #1786 | — |
| 5 | `milestoneComplete` + `milestone.cts:352` | #1789 | — |
| 6 | `patch` | #1791 | #1743, #1695 |
| 7 | `sync`, `prune`, `update` | #1793 | #1760, #1761 |

## Amendments

### #1796 — Finish the preservation consolidation (Path A)

**Date:** 2026-06-28 · **Status:** Accepted

Surfaced by an `/adr-phase-coverage` audit of this ADR (issue #1796): the
Consequences claim that the module *"Absorbs … `readModifyWriteStateMd`'s
post-sync preservation block"* was **not** realized by Phases 0–7. The block
stayed inline in `readModifyWriteStateMd` (`state.cts`); only
`current_phase_name`'s preservation was table-driven. `#1264` was fixed by a
call-site `shouldResync` guard rather than the field-classification table, so the
bug *class* was not "killed structurally" as the Consequences (line 161) claimed.

**Resolution — Path A ("finish the consolidation"):** the post-sync preservation
block is now the pure, field-classification-table-driven `applyStatePreservation`
in `src/state-transition.cts`, consulted via `getFieldClassification` for **all
four** preserved fields — `progress`, `status`, `stopped_at`, `current_phase_name`
(previously only the last was table-driven). `readModifyWriteStateMd` calls it.
This makes the CONTEXT.md "Absorbs … post-sync preservation block" claim accurate
and routes the `#1264` preservation policy through the single field-classification
table (one policy source, not three drifting encodings).

Behavior is byte-identical to the pre-amendment inline block (Hyrum-safe — 15
callers' observable preservation is unchanged); the full state / frontmatter /
transition regression suite (847 tests, including the `#1264`, `#1743`, `#1695`,
`#1760`, `#1761`, `#3242`, `#1230` characterization blocks) passes unmodified.
A codex (gpt-5.5 / high) adversarial review returned CLEAN — no behavior drift
across a 58,564-case equivalence sweep, no security surface introduced.

The `shouldResync` call-site guard remains — it is the transition's declaration
of "am I re-deriving from disk?" What changed is that the *preservation policy*
it feeds is now centralized and table-driven rather than re-encoded per writer,
which is the consolidation this ADR originally specified.
