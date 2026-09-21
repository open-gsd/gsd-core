# ADR-4910: Planning documents are read and written through one parse → mutate → serialize seam [Proposed]

- **Status:** Proposed — design lock for Phases 1–6 of epic [#4906](https://github.com/open-gsd/gsd-core/issues/4906). Ratify to `Accepted` at Phase 6 closeout, once the phases have demonstrably shipped. No production code lands in this PR.
- **Date:** 2026-09-20
- **Issue:** [#4910](https://github.com/open-gsd/gsd-core/issues/4910) — Phase 0 of epic [#4906](https://github.com/open-gsd/gsd-core/issues/4906)
- **Subsumes as layers:** [ADR-1372](1372-markdown-sectionizer-seam.md) (`markdown-sectionizer` — structure), [ADR-2143](2143-markdown-table-and-mutation-consolidation.md) (`markdown-table`, bounded mutation, fail-loud `Result<T>`). Both remain in force and unchanged; this ADR frames them as the layers a planning document composes, and neither is a rewrite target. **Their reciprocal `Subsumed by` back-links are deliberately not added yet:** `docs/adr/README.md` lifecycle rule 3 states that only an `Accepted` ADR is owed the back-link, because a `Proposed` ADR's claim is prospective. They land in the Phase 6 ratification PR, when this ADR becomes `Accepted` and the index check begins demanding them.
- **Relationship to prior work:** the third consolidation in this family, after [#1372](https://github.com/open-gsd/gsd-core/issues/1372) (read seam) and [#2143](https://github.com/open-gsd/gsd-core/issues/2143) (tables, bounded mutation, fail-loud). Sibling: [#2121](https://github.com/open-gsd/gsd-core/issues/2121) (`phase-id.cts`). The node-scoped parse-error contract (§5) applies to documents the `Evidence` distinction [#4631](https://github.com/open-gsd/gsd-core/issues/4631) draws for gates.

## Context

Twelve open `confirmed-bug` issues are one defect: **GSD's durable state lives in prose markdown,
and every verb brings its own regex to it.**

Two seams already exist for this and both are correct. `markdown-sectionizer` ([ADR-1372](1372-markdown-sectionizer-seam.md)) owns
fenced code, headings, sections and bullets. `markdown-table` ([ADR-2143](2143-markdown-table-and-mutation-consolidation.md)) owns GFM tables, the
bounded `withSection` mutation primitive, and the fail-loud `Result<T>` in `write-set.cts`. What
neither owns is the **composition**: a planning document is frontmatter + a section tree + tables +
bold-label fields + checklists, and the verbs that mutate one reach past all three seams to a
`String.replace`.

The result is a repo that ships a strict escaping reader and an unescaped prose writer for the same
table.

### Four arms, one missing owner

**(a) The writer emits what the reader is required to reject.** `quick.md` Step 7c interpolates a
raw `${DESCRIPTION}` into a pipe row; `escapeCell` exists at `src/markdown-table.cts:716` — and its
own doc comment describes a *caller-must-re-escape contract*, i.e. an obligation the caller may
simply not discharge — and is applied per column at `:852-862` on the *generated* path, not this
one. A task description containing a
Jinja filter permanently ragged the table, and `quick-tasks-migrate` cannot help because the next
`/gsd-quick` re-corrupts it ([#4736](https://github.com/open-gsd/gsd-core/issues/4736)). A project
that migrates is not out of the state. Symmetrically, `parseDecisions` rejects a second colon in a
plain-prose bold lead-in — text `discuss-phase` itself emits — forcing
`outcome: "could-not-parse"` and hard-blocking `check.decision-coverage-plan`
([#4793](https://github.com/open-gsd/gsd-core/issues/4793)).

**(b) A structural write replaces a line span and destroys what shares the line.**
`src/phase.cts:3795` (on `next`) matches `/(\*\*Plans:\*\*\s*)[^\n]+/i` — one capture group, the
rest of the line matched and uncaptured — and `:3842` re-emits `$1` and a new count and nothing
else. On a real close that deleted 174 of the line's 205 characters, a paragraph documenting a
design decision, with no warning and a payload reporting success
([#4852](https://github.com/open-gsd/gsd-core/issues/4852)).

This is the **third** occurrence of one defect. `src/roadmap.cts:1196` — the sibling writer for the
*same line* — already does it correctly, and the gap between the two sites is not subtle. Its
`planCountPattern` carries three capture groups (label, count token, trailing) and `:1213-1216`
re-emits `${label}${planCountText}${trailing}`, under a comment enumerating **three arms**:

> 1. `$2` present (a real count token) → rewrite the token, preserve `$3` verbatim (an annotation a
>    human wrote after a real count; #2853). […] 3. Anything else (freeform prose, `TBD` / `TBD —
>    annotation`, a bracketed human note, the first line of a wrapped sentence, an empty value) →
>    leave the whole matched line untouched.

It even distinguishes a fresh-template placeholder from a bracketed *human* annotation that is
structurally identical (`[Deferred pending re-scope]`), positively, on wording — because treating
the two alike was bug #3584 Finding A. That is three arms of accumulated care at one site and none
of it at the other.

The pattern arrived in `d49a7d0c4` (fix #2853, 2026-07-31) and was tightened in `0f417aa6d` (fix
#3584, 2026-08-18). **Neither touched `src/phase.cts`.** The same shape appears
again in `state.update "Last Activity"`, which deletes `last_activity_desc` and `state_head` while
its own payload lists `"Last Activity Description"` under `preserved`
([#4862](https://github.com/open-gsd/gsd-core/issues/4862)).

The correct implementation existing beside the incorrect one, in the same repo, for the same line,
with a comment explaining the rule, is the evidence that a comment is not a mechanism.

**(c) Unrecognised grammar returns empty instead of raising.** `roadmap.analyze` returns
`phases: []` and `phase_count: 0` for a checklist-only ROADMAP — a shape `templates/roadmap.md`
itself emits — *while the same call builds 26 `missing_phase_details` tokens and discards them*,
and while the same tree enumerates 20 phases through `init.progress`
([#4899](https://github.com/open-gsd/gsd-core/issues/4899)). `adr-parser` returns `decisions: []`
for `## 11. Locked decisions` and **reports success**, from two independent causes: the leading
section number is not stripped, and `locked decisions` is not a synonym
([#4900](https://github.com/open-gsd/gsd-core/issues/4900)). `extractPhaseFieldMultiline` folds
list items, fences, lowercase labels and inline `**mentions**` into a field value, and one shape
silently marks *another phase's* requirement complete
([#4837](https://github.com/open-gsd/gsd-core/issues/4837)).

In each case a caller cannot distinguish *"this document records nothing"* from *"I could not read
this document."*

**(d) The pattern is duplicated, so a fix lands at one copy.** #4478's phase-heading anchor fix
landed in `roadmap-parser.cjs`; `init.cjs:2229`, `:2401`, `:3044` and `milestone.cjs:646` keep
unanchored `gi` copies, while `init.cjs:116` — in the same file as three of them — is anchored
correctly ([#4865](https://github.com/open-gsd/gsd-core/issues/4865)). The codebase disagrees with
itself inside one file. Same shape in
[#4661](https://github.com/open-gsd/gsd-core/issues/4661) (`/gsd:undo`'s unanchored ERE over
`git log`), [#4605](https://github.com/open-gsd/gsd-core/issues/4605) /
[#4606](https://github.com/open-gsd/gsd-core/issues/4606) (`pr-branch`'s `STRUCTURAL_RE`), and
[#4499](https://github.com/open-gsd/gsd-core/issues/4499) (`frontmatter.set` reformatting block
sequences it was not asked to touch).

### Why a design lock, before any code phase

Three facts make this ADR necessary rather than ceremonial.

1. **The composition layer is a genuine gap, not an oversight to patch.** [ADR-1372](1372-markdown-sectionizer-seam.md) explicitly
   excluded tables, mutation and fail-loud; [ADR-2143](2143-markdown-table-and-mutation-consolidation.md) covered those three and scoped itself to
   `ROADMAP.md` / `STATE.md` mutation sites, listing *"migrating non-planning markdown"* as a
   non-goal and document-model parsing as out of #3180's scope. A planning *document* as one
   object has never had an owner. Six phases will build against whatever this file says.

2. **The epic names a drain point that does a different job — and a ratchet the language cannot
   deliver.** Both are corrected in §6 and §7 below. Discovering either mid-Phase-5 would strand
   the phase.

3. **Six of the twelve absorbed issues have open community PRs right now.** #4762 (#4736), #4897
   (#4837), #4848 (#4661), #4610 (#4605), #4609 (#4606) and #4530 (#4499) are point fixes in
   flight from external contributors — the epic's stated non-goal, already happening in the
   contribution queue. §9 records what follows from that; the disposition itself is a maintainer
   decision, not this ADR's to take.

There is no recorded ADR or Cortex decision governing this composition seam today
(`recall_decision` returns no governing contract; `.out-of-scope/` carries no prior denial), so
later phases have nothing authoritative to build against.

## Decision

Eight decisions, locked. Phases 1–6 execute against them as separate PRs.

### 1. One `PlanningDoc` seam, composing the existing layers

A new leaf module parses a planning artifact **once** into a `PlanningDoc`: frontmatter, a section
tree, and typed field nodes (bold-label line, GFM table, checklist). It is owned by neither
`phase` nor `roadmap` nor `state`, because all three need it — the same Conway's-Law reasoning
`src/plan-document.cts`'s own docblock records for itself.

The three existing seams are its **layers, not its alternatives**: `markdown-sectionizer` for
structure (including `stripFencedCode` / `scanInlineCodeSpans`, so fence- and code-span-awareness
is delegated rather than re-decided), `markdown-table` for tables, `frontmatter.cts` for
frontmatter, `write-set.cts` for `Result<T>` and `WriteOutcome`. **Extend, never mutate** —
[ADR-2143](2143-markdown-table-and-mutation-consolidation.md) §2's lock is inherited verbatim. Neither `Accepted` ADR is reopened by this work.

The seam is **registry-scoped to planning artifacts**, not to markdown in general. `.planning/`
artifacts are already enumerated by `src/artifacts.cts`'s `isCanonicalPlanningFile`; the registry
extends that rather than inventing a second notion of what a planning document is.

> **Naming, recorded as a live risk.** `src/plan-document.cts` already exists and parses one
> `*-PLAN.md` **body**. The ambiguity is resolved by **absorption** — that module becomes a typed
> field reader beneath this seam — not by a naming convention every future author must be told.
> Until that lands, the two names are close enough to confuse, and this note is the warning.

### 2. A structural write replaces a node. There is no span, because there is no regex.

A field write owns its token and re-emits everything else on its line **by construction**. The
parser decides where a value ends and hands the writer a node carrying a `valueSpan`; the writer
has no expression that can reach past it.

This is the same rule `src/roadmap.cts:1196` encodes by hand in a third capture group and a
comment. The difference is that `$3` stops existing, because capture groups stop existing. A rule
that depends on an author reading a comment has now failed three times (#2853, #3584, #4852) at
one line in one file.

Mutation is node-addressed, never path-string-addressed. A path string (`"phases.3.plans"`) is a
grammar, a grammar needs a parser, and that is how this epic started. A handle returned by the
parser cannot address a node the parser did not find.

### 3. Serialization is byte-stable for untouched regions

`serialize` splices mutated node spans back into the **original buffer**. A region the mutation did
not touch is the original bytes — not a faithful re-render of them.

"Re-render faithfully" is an unbounded obligation: it must reproduce every whitespace, alignment
and quoting choice a human made. #4499 is exactly that obligation being missed, and it closes here
without a targeted fix. This is a deliberate **Hyrum's Law** commitment: every byte of an untouched
region is depended on by someone's diff review, and a semantically-equivalent reformat is a real
break.

It also closes a round-trip corruption before it exists: an untouched escaped cell (`\|`) is not
re-escaped, because it is not re-rendered.

### 4. One writer per artifact, sharing its escaping with the reader

For each typed field kind, the escape-or-refuse function is **exported by the reader's module** and
called by the writer. Not a third shared module — that is a second place for the pair to drift,
which is the defect. A parity test per field kind asserts the pair.

A value that cannot be represented in the grammar is **refused** by the writer, with a report. A
writer never emits a document its own reader must reject.

Prose-interpolated table rows in shipped workflow markdown are replaced by a `gsd_run` verb that
appends through the seam, so the escaping is executed once rather than restated in prose.

#### 4a. `accepted ⊇ emittable` — the accept-but-never-emit rule

Each grammar is declared **accepted** (the reader takes it) and, separately, **emittable** (the
writer may produce it). `emittable ⊆ accepted`, asserted. A grammar may be accept-only.

This is **Postel's Law applied at the right level**, and it is worth stating why, because the naive
reading argues the opposite. Postel's own guidance splits by level: *internal system-to-system —
stricter on both ends; user-facing input — more liberal.* GSD's planning artifacts are **both**.
They are written by the tool and hand-edited by humans — the epic's stated constraint is that they
*"stay human-readable and hand-editable; that is the constraint, not the problem."* So the reader is
liberal toward a human's variation (#4793 is a reader being wrong to reject prose a human, or
`discuss-phase` itself, legitimately wrote), the writer is conservative, and **neither is ever
silent**. "Be conservative in what you send" is the uncontroversial half and applies to the writer
without qualification.

### 5. A parse miss is typed, carries its span, and is scoped to the node

`[]` means **none**. An unrecognised shape surfaces `could-not-parse` with the offending span.

**The error lives on the node, not the document.** This is the sharpest constraint in the epic and
the naive reading gets it wrong: making an unrecognised table fail the whole artifact would take
out `phase list`, `init.progress` and every other consumer of the same file. Instead the document
parses, the affected node carries the parse error, a consumer that reads that node gets
`could-not-parse` with the span, and a consumer reading a different node is unaffected.

The document-level `Result<PlanningDoc>` failure is reserved for a document that is not a planning
artifact at all — unreadable, no frontmatter terminator, not the declared kind.

> **This is an interpretation of #4906's criterion, stated rather than assumed.** The epic's
> "Done when" reads *"an unparseable shape surfaces `could-not-parse` with the offending span"* and
> carries no document-or-node qualifier. This ADR reads it **distributively** — per unparseable
> *shape*, not per file — which is what node-scoping delivers. The reading is recorded here
> explicitly because the alternative (document-scoped) is also a faithful reading of the same
> sentence and would produce a materially different Phase 1 and Phase 4: one bad table would fail
> `phase list` and `init.progress` along with `roadmap.analyze`. If the epic intended the
> document-scoped reading, §5 and the Phase 1/4 acceptance criteria are what change.

This is [ADR-1411](1411-resolution-provenance.md)'s "report provenance rather than fall open silently" and [ADR-2143](2143-markdown-table-and-mutation-consolidation.md) §5's no-null-
swallow rule, at document-node granularity; it is the `Evidence` distinction #4631 draws for gates,
applied to documents. #4899's own bug is the strongest argument for it: the evidence was *already
computed* — 26 `missing_phase_details` tokens, built and then discarded — and thrown away on the
way to reporting `phases: []`.

### 6. The ratchet is type-narrowing **plus** lint — not typechecking alone

The epic states: *"the write boundary takes a `PlanningDoc` mutation, not a `string`, so a
reintroduced `content.replace(/…/)` against a planning artifact does not typecheck."*

**The narrowed boundary is adopted. The guarantee, as stated, is not available.**

```ts
fs.writeFileSync(planningPath, content.replace(/(\*\*Plans:\*\*\s*)[^\n]+/i, …));
```

typechecks perfectly. `fs` has never heard of `PlanningDoc`, and no narrowing of *our* boundary
reaches a call that never goes near it. Publishing the epic's sentence unqualified would hand every
later reader a guarantee that one `require('node:fs')` defeats — and a false guarantee is worse
here than none, because it is the thing that stops someone writing the lint.

So enforcement is two mechanisms with stated scopes:

- **Type-narrowing at the seam's write boundary** — accepts a `PlanningDoc` mutation, not a
  `string`. Makes the correct path the easy path and catches every bypass *through the seam*.
- **`local/no-adhoc-markdown-parsing`, extended** — owns the bypass. It is already the mechanism
  [ADR-1372](1372-markdown-sectionizer-seam.md) §2 and [ADR-2143](2143-markdown-table-and-mutation-consolidation.md) §7 both chose, and [ADR-2143](2143-markdown-table-and-mutation-consolidation.md)'s Phase 4 **shipped**: the rule today
  guards `src/**/*.cts`, `tests/**/*.cjs` and `scripts/**/*.cjs`, and already carries
  `tableRegex` and `adhocReplaceMutation` message ids alongside `fenceRegex` and `sectionCollect`.
  This ADR does not ask for that work again.

  **What it does not yet catch is specific, and #4852 is the proof.** `adhocReplaceMutation` keys
  on *"a `.replace()` mutation of a roadmap/state document using a hand-rolled **table or section**
  regex"*. `/(\*\*Plans:\*\*\s*)[^\n]+/i` is neither: it is a **bold-label field** regex. So the
  defect lives in `src/phase.cts` — a file this rule does lint — and `lint:ci` is green. That is a
  behavioural demonstration of the gap, not an inference from reading the rule.

  The extension is therefore one detector, not a new mechanism: a field-shaped `.replace()`
  mutation of a registry-recognised planning artifact, and a raw
  `readFileSync` → `.replace()` → `writeFileSync` triple against one. Paired with an allowlist
  drain (#4446 pattern) for what exists today, deleted per phase rather than renewed.

> **Correction to the epic, recorded deliberately.** #4906 names
> `scripts/lint-planning-artifact-writer-drift.cjs` as *"the drain point; extend it."* That script
> exists, but its own module docblock scopes it as a **registry-completeness** guard: every writer
> of a `.planning/`-**root** file is represented in `isCanonicalPlanningFile`. It states *"No
> ratchet / no baseline"* as a design choice, silently skips any runtime-computed target, and never
> inspects *how* a write is performed. It is a correct guard on a different axis and is left
> untouched. Extending it would have meant teaching a registry checker about regex shapes.

**Stated coverage limit.** A lint over `src/*.cts` cannot see #4736's writer, which is prose in
`gsd-core/workflows/quick.md`. Decision 4's `gsd_run` verb is what brings that surface inside the
fence; the lint does not, and this ADR does not pretend otherwise.

### 7. Every parser ships a positive control per accepted grammar

A parser declares the grammars it accepts (§4a's `accepted` set). A lint asserts one positive-
control fixture per declared grammar; a parser without one fails the build. Modelled on
`scripts/lint-table-schema-drift.cjs`, which already does this for table schemas and is wired into
`lint:ci`.

This is what stops #4837's four continuation shapes and #4900's two heading forms regressing
silently. It is also the guard that would have caught #4900 at authoring time: `locked decisions`
was never a declared synonym, so no control ever existed for it.

Per `CONTRIBUTING.md`'s fixture-provenance rule (#2371), a control may not be derived from the
parser's own writer or docstring examples — and §4a makes that mechanical rather than a matter of
discipline, because the accept-only grammars are by definition ones the writer cannot produce.

### 8. Exactly one implementation of a shared pattern, proven by a drift guard

The phase-heading pattern has one owner. Five copies (#4865) collapse to one, proven by the
existing drift-guard idiom rather than by review attention. Same rule for `/gsd:undo`'s scope
selector (#4661) and `pr-branch`'s `STRUCTURAL_RE` (#4605, #4606): the pattern is a property of the
seam's grammar, not a literal each call site owns.

## Phases

Each phase is one `chore(#4906): … — Phase N` sub-issue + PR, gated on `gsd-test`.
Behaviour-preserving except where a phase names a fixed bug, driven fail-first.

- **Phase 0 — this ADR.** Design lock. Docs-only. Closes [#4910](https://github.com/open-gsd/gsd-core/issues/4910) only; #4906 stays open.
- **Phase 1 — the seam.** `PlanningDoc` parse / node-mutate / byte-stable serialize, the artifact
  registry, and the node-scoped typed parse error (§1, §2, §3, §5). Net-new module; **no call site
  migrated.** Positive controls for every grammar it declares.
- **Phase 2 — field writes (§2, §3).** `src/phase.cts` `**Plans:**` (**fixes #4852**),
  `state.update "Last Activity"` (**fixes #4862**), `frontmatter.set` byte-stability (**fixes
  #4499**). Property test: a mutation to field *k* leaves every other byte identical — the direct
  analog of [ADR-2143](2143-markdown-table-and-mutation-consolidation.md) Phase 2's per-phase byte-identity test.
- **Phase 3 — reader/writer escaping parity (§4, §4a).** Quick Tasks append through the seam
  (**fixes #4736**), `parseDecisions` accept-only grammar (**fixes #4793**), the `accepted ⊇
  emittable` assertion.
- **Phase 4 — empty-vs-error (§5).** `roadmap.analyze` (**fixes #4899**), `adr-parser` (**fixes
  #4900**), `extractPhaseFieldMultiline` (**fixes #4837**).
- **Phase 5 — duplication drain (§8).** One phase-heading pattern (**fixes #4865**); #4661, #4605,
  #4606 onto their single owners.
- **Phase 6 — the ratchet (§6, §7).** Narrowed write boundary; extend
  `local/no-adhoc-markdown-parsing`; allowlist drain; the positive-control lint. Asserts zero
  remaining bespoke planning-artifact writers. **Also ratifies this ADR** to `Accepted` with a
  dated Ratification section, and adds the reciprocal `Subsumed by` back-links to [ADR-1372](1372-markdown-sectionizer-seam.md) and
  [ADR-2143](2143-markdown-table-and-mutation-consolidation.md) — which lifecycle rule 3 begins demanding at exactly that point.

**Ordering constraints.** Phase 1 introduces the primitive every later phase consumes and must
precede all of them. Phase 6 must land **last**: a ratchet whose allowlist still grandfathers every
unmigrated site is a ratchet with nothing to hold. Phases 2–5 are mutually independent and may run
in any order, or in parallel, subject to §9.

## Relationship to the in-flight point-fix PRs

Six of the twelve absorbed issues have open community PRs doing point fixes at their existing call
sites: #4762 (#4736), #4897 (#4837), #4848 (#4661), #4610 (#4605), #4609 (#4606), #4530 (#4499).

This ADR does not dispose of them — that is a maintainer decision about other contributors' open
work. What it locks is the **rule that applies whichever way that decision goes**:

> **A landed point fix becomes a positive control, never a site the migration silently reverts.**
> When Phase N migrates a call site whose behaviour a merged PR already corrected, the migration
> keeps that behaviour and the PR's regression test is carried forward against the seam, unchanged
> where possible. A migration that makes a previously-passing regression test unnecessary must say
> which behaviour replaced it.

Two consequences follow mechanically:

- **Phases 0 and 1 are unblocked.** Neither touches a file any of the six PRs touch; Phase 1 is
  purely additive.
- **Phases 2–5 target exactly those call sites** and must not begin against a moving target. Each
  waits for its overlapping PR to merge or close.

## Consequences

- **Positive.** The class ends where it is generated rather than where it is reported: a field
  write cannot destroy its line, a writer cannot emit what its reader rejects, an unreadable
  document cannot report itself as empty, and a shared pattern has one copy. New verbs inherit
  correctness from the seam instead of re-deriving it — which is what the previous two
  consolidations each demonstrated.
- **Cost.** Seven PRs plus lint infrastructure. Phases 2, 4 and 5 carry High blast radius
  (`cmdPhaseComplete`, the roadmap/ADR read paths, five call sites across three files) and need
  per-consumer `get_impact` due diligence.
- **Risk — the honest one.** Behaviour-preserving migrations regress subtle formatting, and this
  seam's whole value proposition is formatting fidelity. Mitigated by §3's byte-stability property
  test, the fail-first regression per absorbed issue, §7's positive controls, and the per-phase
  `gsd-test` gate. [ADR-2143](2143-markdown-table-and-mutation-consolidation.md)'s own Phase 5 exists because a coverage re-check found a seam its
  Phase 0 had left unowned; `/adr-phase-coverage` runs again at epic closeout for that reason.
- **Risk — naming.** `planning-document` beside `plan-document` (§1). Live until absorption lands.
- **Non-goals.** Repairing the twelve at their existing call sites (the pattern that produced them
  — three times for #4852 alone). Replacing markdown as the storage format; the artifacts stay
  human-readable and hand-editable. Rewriting `markdown-sectionizer` or `markdown-table`.
  Re-litigating [#1639](https://github.com/open-gsd/gsd-core/issues/1639)'s `[^:*]*` discipline as
  policy — this ADR changes *where* a grammar is defined and *how* a miss is reported, not what a
  decision title may contain, though §4a is why #4793 resolves anyway.

## Alternatives considered

1. **Repair the twelve issues at their call sites.** The epic's own non-goal, and the pattern that
   produced them. Rejected — but noted as a live option rather than a hypothetical one, because six
   community PRs are doing precisely this now (§9).
2. **Put the composition layer inside `markdown-sectionizer.cts`.** Rejected: that seam is generic
   markdown structure with no planning-domain knowledge, and `CONTEXT.md` scopes it that way.
   Teaching it what a `**Plans:**` line is inverts the dependency, makes a leaf module know about
   its consumers, and puts an `Accepted` contract at risk for a reason unrelated to markdown
   structure.
3. **Path-string-addressed mutation** (`doc.set('phases.3.plans', v)`). Rejected: a path string is
   a grammar, and a grammar needs a parser.
4. **Re-render the document faithfully instead of splicing** (§3). Rejected: an unbounded fidelity
   obligation, which #4499 is an instance of being missed.
5. **A third shared escaping module** (§4). Rejected: a second place for the reader/writer pair to
   drift.
6. **One document-level `Result` that fails the whole artifact** (§5). Rejected: one bad table
   takes out every unrelated consumer of the same file.
7. **Type-narrowing alone as the ratchet** (§6). Rejected on the merits, with the counter-example
   in-line. This is the epic's stated mechanism and it does not hold.
8. **Extending `lint-planning-artifact-writer-drift.cjs`** (§6). Rejected: correct guard, different
   axis, explicitly ratchet-free by design.

## References

- Epic: [#4906](https://github.com/open-gsd/gsd-core/issues/4906) · Phase 0 sub-issue: [#4910](https://github.com/open-gsd/gsd-core/issues/4910)
- Layers: [ADR-1372](1372-markdown-sectionizer-seam.md) (`markdown-sectionizer`), [ADR-2143](2143-markdown-table-and-mutation-consolidation.md) (`markdown-table`, bounded mutation, fail-loud)
- Fail-loud precedent: [ADR-1411](1411-resolution-provenance.md) — report provenance rather than fall open silently
- Sibling consolidation: [#2121](https://github.com/open-gsd/gsd-core/issues/2121) (`phase-id.cts`)
- Absorbed: [#4736](https://github.com/open-gsd/gsd-core/issues/4736), [#4793](https://github.com/open-gsd/gsd-core/issues/4793), [#4852](https://github.com/open-gsd/gsd-core/issues/4852), [#4862](https://github.com/open-gsd/gsd-core/issues/4862), [#4899](https://github.com/open-gsd/gsd-core/issues/4899), [#4900](https://github.com/open-gsd/gsd-core/issues/4900), [#4837](https://github.com/open-gsd/gsd-core/issues/4837), [#4865](https://github.com/open-gsd/gsd-core/issues/4865), [#4661](https://github.com/open-gsd/gsd-core/issues/4661), [#4605](https://github.com/open-gsd/gsd-core/issues/4605), [#4606](https://github.com/open-gsd/gsd-core/issues/4606), [#4499](https://github.com/open-gsd/gsd-core/issues/4499)
