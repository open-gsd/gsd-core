# Prohibition-Probe — Spec-Completeness Must-NOT Reference

Shared reference for the spec/requirements phase. Companion to
`@~/.claude/gsd-core/references/edge-probe.md`: `edge-probe` reaches the
**data/behavior-shape axis** (boundaries, adjacency, encoding, ordering) — the things a
feature must *do*. This reference reaches the orthogonal **must-NOT axis** (product, values,
safety, ethics) — the things a feature must *never silently become*. The edge-probe caught
0/8 of these in controlled testing because it is the wrong instrument: a shape taxonomy
cannot surface "the reminder must not shame the user." Walk each requirement through the
two-stage recall→precision protocol below and resolve each surfaced prohibition to exactly
one state.

This doc is written in generic `requirements → checks → verifier` terms with no
tool-specific vocabulary, so it is portable: copy it into any spec/requirements process.
A short mapping table at the end binds it to common host structures.

## Why front-of-pipeline

A goal-backward verifier only checks assertions that exist; an assertion only exists for a
requirement that was written down. The class of constraint this probe targets — the
*"must-NOT"* the author assumed but never wrote — is invisible to the verifier in exactly
the same way an omitted edge is, but with a sharper failure mode: a `✅ done` that means
"the code matches the words in the spec" can still ship a feature that does what the author
explicitly would *not* want. The manipulative-streak reminder, the loan model that proxies
on zip code, the audit log that stores raw SSN — each one passes a literal spec while
violating the intent. The fix is not a better verifier; it is **spec completeness**: surface
the omitted prohibition into an explicit, checkable acceptance criterion *before* any code
exists, after which the verifier reliably enforces it.

The technique is adversarial elicitation, not deterministic computation. Unlike the edge
taxonomy (a closed eight categories a classifier can apply), the recall stage is inherently
model-driven: it asks an open question and reads prose. There is **no compiled
`prohibition-probe.cjs` engine** — the recall stage is an LLM prose pass, and only the
schema/projection layer is real code (ADR-550 Decision 7b). Building a deterministic
recall adapter would be the scope-creep the maintainer flags.

## Inputs

A list of requirements, each a `{ id, text }` record where `text` is a testable statement.
There is no shape override and no taxonomy classifier — the recall stage reads the prose
directly and the precision stage filters its raw output. The probe runs **after** the
edge-probe in the spec phase, over the same requirement list.

## Two-stage protocol (recall → precision)

The probe is a two-pass pipeline per requirement. Stage 1 maximizes recall (cast wide);
Stage 2 restores precision (drop the noise). Running them in this order — wide then narrow —
is what keeps the surfaced list both complete and short.

**Stage 1 — Recall (adversarial probe).** Ask the single adversarial question of each
requirement:

> *What could this feature silently become that the author would NOT want, but the spec
> does not forbid?*

This question is model-robust (17/17 holistic surfacing including smaller models in the N18
experiment). It deliberately over-produces: ~10 raw candidates per requirement, including
routine engineering items. That over-production is intentional — recall first.

**Stage 2 — Precision (one-pass classifier).** Filter the raw Stage-1 list in a single pass.
The rule is a drop/keep split:

- **DROP routine-engineering items** — anything that is a normal correctness or hygiene
  concern rather than an intent constraint: "must not mutate its input", "must not throw on
  empty list", "must return a primitive not an object", "must not leak a file handle". These
  belong to the edge-probe or to ordinary code review, not here.
- **KEEP values / safety / ethics items** — anything that, if violated, makes the feature do
  something the author would object to on product, fairness, privacy, transparency, or
  safety grounds: "must not use shaming framing", "must not proxy on protected attributes",
  "must not store raw PII in plaintext".

This collapses the raw ~10 to ~2–3 genuine prohibitions (GT 5/5, 0 false positives on the
N18 eight-spec battery). A requirement that yields zero kept prohibitions emits an empty
list — that is the correct precision outcome for a pure utility, not a failure.

## Canon-referral (do not mint canon items)

Some kept candidates are not bespoke at all — they are **canon** security/compliance
constraints that a dedicated tool already owns. Do NOT mint a prohibition for them. Instead
emit a one-line breadcrumb and stop:

- OWASP / prototype-pollution / path-traversal / injection → breadcrumb to `/gsd:secure-phase`
  and `eslint` (security plugins), not a minted prohibition.
- GDPR / data-retention / consent → breadcrumb to `/gsd:secure-phase`.
- Generic fairness/bias canon → breadcrumb to `/gsd:secure-phase`.

The breadcrumb reads like: *"prototype-pollution is canon — covered by /gsd:secure-phase +
eslint; not minted here."* This keeps the surfaced list to the ~2–3 **bespoke** items that
no other tool would catch — the manipulative-framing prohibition, the product-specific
fairness constraint — which is the whole value of the probe. Minting canon items both
duplicates other tooling and drowns the bespoke signal (ADR-550 Decision 6).

## Resolution states

Each surfaced prohibition carries two orthogonal axes — a resolution **lifecycle** and, when
resolved, a **verification** tier (ADR-550 Decision 7, the shared probe-core model; the
lifecycle is identical to the edge-probe, the verification tiers differ):

- **status** — `resolved | dismissed | unresolved` (IDENTICAL to the edge-probe):
  - **resolved** — the prohibition is addressed; *how* it is addressed is the verification tier.
  - **dismissed** — not a genuine prohibition for this feature, accompanied by a required,
    non-empty reason string. "N/A — this utility has no user-facing surface, no values
    constraint applies" is valid; silence is not. The reason string is the audit trail.
  - **unresolved** — carried forward and flagged; the author chose not to resolve it yet.
- **verification** (only when `status` is `resolved`; `null` otherwise) — `test | judgment`
  (this REPLACES the edge-probe's `explicit | backstop`):
  - **test** — the prohibition can be mechanically checked (a negative test, a lint rule, an
    assertion that the audit log contains no raw SSN). A checkable assertion exists.
  - **judgment** — the prohibition is real but cannot be reduced to a mechanical test (a
    human/LLM judgment that the framing is not manipulative). It records intent and routes
    to a judgment-based review rather than a green/red test.

  At verify time these tiers are routed differently (ADR-550 D4):
  - A **test**-tier prohibition is enforced + hard-gates via the deterministic
    `check prohibition-enforcement` sub-command (#1259 + #1279, ADR-550 D5d): it locates the wired
    mechanical check (a `node --test` negative test OR a lint/AST rule run as
    `eslint --format json` and filtered by `ruleId`), **machine-proves it is fail-first** against a
    known violation, runs it for a genuine **non-vacuous** pass, and emits the
    `dispositionForProhibition()` verdict. A passing, fail-first-proven wired check disposes **green**
    (satisfiable → can reach `passed`); a missing, un-provable, or genuinely-non-passing check
    **hard-gates** (flagged, never green → `gaps_found`) in BOTH interactive and autonomous modes —
    never a silent pass.

    **Machine-proven fail-first (#1279).** `failFirst` is now **machine-proven, not caller-attested**:
    before a clean pass greens, the producer independently runs the wired check against a KNOWN
    VIOLATION and confirms it goes RED (any other outcome — passes-on-violation, can't-prove, throws,
    times out, no violation source — hard-gates). The violation is sourced from a descriptor field:
    - **`violationFixture`** — an author-supplied path to a KNOWN-BAD subject. For `lint-rule`: a file
      whose content violates `rule`; the prover lints it and requires the rule id to appear in the
      JSON report (the rule must have teeth). For `node-test`: a subject the negative test exercises,
      expected to drive it RED.
    - **`GSD_PROHIB_SUBJECT`** — the node-test subject-injection convention: the producer spawns the
      negative test with `GSD_PROHIB_SUBJECT=<violationFixture>` in the child env; the test reads that
      env var to locate its subject-under-test and is expected to go red against the violating subject.
    - **lint-fixture authoring gotcha** — the violating fixture must actually trigger the rule. For the
      `local/no-source-grep` dogfood anchor specifically, use the `path.join('lib','foo.cjs')` form
      (a standalone quoted dir token); a single string literal like `'src/x.cjs'` does NOT trigger the
      rule, so a mis-authored fixture makes the prover report "not proven" and hard-gate a legitimately
      wired check. (`no-source-grep` has no filename guard — any `.cjs` with the pattern fires.)

    > **PROPOSED, renamable conventions (zero live consumers).** Both `GSD_PROHIB_SUBJECT` and
    > `violationFixture` are net-new surface with **no live in-tree consumer yet** — there is no
    > in-tree `node --test` prohibition; node-test fail-first proof is exercised only by SYNTHETIC
    > temp fixtures in the tests, and the real dogfood remains the LINT-rule `local/no-source-grep`.
    > They are therefore **open to maintainer adjustment (rename, or replacing the env var with an
    > argv) at PR review with zero migration cost.** See the ADR-550 2026-06-15 addendum (#1279).
  - A **judgment**-tier prohibition routes to a never-silent / never-hard-halt soft gate
    (autonomous emits an `unverified-prohibition — human review recommended` flag).

Splitting these axes keeps the lifecycle enum free of a verification fact and lets the
prohibition adapter declare `test | judgment` without forking the shared lifecycle enum that
the edge-probe's `explicit | backstop` also uses.

## Optional wired-check descriptor (deterministic locate + machine-proof, #1278 + #1346)

A `resolved`/`test`-tier prohibition MAY carry an **optional `check` descriptor** that names
the wired mechanical check, so verify-phase locates it deterministically instead of inventing
`{kind, target, rule}` each run. The descriptor is captured at spec-phase (soft / optional —
the author wires it when the negative test or lint rule already exists) and is represented as
**four flat scalar keys** on the `must_haves.prohibitions` item — never a nested `check: {}`
object:

- `check_kind` — `node-test` | `lint-rule` (which producer mechanism runs the check).
- `check_target` — the test file (`node-test`) or the file the rule runs against (`lint-rule`).
- `check_rule` — the `ruleId` to filter on, **lint-rule only** (absent for `node-test`).
- `check_violation_fixture` — path to a KNOWN-BAD subject the #1279 prover runs the check against to
  machine-prove fail-first (rides BOTH kinds; for `node-test` it is injected via `GSD_PROHIB_SUBJECT`).

The flat-scalar shape is load-bearing: the shared `parseMustHavesBlock` is a flat parser and a
nested object would flatten/mangle the round-trip (ADR-550 2026-06-15 addendum; #644 "no parser
rewrite" precedent). `projectProhibitions` emits these keys **only for a well-formed descriptor**
(valid `check_kind` + non-empty `check_target`; `check_rule` only on the lint-rule path;
`check_violation_fixture` only when non-empty), and verify-phase reads them back via
`descriptorFromProjection` into the `CheckDescriptor` handed to `check prohibition-enforcement`. This
closes **both** the locate (#1278) and the machine-proof-fixture (#1346) halves with **zero manual
descriptor authoring**: a prohibition authored with all four scalars greens end-to-end through the
projection alone.

**Fail-closed + backward-compat.** A partial descriptor (`lint-rule` missing `check_rule`), an
unknown `check_kind`, an **absent** descriptor, OR a descriptor with **no `check_violation_fixture`**
falls through to the producer's fail-closed paths (`located: false`, or located-but-unprovable) —
never a silent green. A prohibition with no descriptor parses and disposes byte-identically to today.
`failFirst` is **not** sourced from the descriptor and is **demoted** (machine-proven fail-first
DELIVERED in #1279 — no path greens on attestation alone, FF-08); the `dispositionForProhibition`
policy is unchanged. Residual (tracked **#1346**): the node-test proof confirms the fixture exists and
the check goes RED, but cannot generically prove the red was *caused by* the subject's content.

## Output schema

The probe emits, per kept prohibition, an item of the form:

```
{ requirement_id, category, status, verification, resolution, reason, statement,
  check_kind?, check_target?, check_rule? }
```

where `statement` is the must-NOT sentence and `category` is the values/safety/ethics class
(`values`, `fairness`, `privacy`, `transparency`, `safety`, …). The optional **flat-scalar
`check_*` descriptor** (#1278) is present only on a resolved `test`-tier prohibition carrying a
wired check: `check_kind` (`node-test` | `lint-rule`), `check_target`, and `check_rule` (lint-rule
only). `projectProhibitions` emits these into `must_haves.prohibitions` and `descriptorFromProjection`
reads them back into a `{ kind, target, rule? }` `CheckDescriptor`; they are flat scalars (never a
nested `check:{}` object) so they round-trip through the unchanged `parseMustHavesBlock`. Plus a
coverage summary:

```
coverage: { applicable, resolved, unresolved, byVerification: { test, judgment } }
```

`applicable` is the number of kept prohibitions, `resolved` = closed (`resolved` +
`dismissed`) status items, `unresolved` is the remainder, and `byVerification` breaks the
`resolved`-status items down by tier (`{ test, judgment }`). This JSON is the stable contract
both the reference implementation and any third-party port emit.

## Generic mapping (requirements → checks → verifier)

| Host structure | "requirement" | a `resolved`/`test` prohibition becomes | a `resolved`/`judgment` prohibition becomes |
|----------------|---------------|------------------------------------------|----------------------------------------------|
| GSD SPEC | a SPEC Requirement | a SPEC acceptance criterion (marked prohibition) that `plan-phase` lifts into `must_haves.prohibitions` | a `must_haves.prohibitions` item routed to judgment review |
| Gherkin feature | a Scenario | a negative `Then` assertion / tagged negative scenario | a tagged scenario routed to manual review |
| OpenAPI operation | an operation | a contract test asserting the forbidden behavior never occurs | a documented constraint flagged for review |
| Docstring contract | a documented behavior | a negative assertion in the contract test | a documented must-NOT for reviewers |

The portable invariant: a `resolved`/`test` prohibition produces **a checkable negative the
verifier iterates over** (GSD: a `must_haves.prohibitions` item with a test); a
`resolved`/`judgment` prohibition produces a recorded intent routed to judgment review. An
`unresolved` prohibition is an explicit assumption the downstream planner must surface, not
silently drop.

## Worked example (streak-reminder)

A single requirement to send a daily habit reminder. The edge-probe sees a `stateful`
requirement and asks about idempotency; the prohibition-probe asks the adversarial question
and surfaces what the reminder must never *become*. Stage 1 over-produces ("must not spam",
"must not throw on a deleted habit", "must not use shaming framing"); Stage 2 drops the
routine-engineering items and keeps the one genuine values prohibition:

```json prohibition-probe:01-streak-reminder/expected.json
{
  "items": [
    {
      "requirement_id": "R1",
      "category": "values",
      "status": "resolved",
      "verification": "judgment",
      "resolution": null,
      "reason": null,
      "statement": "MUST NOT use shaming, guilt, or loss-aversion streak framing (e.g. \"Don't lose your streak!\") — the reminder must encourage without penalty framing"
    }
  ],
  "coverage": { "applicable": 1, "resolved": 1, "unresolved": 0, "byVerification": { "test": 0, "judgment": 1 } }
}
```

The kept prohibition is `judgment`-tier: "manipulative framing" cannot be reduced to a
mechanical test, so it records intent and routes to judgment review — but it is now an
explicit acceptance criterion the spec must clear, not an unwritten assumption.

## Worked example (clean-utility)

A pure utility requirement — "deduplicate a list of integers" — has no user-facing surface,
no values/safety/ethics dimension. Stage 1 still over-produces ("must not mutate the input",
"must not change order"), but every candidate is routine engineering that Stage 2 drops (and
the edge-probe already owns). The correct precision outcome is an empty prohibition list — a
zero, not a false positive:

```json prohibition-probe:02-clean-utility/expected.json
{
  "items": [],
  "coverage": { "applicable": 0, "resolved": 0, "unresolved": 0, "byVerification": { "test": 0, "judgment": 0 } }
}
```

This is the precision discipline that keeps the probe from crying wolf: a utility with no
intent surface produces zero prohibitions, so a non-empty list always carries signal.

## Worked example (multi-prohibition)

A loan-decision requirement is the high-stakes case: it surfaces several distinct
prohibitions across categories. Stage 1 produces a long list including canon items
(prototype-pollution, generic GDPR retention) that canon-referral breadcrumbs out; Stage 2
keeps the three bespoke values/safety items — a `fairness` constraint, a `privacy` constraint
(`test`-tier, mechanically checkable against the audit log), and a `transparency` constraint:

```json prohibition-probe:03-multi-prohibition/expected.json
{
  "items": [
    {
      "requirement_id": "R1",
      "category": "fairness",
      "status": "resolved",
      "verification": "judgment",
      "resolution": null,
      "reason": null,
      "statement": "MUST NOT use protected attributes (race, gender, age, national origin) or their proxies (zip code, name) in the loan decision or rate"
    },
    {
      "requirement_id": "R1",
      "category": "privacy",
      "status": "resolved",
      "verification": "test",
      "resolution": null,
      "reason": null,
      "statement": "MUST NOT store raw PII / financial secrets (SSN, full account or card numbers) in plaintext in the audit log"
    },
    {
      "requirement_id": "R1",
      "category": "transparency",
      "status": "resolved",
      "verification": "judgment",
      "resolution": null,
      "reason": null,
      "statement": "MUST NOT mislead or omit the true rate/APR/terms in the explanation; an adverse decision must state the real principal reason (adverse-action)"
    }
  ],
  "coverage": { "applicable": 3, "resolved": 3, "unresolved": 0, "byVerification": { "test": 1, "judgment": 2 } }
}
```

The `privacy` row is `test`-tier — "no raw SSN in the audit log" is a mechanical assertion —
while `fairness` and `transparency` are `judgment`-tier. The byVerification rollup
`{ test: 1, judgment: 2 }` is the count-preserved breakdown of the three `resolved`-status
items. Each worked-example block above is kept byte-for-byte (parsed-JSON) identical to its
fixture under `gsd-core/references/prohibition-probe-fixtures/` by
`tests/prohibition-probe.docs-fixtures.test.cjs`, so the doc and the reference data cannot
silently drift.
