# ADR-4629: STATE.md write intent beyond frontmatter — bounded, verified writes

- **Status:** Proposed
- **Date:** 2026-09-11
- **Issue:** [#4629](https://github.com/open-gsd/gsd-core/issues/4629) is the scope authority (`epic` +
  `approved-enhancement` + `area: core`); this ADR carries its number, per the ADR-3180/3408/3473 convention.
- **Supersedes:** nothing.
- **Relationship to prior work:** the **fourth** application of ADR-3180's single-owner mechanism, and a
  **successor to ADR-3408** in the way ADR-3473 was — a new ADR carrying its own epic number that extends
  the mechanism to a surface the prior one scoped out, not an amendment to a closed epic. ADR-3180 owned
  read-side derivations; ADR-3408 owned the STATE.md **frontmatter** write path; ADR-3473 owned
  parsing/enumeration/return contracts and added "retire the guard once the seam makes it redundant." This
  ADR owns **the STATE.md write path past frontmatter** — body/section writes, prose-derived intent,
  cross-field invariants, and the completion-ratio **composition** — and adds the one property none of the
  four cover: **bounded mutation**. It explicitly **reverses ADR-1769 Decision 2's rejected option (iii)**.
  On the aggregate concern it does **not** supersede ADR-3180 §7.6 (which owns the rounding kernel and the
  scope discriminator); it **adds the composition rule §7.6 never wrote down** and inherits §7.6's guard.

Symbol names are the durable anchors; line references are approximate ranges and drift.

## Context

Nine `confirmed-bug` issues, all closed as duplicates into #4629, share one signature: **a STATE.md write
persists something other than what the verb meant, and the success payload does not show it.** ADR-3408 §5
tabled this shape one layer down (frontmatter). The nine are the residue ADR-1769 Decision 2 left when it
chose 10 named transitions over all 16 writers — this ADR is the record that the rejection was wrong for
that residue, so an implementer reading ADR-1769 (and not this ADR) does not re-derive the narrower scope.

Prior art that already owns adjacent surface, which #4629's body did not cite:

| ADR | Decided | Status |
|---|---|---|
| ADR-1769 | intent-based transitions over scattered RMW callbacks; `transitionCore(content, intent, deps)` | Accepted (10 transitions migrated) |
| ADR-1817 | STATE.md rebuild derivability contract | Accepted |
| ADR-3180 §7.6 | completion-ratio **rounding kernel** + scope discriminator (rules 1–4) | Accepted |
| ADR-3408 | one write seam (`readModifyWriteStateMd`, `src/state.cts:4465`); report from `postFm` (§8.4, `reconcileReportedFields`) — **frontmatter only** | Accepted; phases #3468–#3471 closed |
| ADR-3473 | enforcement by construction; retire the guard once the seam makes it redundant (§8.6) | Accepted; phases landed |

## Decisions

**1. Extend the intent surface to the residual writers (the ADR-1769 D2 reversal).** Residual
`readModifyWriteStateMd` callers on the opaque `transformFn: (content) => string` contract migrate to a
declared-intent path. The interface-balloon cost ADR-1769 weighed is now outweighed by measured defects.

**2. `StateWriteIntent` EXTENDS `StateTransaction`; not a parallel type.** `src/state-transition.cts:432`
already carries a frozen transaction (`snapshot`, `bodyDeltas`, `resync`, `explicitProgressField`,
`deriveProgressKeys`). Body/section intent and required-vs-best-effort assertions extend that type.

**3. Bounded mutation is a first-class verified property, checked against a DECLARED intent scope.** #4551
and #4419 are collateral-damage defects: the intended field/section changed; damage is elsewhere. Only a
snapshot → apply → diff asserting the write stayed within its declared scope catches them (#4535's protocol).
A writer declares its scope: most declare a narrow one (named fields/sections). A writer that legitimately
rewrites broadly declares a **broad-scope intent** and is checked against *that* — it is audited, not
exempted. `milestoneSwitch` (a `kind:'open'` transition that rewrites the whole frontmatter by contract) is
the worked case: it declares a whole-frontmatter scope, so bounded mutation still verifies its write matches
its stated intent. The two `kind:'rebuild'` writeStateMd callers (`cmdStateSync`, `REGENERATE_STATE`) are the
maximal case — unbounded by contract (ADR-3408 §8.3), and §8.3 says so rather than implying the type exempts
more than the two writers it names.

**4. Report scope extends the measured-delta contract to body/section — it does not rebuild it.** ADR-3408
§8.4 computes `updated`/`failed` from `postFm` after preservation via `reconcileReportedFields` (seven
commands), for frontmatter. This extends measured-delta reporting to declared body/section edits through the
same helper.

**5. Enforcement by construction — no re-introduced ratchet; the scan surface is declared.** A seeded
`local/no-adhoc-state-write` allowlist is rejected (Alternatives). Enforcement rides the type system
(`writeStateMd` requiring a `StateTransaction`) plus the existing terminal Axis-2 guard
(`findRawStateWrites` / `targetsStatePath` / `RAW_WRITE_CALL_START_RE`, `scripts/lint-state-write-path-drift.cjs:606,564`),
extended. Its scan surface is declared (§ Scan surface).

**6. The completion-ratio composition + the write-side aggregates get an owner — scoped, not wholesale.**
`progress.*` is NOT claimed wholesale: ADR-3180 §7.6 already owns the rounding kernel and scope discriminator,
and `scripts/lint-completion-ratio-drift.cjs` already guards re-derivation. This ADR owns only (a) the
**composition** §7.6 never stated (§8.5 below), inheriting §7.6's guard, and (b) the **write-side aggregates**
`total_plans` (#4314) and `completed_phases` (#4535) — which need nothing beyond the seam: bounded mutation
and measured-`updated[]` already catch them.

## §8 The behavior contract — THIS SECTION IS THE SOURCE OF TRUTH

- Where this section and the code disagree, the code is the defect.
- A behavior not stated here is **not decided** — recorded as an open question with a forcing function,
  never resolved silently inside an implementation PR.
- **Amending a rule here is an amendment to this ADR**, via a PR editing this section + the Amendments log.
- Each rule carries a **Status**: *Enforced* or *Required — Phase N* (equally binding).

**§8.1 Intent declaration — *Required — Phase 2***
- **Owner.** `StateWriteIntent` extending `StateTransaction` (`src/state-transition.cts`).
- **Rule.** No residual `readModifyWriteStateMd` caller supplies an anonymous `(content) => string`; each
  declares field/section assertions marked required vs best-effort, and its mutation scope (narrow or broad).

**§8.2 Verified post-state (achieved == intended) — *Required — Phase 2***
- **Rule.** Every **required** assertion is verified against the re-read file before success; a missed
  required assertion is a loud failure, never rc=0. `updated[]` for body/section writes is the measured disk
  delta via the extended `reconcileReportedFields`.

**§8.3 Bounded mutation — *Required — Phase 2***
- **Rule.** A write changes nothing outside its **declared** scope; a change beyond it is a loud failure. A
  broad-scope writer (e.g. `milestoneSwitch`, whole frontmatter) is checked against its broad declared scope,
  not exempted. The two `kind:'rebuild'` writeStateMd callers (`cmdStateSync`, `REGENERATE_STATE`) are the
  maximal, unbounded case by contract; the typed `StateTransactionKind` names those two and no more.
- **Failure signal.** A write whose disk delta exceeds its declared scope.

**§8.4 Report bucket for best-effort assertions — *Open question, Required — Phase 3***
- **Question (undecided; the forcing function).** §8.1 introduces required-vs-best-effort assertions; §8.2
  states only what happens to *required* ones. A best-effort section assertion that no-ops — does it appear
  in `failed[]`, or is it silently absent? This is the ADR-3408 §8.4 "not found vs found-then-restored"
  bucket question recurring for body/section writes. It is **decided in Phase 3 and recorded as an amendment
  here** — not resolved silently in a PR.

**§8.5 Completion-ratio composition — *Required — Phase N***
- **Question.** How do plan-level and phase-level completion compose into one reported milestone percentage?
- **Owner.** The composition entry point — `computeProgressPercent` (`src/state-document.cts`) — under
  ADR-3180 §7.6's owner. §7.6 rules 1–4 remain in force and are not restated; this adds the composition §7.6
  does not state.
- **Rule.** A reported milestone percentage satisfies all three:
  - **(a) No false completion from partial scope.** It MUST NOT report 100 while any ROADMAP-declared phase
    of the milestone is unrealized or incomplete. A declared phase holding no plan files contributes **0** to
    the numerator, never a vacuous 1. *(This is the guarantee `min()` served; §7.6 rule 2 covers only the
    empty-denominator case.)*
  - **(b) Monotone under completing work.** Holding the declared phase set fixed, the reported percentage is
    non-decreasing as work completes; growth of a plan denominator inside an already-counted phase MUST NOT
    reduce credit already earned. **A genuine increase in declared scope — a new phase added to ROADMAP — MAY
    lower the percentage; that is honest reporting, not a regression.**
  - **(c) Plan-level resolution inside the in-flight phase.** Completing a plan in the current phase MUST move
    the reported percentage.
- **Note.** (a) and (c) are **jointly unsatisfiable by `min(planFraction, phaseFraction)`** — once
  `planFraction` exceeds `phaseFraction` the output pins for the rest of the phase (#4210 measured `percent`
  constant while plans went 26/39 → 39/39). The composition must **change**, not the cap be tuned.
- **Failure signal.** (a) is a plausible wrong value (§5 family shape); (b)/(c) are silent (every path exits
  0). Pinned by literal-output tests, not a guard scan.
- **Pinned control (literals, per ADR-3408 Amendment 1's C2 precedent).**
  `computeProgressPercent(11, 11, 1, 3, 'complete') === 33` — phase 1's plans all complete, phases 2–3
  declared with no plan files (#4210 case C, the direct test of (a)). Reads 33 today; MUST still read 33
  after any composition change.

## Scan surface (declared — ADR-3180 Decision 4(d))

Every **authored** surface that can express the derivation, never the emitted output: `src/**/*.cts`, plus
the prompt layer `gsd-core/workflows`, `commands`, `agents`, `skills` (which shell out to `state patch` and
post-process). `gsd-core/bin/**` is emitted from `src/` — scanning it double-reports every `src/` finding and
inflates the "N found by the guard" census, so it is **excluded**.

## Guard roster

| Concern | Owner | Guard | Scan surface | Status |
|---|---|---|---|---|
| No raw STATE.md write outside the seam | `writeStateMd` requires `StateTransaction` (type) | `findRawStateWrites` (Axis 2, terminal) `lint-state-write-path-drift.cjs:606,564` | authored (above) | Enforced (extended here) |
| Composition not re-assembled | `syncAndPreserveStateMd` | `findCompositionBypasses` (terminal, #3871) | `src/**` | Enforced |
| Completion-ratio re-derivation | ADR-3180 §7.6 kernel/discriminator | `lint-completion-ratio-drift.cjs` (**inherited**; §7.6 rules 1–2) | `src/**` | Enforced |
| Bounded mutation (declared scope) | verifying executor | positive-control test (drives it red) | n/a (test) | Required — Phase 2 |
| §8.5 composition (a)/(b)/(c) | `computeProgressPercent` | literal-output tests (pinned control above) | n/a (test) | Required — Phase N |

## Migration order (guard/type first; phased; blast radius CRITICAL)

`get_impact` rated `readModifyWriteStateMd` CRITICAL. Per ADR-3408 §6: (1) extend the terminal Axis-2 guard +
`StateTransaction`/`StateWriteIntent` type surface (no behavior change); (2) the bounded-mutation verify with
its positive control; (3) migrate residual writers in batches, each with its failing-first regression;
(4) the §8.5 composition, pinned by the literal control. Sequential — each batch sits inside one CRITICAL
blast radius.

## Consequences

- **Positive.** A verb cannot report a write it did not achieve, nor silently damage a region outside its
  declared scope; broad-scope writers (`milestoneSwitch`) become audited rather than unchecked; the reported
  milestone percentage stops lying (§8.5). The nine defects lose their home in one epic.
- **Cost.** The declared-intent surface is wider than the opaque transform; residual writers each declare an
  intent scope. This is ADR-1769 D2's interface-balloon cost, now paid **deliberately**.
- **Residual risk.** The two `kind:'rebuild'` writers remain unbounded by contract (§8.3 states it). §8.4's
  best-effort bucket is undecided until Phase 3.

## Software laws applied (via `/skills-from-the-artificer`)

- **Greenspun's Tenth Rule** — *moved §8.3's shape.* Bounded mutation rides declared intent scope + the
  closed, typed `StateTransactionKind`, not an open per-write predicate or an allowlist.
- **Postel's Law** — *moved where the verify lives.* Bounded mutation is the strict-internal boundary
  (a verb is strict about what it writes), the same boundary ADR-3408 Decision 2 drew, enforced at the seam.
- **Hyrum's Law** — *moved the migration contract.* Residual-writer migration changes observable Tier-2
  output (`updated[]`; verbs' payloads callers and the verifier read); each migration PR discloses the delta.
- **Gall's Law** — *moved the migration order.* Sequenced phases (guard/type → verify → batched migration →
  composition), like ADR-3408's five, not a big-bang rewrite across the CRITICAL blast radius.
- **Goodhart's Law** — *moved the guard roster.* "0 raw-write bypasses" is a lagging metric; the roster pairs
  it with the declared authored-only scan surface and a positive control, never the zero alone (ADR-3408 §5).

## Governance

The nine defects are closed as duplicates, so this ADR + its children are the only record. File the children
as tracked `approved-enhancement` issues (an approved epic does not approve its children), each naming the
absorbed defect(s) it fixes with a failing-first regression as its evidence column. The epic stays open until
the final phase merges.

## Alternatives rejected

- **Amend ADR-3408.** Closed epic; §8 owners all frontmatter; `CONTRIBUTING.md` requires one issue = one
  ADR-or-PRD = one PR; ADR-3473 set the successor-not-amendment precedent.
- **Split `progress.*` into its own epic.** Rejected — splitting at a new granularity is the same move
  ADR-1769 D2 made, and it lets #4629 close with #4210/#4314 alive elsewhere, so "Done when" stops meaning the
  defect class is gone. The ownership collision that motivated it resolves by scoping Decision 6 (§8.5), not
  by splitting.
- **Seeded-then-drained `local/no-adhoc-state-write` ratchet.** Retired machinery (ADR-3473 §8.6, #3871) and a
  measured-and-removed detector (ADR-3408 Amendment 1: `stateReplaceField` co-occurrence, 29 FP:1 TP).
- **A parallel `StateWriteIntent` type.** Two owners for one concept — the defect class this epic closes.
- **Exempting whole-document writers by kind.** Leaves `milestoneSwitch` (a `kind:'open'` transition)
  unchecked; a broad-scope declared intent audits it instead.

## Non-goals

- Re-opening markdown structure / table / phase-id parsing (#1372, #2143, #2121 own those).
- Changing the STATE.md template format or any user-facing field name.
- Removing the `min()` cap without preserving the requirement it serves — §8.5 replaces the composition while
  keeping guarantee (a).
- Superseding ADR-3180 §7.6 — this inherits it and adds the composition rule it never stated.

## Cross-references

ADR-1769 (intent transitions — this ADR reverses its Decision 2 (iii)); ADR-1817 (rebuild derivability);
ADR-3180 §7.6 (rounding kernel + scope discriminator, inherited by §8.5); ADR-3408 §8.3/§8.4 (the frontmatter
write seam + report contract this extends); ADR-3473 §8.6 (successor precedent + the retired ratchet).

## Amendments

*(none yet — stub per convention; amendments to §8 land here.)*

## Citation notes (symbol anchors, for the child issues)

- #4551: `src/state.cts:1711`, scoped to the Blockers `sectionSpan.body` slice — unanchored **within** the
  section, not the whole body. A "whole body" test is a false premise.
- #4314: `plannedPhaseCore` (`src/state-transition.cts:~2193–2290`); the `total_plans` write is inside it.
  Cite the symbol, not the line.
- Caller counts are method-dependent (~9–11 `transitionCore` vs ~16–18 `readModifyWriteStateMd`); the
  load-bearing fact is the gap = the residue.
