# ADR-1817: STATE.md rebuild — derivability contract (capstone transition)

- **Status:** Accepted (Phase 0 — ADR + CONTEXT.md update; lands ahead of Phases 1–2)
- **Date:** 2026-06-29
- **Issue:** [#1817](https://github.com/open-gsd/gsd-core/issues/1817) — epic
- **Builds on:** [ADR-1769](1769-state-md-transition-module.md) (STATE.md Transition Module). Adds the 11th transition (`rebuild`) on top of ADR-1769's 10 lifecycle/maintenance intents.
- **Supersedes:** nothing. Extends ADR-1769's transition set; does not revisit its design.

## Context

ADR-1769 landed the STATE.md Transition Module with 10 intent-based transitions
(`beginPhase`, `advancePlan`, `completePhase`, `plannedPhase`, `milestoneSwitch`,
`milestoneComplete`, `patch`, `sync`, `prune`, `update`) and a field-classification
table that killed the per-call-site preservation-policy bug cluster (#1760, #1761,
#1743, #1695, #1264, #1255, #1257, #3242). Each transition touches **individual
fields**.

A second bug class survived ADR-1769: **body-structure drift** that no current
command can reconcile. `syncCore` (the lightest-weight transition) only patches
three frontmatter fields — `Total Plans in Phase`, `Progress`, `Last Activity` —
and intentionally does not re-derive body structure. `buildStateFrontmatter`
re-derives all frontmatter from body + disk scan but does not touch the body
itself. The result: **the body can diverge from ground truth indefinitely while
`gsd-tools state sync` reports `synced: true`.**

Observed drift signatures (full list in epic #1817):

- `## Current Position` prose fields (Phase, Status, Current Plan) contradict
  frontmatter after a milestone switch or prune.
- `## By-Phase Progress` table has orphaned rows for phases from a prior
  milestone or rows with zero-padded phase IDs that were renamed.
- Template-placeholder field values (`[phase name]`, `[date]`) left in place
  when an AI agent wrote partial state.
- Duplicate `## Session Continuity Archive` blocks from repeated
  `state record-session` calls on a corrupt file.
- `stopped_at` in frontmatter sourced from the wrong section (an archive block
  rather than the current `## Session` block) — bug #2444's guard only applies
  in `buildStateFrontmatter`, not to the body itself.
- `progress.total_phases` in frontmatter correct, but `Phase: [N] of [M]` prose
  still shows the old milestone's count.

Three open issues sit in this defect class: **#1776** (`cmdStatePrune` phase
fallback matches any `| Phase | N |` table cell, not `## Current Position`
prose → requires scoped body extraction), **#1761** (`state sync` writes wrong
progress when ROADMAP lacks versioned milestone headings → a rebuild would
re-derive from disk + ROADMAP together), **#1591** (`phase.complete` mis-parses
`<details>`-wrapped roadmaps and garbles counters → a rebuild can reconcile
from canonical disk sources rather than parsing ROADMAP mid-transition).

The deeper shape: **every body-level drift bug today requires a per-bug regex
fix.** Ten-plus closed issues (#1658, #1659, #1668, #1446, #1230, #948, #549,
#500, #363, #316) each added a narrow guard that didn't prevent the next
variant. A `rebuild` transition that re-derives the **canonical body sections**
from ROADMAP + phase dirs + session history would resolve the entire class
without per-bug patches.

## Decision

Add `rebuild` as the **11th intent** in `transitionCore` (ADR-1769 §6 "Core
scope: writes only"). Six design decisions, resolved via `/grilling`:

### 1. The `rebuild` intent is a maintenance transition, same tier as the other 10

`rebuild` is a STATE.md Transition Module method, dispatched from
`transitionCore`'s switch alongside `sync`, `prune`, `update`, etc. Pure core
`(content, intent, deps) → newContent`, same shape as ADR-1769 §3.

**Capability tier (ADR-857 analog):** `rebuild` is **core substrate**, not a
Feature Capability. It is non-toggleable, lives inside the transition module,
and is not subject to ADR-857 capability consent/overlay. This mirrors ADR-550
§83's "verifier↔predicate contract is core/non-toggleable" rule for the
verification seam: the derivability contract documented here is the state-seam
equivalent.

*Rejected:* (B) Implement `rebuild` as a Feature Capability that users opt into
— rejected because the bug class is core STATE.md correctness, not optional
behavior. (C) Keep `rebuild` outside the Transition Module (a sibling
utility) — rejected: it must own the same lock→read→apply→preserve→write
transaction ADR-1769 §1 specified for the other 10 transitions; a sibling
utility would re-encapsulate that machinery and drift.

### 2. Section taxonomy: derived vs preserved

Each STATE.md body section is classified as **re-derivable** or **preserved**.
`rebuild` consults the taxonomy; it never re-derives a preserved section and
never preserves a re-derivable one verbatim when the canonical source
disagrees.

| Section | Class | Source of truth | Rebuild behavior |
|---|---|---|---|
| `## Current Position` prose | re-derivable | Frontmatter (which `buildStateFrontmatter` already derives correctly from disk + ROADMAP) | Re-derive each prose field from the corresponding frontmatter field; replace verbatim. |
| `## By-Phase Progress` table | re-derivable | Phase dirs on disk (same source as `buildStateFrontmatter`'s disk scan) | Re-derive the entire table from disk; drop orphaned rows. |
| `## Session` block | preserved | Human-curated current-session data | Preserve verbatim. (Only the *current* `## Session` block; archived sessions are de-duplicated per §4.) |
| `## Decisions` | preserved | Human-curated decision log | Preserve verbatim. Staleness is `pruneCore`'s concern, not rebuild's. |
| `## Session Continuity Archive` | preserved, de-duplicated | Prior session snapshots | Keep the most-recent N (configurable; default 3); drop duplicates; preserve kept entries verbatim. |
| `## Rebuild Log` | appended (new section) | The rebuild transition itself | Append one entry per rebuild that mutated the file; never re-derive or edit prior entries. |
| Any other `## …` section | preserved (unknown) | Human-curated | Preserve verbatim. Rebuild does not recognize or rewrite sections outside the taxonomy. |

**Section ordering is invariant.** Rebuild rewrites the *content* of
re-derivable sections in place; it does not reorder sections, insert new
sections (other than `## Rebuild Log` if absent), or remove sections.

*Principle:* derive what is derivable, preserve what is curated, log what is
dropped. (Postel's Law applied to a state file: be liberal in what you accept
— any drifted input — and conservative in what you send — canonical form for
derived, verbatim for preserved.)

*Rejected:* (α) Treat all sections as re-derivable — rejected: destroys
human-curated content (session notes, decisions). (β) Treat all sections as
preserved — rejected: this is the status quo; the drift class survives.

### 3. Orphaned data: log + drop (audit trail mandatory)

When `rebuild` encounters canonical-source-disagreement that requires dropping
data, it MUST append a structured entry to `## Rebuild Log` recording:

- `timestamp` (ISO-8601, from the injected `clock`)
- `kind` — one of `orphaned-row`, `placeholder-removed`, `archive-deduplicated`,
  `wrong-section-source`, `milestone-count-stale`, or `section-rewritten`
- `section` — which body section was mutated
- `before` / `after` — the dropped/changed content (truncated to 512 chars per
  entry to bound log growth)
- `reason` — short structured string explaining the canonical source that won

`## Rebuild Log` is itself **preserved** (per §2). Rebuild never rewrites or
truncates prior log entries; it only appends. A separate prune step (out of
scope here) governs log retention.

**Why log everything:** dropping user-adjacent data without a trace is hostile
even when the drop is correct. The log gives the user an undo path (manual
re-add) and gives the maintainer a debugging signal when rebuild drops
something it shouldn't have. (Hyrum's Law mitigation: the drop is observable,
the audit trail is the contract.)

*Rejected:* silent drop — rejected: violates the ADR-1411 resolution-provenance
principle that mutation decisions report what they did, not fall open silently.

### 4. Idempotency is a hard guarantee

`rebuild` is **idempotent**: invoking it twice in succession on the same file
produces no change on the second invocation. This is testable and tested.

The idempotency contract has two parts:

1. **Body content idempotency:** re-running rebuild on a file rebuild just
   canonicalized produces byte-identical `## Current Position` and
   `## By-Phase Progress` sections.
2. **Rebuild Log idempotency:** a rebuild that mutates nothing appends no log
   entry. (This is what makes the second-invocation case truly byte-identical
   — without it, the second run would always append a no-op log entry and
   violate idempotency.)

The log-appends-only-on-mutation rule is the load-bearing constraint. If
rebuild wrote a log entry unconditionally on every invocation, idempotency
would break.

### 5. Interaction with `sync` — non-overlapping scopes

`sync` and `rebuild` compose; they do not compete.

| Transition | Scope | Trigger | Latency |
|---|---|---|---|
| `sync` | 3 frontmatter fields (`Total Plans in Phase`, `Progress`, `Last Activity`) | Auto-triggered on every state transition | Lightweight, runs on every transition |
| `rebuild` | Body structure (`## Current Position`, `## By-Phase Progress`, archive dedup) | Manual (`gsd-tools state rebuild`) | Heavier; reads disk + ROADMAP; explicit user invocation |

Running `sync` after `rebuild` is safe: `sync`'s 3 fields are a strict subset
of what `rebuild` reconciled (in canonical form), so sync's derivation will
produce the same values rebuild just wrote. Running `rebuild` after `sync` is
also safe: rebuild re-derives body from canonical sources; sync's just-written
frontmatter is one of those sources.

`sync` stays as the auto-triggered lightweight path; `rebuild` is the
user-invoked heavy reconciliation. Neither subsumes the other.

### 6. Interaction with `auto_prune_state` — orthogonal concerns

`rebuild` does NOT prune. Pruning (removing data that is no longer relevant,
e.g. decisions older than N sessions, prior-milestone state) is a separate
concern governed by `auto_prune_state` and `pruneCore`.

The distinction:

- **Rebuild reconciles** body with current canonical sources. A `## By-Phase
  Progress` row for a phase that no longer exists on disk is dropped because
  it is *canonical-mismatched*, not because it is *old*.
- **Prune removes** data based on age/staleness policy. A `## Decisions`
  entry from 6 months ago stays under rebuild (preserved) but may be removed
  by prune based on retention policy.

The two compose: rebuild first (reconcile with canonical sources), then prune
(remove per policy). Rebuild never makes pruning decisions; prune never
re-derives structure.

## Consequences

**Positive:**

- The body-structure drift bug class is killed structurally. #1776, #1761,
  and #1591 each become either directly fixable by `rebuild` or indirectly
  addressable (the rebuild provides the scoped body extraction those bugs
  need).
- The derivability contract is a new correctness invariant: STATE.md body
  is **derivable from canonical sources at any time**, not just incrementally
  updatable. This is the capstone property ADR-1769's per-field transitions
  couldn't deliver alone.
- The audit log gives the maintainer a debugging signal when STATE.md editing
  (manual or AI-driven) produces drift that rebuild later reconciles.
- Future drift classes (anything not in the §2 taxonomy today) can be added
  by extending the taxonomy + a new `kind` in the log enum, without
  re-touching the transition core's dispatch shape (Gall's Law: extend, don't
  rewrite).

**Negative:**

- A new body section (`## Rebuild Log`) is added to STATE.md. Older GSD
  versions reading the file ignore the section (preserved verbatim by
  `readModifyWriteStateMd`'s post-sync block — the section name is not in
  the field-classification table, so it falls through as "unknown, preserved").
- The derivability contract is a new shared artifact: any future STATE.md
  body section must declare its taxonomy class. Adding a new re-derivable
  section is a non-trivial change (rebuild must learn the derivation rule);
  adding a new preserved section is mechanical.
- The first invocation of `rebuild` on a long-lived project will produce a
  substantial audit log entry (the project's accumulated drift is reconciled
  in one pass). This is honest — the drift existed; rebuild surfaces it —
  but users may be surprised by the log size on first run. Mitigation:
  `--dry-run` flag (Phase 2) previews the diff before writing.

**Neutral:**

- `rebuildCore` is a pure function over `(content, intent, deps)`, callable
  inside any orchestration shape (single-file write, multi-file transaction,
  dry-run preview). Same property that let ADR-1769 §3 run `completePhase`
  inside `writePlanningFileSet`.
- The existing 10 transitions are unchanged. `transitionCore`'s switch grows
  from 10 cases to 11; the missing-case-compile-time-error guarantee
  (ADR-1769 §1) extends to the new case.

## Alternatives considered

1. **Fix each body-level bug individually (status quo).** Rejected: already
   done for 10+ closed issues. Each fix is a narrow regex guard that doesn't
   prevent the next variant. Does not scale; the open issues (#1776, #1761,
   #1591) are evidence.
2. **`state sync` expansion — extend `syncCore` to cover body structure.**
   Rejected: `sync` is intentionally lightweight and auto-triggers on every
   transition. Making it re-derive body structure would make every state
   transition pay the disk-scan + ROADMAP-read cost, and would couple
   auto-triggered behavior to a heavier and riskier code path. The
   manual/auto split (§5) is the right factoring.
3. **Regenerate STATE.md from scratch (nuke-and-rebuild).** Rejected: loses
   curated human content (session notes, decisions, archives). The
   derivability contract is *selective* — derived sections re-derive,
   preserved sections survive — which is exactly what a nuke-and-rebuild
   cannot do.
4. **A standalone `state-doctor` workflow outside the transition module.** Rejected:
   same drift-from-canonical-shape risk that motivated ADR-1769's
   consolidation. A workflow that bypasses the transition module re-imports
   the lock/scan/preservation machinery and re-creates the bug class.
5. **Defer until ADR-1769's amendments (#1796) finish independently.**
   Rejected: ADR-1769 is closed (Phase 7 closeout + #1796 amendment landed).
   There is no consumer-driven sequencing constraint; the rebuild transition
   composes cleanly with the existing 10.

## Phases

This epic (#1817) is implemented in three phases, each its own PR. Phase 0
closes this issue (the epic); Phases 1 and 2 close their own sub-issues.

| Phase | Scope | Closes issue | Bug coverage |
|---|---|---|---|
| 0 | ADR + CONTEXT.md update (derivability contract, preserved-vs-derived taxonomy, idempotency, sync/prune interaction) | #1817 | — |
| 1 | `rebuildCore` body + `rebuild` intent dispatch case + drift-class unit tests | #1827 | surfaces the class; #1776, #1761, #1591 become directly addressable |
| 2 | `cmdStateRebuild` CLI + `--dry-run` / `--verbose` + integration tests + `docs/commands/state.md` + changeset | #1826 | end-to-end reconciliation available to users |

Per-transition discipline (inherited from ADR-1769 §7): characterization tests
first (capture the drift signatures we want to reconcile), then implement
`rebuildCore`, then verify existing `pruneCore` / `syncCore` tests still pass,
then add idempotency tests.
