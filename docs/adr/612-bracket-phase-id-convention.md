# ADR 612: Bracket phase-ID convention

- **Status:** Proposed (precondition — must merge before PRs 1–6)
- **Issue:** open-gsd/gsd-core#612
- **Lands at:** `docs/adr/612-bracket-phase-id-convention.md`
- **Architecture:** redux TypeScript (`src/*.cts`)
- **Supersedes:** the M-NN "milestone-prefixed" convention (#565 — published only to `1.3.0-rc.1`/`next`, never to `latest`); bracket *completes* the #39 design that #565 partially implemented. See §(2).

## Context

GSD phase identifiers must encode up to **three numeric dimensions** — milestone, phase (with optional subphase decomposition), and plan — across human display, on-disk directory names, ROADMAP headings, and plan/summary filenames. The same string is read by multiple subsystems (CLI args, migrator, validator, progress renderer) and, increasingly, by multiple coordinating LLM sessions across repos (the motivating use case for #39/#565).

The existing `milestone-prefixed` ("M-NN") convention (#565) encodes the milestone by **hyphen-joining it to the phase** (`2-01` = milestone 2, phase 01) and the plan by **another hyphen** (`-01`). It has **two separator types (hyphen, dot) for three dimensions**, so the hyphen is overloaded — it means *milestone↔phase* in one position and *phase↔plan* in another. Once both a subphase and a plan exist, the token is ambiguous (proven below).

**Lineage.** Issue **#39** (filed by the contributor) proposed milestone-encoding phase IDs. The maintainer implemented that idea as M-NN in **#565** (`feat(#39)`, authored by the maintainer, merged 2026-05-31). M-NN is a *partial* resolution — it lifts the milestone but leaves the hyphen overloaded, so it does not resolve the convention once subphases and plans coexist. This ADR **completes #39's intent** with the bracket grammar. Crucially, M-NN has only ever been published to **`1.3.0-rc.1` on the `next` pre-release channel** (`latest` is `1.2.0`, which predates #565) — it has **no stable adopters**, which is what makes a clean supersede possible (§2).

This ADR proposes a **bracket convention** that lifts the milestone out of the phase token into a `[PROJECT.MM]` prefix, giving each dimension a dedicated separator and making every token uniquely parseable.

## Decision

Adopt the bracket grammar:

```
[GSD.02] 05.03-01
 │   │   │  │   └── plan       01   one hyphen — only ever the plan (filename only)
 │   │   │  └────── subphase   03   dot — optional decomposition
 │   │   └───────── phase      05   zero-padded integer
 │   └───────────── milestone  02   dot-joined INTO the bracket
 └───────────────── project    GSD  uppercase alpha [A-Z]{1,6}
```

Three dimensions, two separators, **zero reuse**: dots are always phase-levels, the single hyphen is always the plan, the milestone is always in the bracket/dir-prefix.

| Surface | Form |
|---|---|
| Display | `[GSD.02] 05.03-01` |
| On-disk dir (Option B, no brackets) | `GSD.02-05.03-some-feature/` |
| Plan/Summary file | `05.03-01-PLAN.md` (milestone in dir prefix, NOT filename) |
| ROADMAP phase heading | `### [GSD.02] 05.03: Name` |
| ROADMAP milestone heading | `## [GSD.02] Foundation` (name, no number) |

**Milestone source (READING-B):** the milestone comes from the `[PROJECT.MM]` bracket / dir prefix, **never** from the phase-token leading integer. This is a deliberate fix to redux `core.cts:693` `getMilestoneFromPhaseId`, which currently reads the leading int (READING-A).

**Heading discriminator:** phase heading = bracket followed by a digit-then-colon (`[GSD.02] 05:`); milestone heading = bracket followed by a name (`[GSD.02] Foundation`). A milestone name beginning with a digit is disambiguated by the trailing colon (phase numbers have it; names don't).

**Opt-in & legacy preservation (satisfies condition 4):** the bracket milestone-detection and emit paths are gated on `config.phase_id_convention === 'bracket'`. The `null` (un-migrated) and `'milestone-prefixed'` (M-NN) paths are **left intact** — their `getMilestoneFromPhaseId` / parse / emit behavior is unchanged. Reads remain tolerant of all forms during the migration window; tolerance is not a second active convention.

## (1) The PLAN dimension and the concrete failing test

The plan is the third dimension. In bracket form it is a single trailing hyphen + zero-padded integer that appears **only in filenames** (`05.03-01-PLAN.md`); the milestone never shares the hyphen because it lives in the bracket. Under M-NN the same hyphen carries both *milestone↔phase* and *phase↔plan*, which is the defect.

The failing test below runs against **redux `src/core.cts`** (verified behavior, not old-arch recall). Both witnesses were traced against `normalizePhaseName` (`core.cts:668`): the milestone regex `^(\d+)((?:-\d+)+)([A-Z]?(?:\.\d+)*)$` and the unanchored fallback `^(\d+)([A-Z])?((?:\.\d+)*)`.

```js
'use strict';
const assert = require('node:assert');
const { test } = require('node:test');
const core = require('../dist/core.cjs'); // redux build of src/core.cts

// ---------------------------------------------------------------------------
// PR-0 collision proof. M-NN convention. These FAIL/expose the defect today;
// the bracket grammar makes every case deterministic.
// ---------------------------------------------------------------------------

test('M-NN: full 4-tuple token "2-01.02-01" has no valid parse (plan dimension collides)', () => {
  // Intended meaning: milestone 2, phase 01, subphase 02, plan 01.
  // M-NN milestone regex requires the suffix to be [A-Z]?(\.\d+)* with $ anchor;
  // the trailing "-01" (the plan) cannot be consumed after ".02", so the anchored
  // milestone match FAILS. Execution falls to the UNANCHORED numeric fallback,
  // which matches only the leading "2" and zero-pads to "02".
  const out = core.normalizePhaseName('2-01.02-01');

  // The defect, asserted concretely: a fully-specified milestone/phase/sub/plan
  // identity silently collapses to the bare milestone-or-phase integer.
  assert.strictEqual(out, '02',
    'M-NN cannot represent (milestone, phase, subphase, plan) — collapses to "02"');

  // The hyphen is overloaded: there is no single deterministic 4-tuple a parser
  // can return without out-of-band convention metadata.
  assert.notStrictEqual(out, '02-01.02-01'); // it did NOT round-trip the input
});

test('M-NN: "02-04" is two-way ambiguous across subsystems (milestone/phase vs phase/plan)', () => {
  // Subsystem A — normalizePhaseName reads "02-04" as milestone 02 / phase 04:
  const asPhaseId = core.normalizePhaseName('02-04');
  assert.strictEqual(asPhaseId, '02-04'); // M-NN: milestone 02, phase 04

  // Subsystem B — plan-file notation "02-04-PLAN.md" reads the SAME string as
  // phase 02 / plan 04. Both readings are valid productions; the token alone
  // cannot tell a resolver which subsystem is asking.
  const planFile = '02-04-PLAN.md';
  const planNotation = planFile.replace(/-PLAN\.md$/, ''); // "02-04"
  assert.strictEqual(planNotation, asPhaseId.replace(/^0*(\d+)/, m => m), // same chars
    'identical token "02-04" carries two meanings in two subsystems');
  // ASSERTION OF THE DEFECT: a bare "02-04" arg is irreducibly ambiguous under M-NN.
});

test('bracket: "GSD.02-05.03-01" parses to exactly one tuple (no collision)', () => {
  // Target behavior once the bracket grammar lands (PR 1). Written as the
  // acceptance assertion for the fix; expected to PASS after PR 1.
  const parsed = core.parsePhaseId('GSD.02-05.03-01'); // ADD in PR 1
  assert.deepStrictEqual(parsed, {
    project:   'GSD',
    milestone: '02',  // from the bracket/dir prefix (READING-B)
    phase:     '05',
    subphase:  '03',
    plan:      '01',
  });
  // Round-trip both surfaces (condition 3):
  assert.strictEqual(core.renderPhaseId(parsed), '[GSD.02] 05.03-01');
  assert.strictEqual(core.toDir(parsed, 'some-feature'), 'GSD.02-05.03-some-feature');
});
```

> Note for maintainers: the first two tests assert the **observed redux behavior** that demonstrates the collision (`2-01.02-01` → `'02'`; `02-04` ambiguous). They are the PR-0 "prove the defect first" artifact. The third asserts the post-fix bracket contract and is expected to fail until PR 1 adds `parsePhaseId`/`renderPhaseId`/`toDir`.

## (2) M-NN deprecation stance — RATIFIED: bracket is terminal

**Bracket is the terminal convention.** M-NN is a `next`-channel pre-release intermediate that bracket *supersedes/completes*, not a stable convention requiring a user-facing deprecation window — because it has **no stable adopters** (published only to `1.3.0-rc.1`/`next`; `latest` is `1.2.0`, which predates #565). Concretely:

- Going forward the runtime speaks **one** convention: bracket (gated on `phase_id_convention: 'bracket'`). `null` (un-migrated/legacy) remains permanently supported.
- M-NN parse/emit is retained **only** as migration-window read-tolerance and inside the migrator (the sole site that still parses M-NN) — it is **not** a second active convention.
- Because M-NN never reached `latest`, bracket can replace it as the `1.3.0`-line convention **before `1.3.0` promotes to stable** — no user deprecation timer is owed to anyone. The migrator converts any `next`-channel/dogfood M-NN repo (including the maintainer's own) → bracket.
- **End state: two conventions (`null` + `bracket`)** — down from the transient three. This is the "fewer load-bearing conventions" the proposal promised, achieved by **consolidation, not addition**.

This is the design hinge the maintainer flagged on #612; it is **decided here**, not deferred. Only the release mechanics (which `1.3.0-rc` carries the cutover) remain the maintainer's call.

## (3) Emit/render as one pure round-trippable function pair

Introduce a single pure model in `core.cts`, replacing the scattered helpers (`normalizePhaseName`, `getMilestoneFromPhaseId`, `getPhaseDirFromPhaseId`, `getPhaseDisplayLabel`) with one parse + two renders sharing one `PhaseId` shape:

```ts
type PhaseId = {
  project: string;     // 'GSD'
  milestone: string;   // '02'  (zero-padded, from bracket/dir prefix — READING-B)
  phase: string;       // '05'  (zero-padded)
  subphase?: string;   // '03'  (optional)
  plan?: string;       // '01'  (filename surface only)
};

function parsePhaseId(input: string): PhaseId;          // display OR dir OR bare arg
function renderPhaseId(id: PhaseId): string;            // '[GSD.02] 05.03-01'
function toDir(id: PhaseId, slug: string): string;      // 'GSD.02-05.03-slug'
```

Property tests (example-based round-trip tables — no `fast-check` dependency assumed; confirm before using a property lib):

```js
const TABLE = [
  { display: '[GSD.02] 05.03-01', dir: 'GSD.02-05.03-feature' },
  { display: '[GSD.02] 05',       dir: 'GSD.02-05-feature' },
  { display: '[CK.01] 12.04',     dir: 'CK.01-12.04-feature' },
];

test('render(parse(display)) === display', () => {
  for (const { display } of TABLE) {
    assert.strictEqual(core.renderPhaseId(core.parsePhaseId(display)), display);
  }
});

test('toDir(parse(display), slug) === dir', () => {
  for (const { display, dir } of TABLE) {
    const slug = dir.replace(/^[^-]+-[^-]+-[^-]+-/, '').replace(/-/g,'-') || 'feature';
    assert.strictEqual(core.toDir(core.parsePhaseId(display), 'feature'), dir);
  }
});

test('parse is idempotent across surfaces: parse(dir) and parse(display) agree on the tuple', () => {
  for (const { display, dir } of TABLE) {
    const a = core.parsePhaseId(display);
    const b = core.parsePhaseId(dir);
    assert.strictEqual(`${b.project}.${b.milestone}-${b.phase}`, `${a.project}.${a.milestone}-${a.phase}`);
  }
});
```

All existing consumers (`phase.cts`, `roadmap.cts`, `commands.cts`, `verify.cts`, `validate.cts`) call this pair rather than re-implementing regexes inline (centralization per ADDENDUM-2 — one hardcoded-but-centralized impl, **not** a pluggable convention engine).

## (4) Milestone-detection rewrite behind opt-in flag; legacy paths intact

```ts
function getMilestoneFromPhaseId(phaseId: unknown, convention?: string): string | null {
  if (convention === 'bracket') {
    // READING-B: milestone from the [PROJECT.MM] / {CODE}.{MM}- prefix.
    // returns 'v{MM}.0' for STATE.md parity (return-form is in DECISIONS-TO-RATIFY).
  }
  // null + 'milestone-prefixed' (M-NN): UNCHANGED — leading-int rule (current core.cts:693).
}
```

- `null` repos: untouched.
- `'milestone-prefixed'` repos: untouched (READING-A leading-int).
- `'bracket'` repos: READING-B prefix rule.
- The convention value is validated by a new enum in `config.cts` (`VALID_PHASE_ID_CONVENTIONS`); today it is an un-validated magic literal (see CARRY-FORWARD §4 B3).

## (5) PR decomposition

| PR | Scope | Primary redux files |
|---|---|---|
| **PR 0** | This ADR + plan-dimension spec + concrete collision test (defect proof). No behavior change. | `docs/adr/612-*.md`, `test/phase-id-collision.test.*` |
| **PR 1** | Core grammar: `PhaseId` type, `parsePhaseId`/`renderPhaseId`/`toDir`, READING-B `getMilestoneFromPhaseId` (gated), `extractPhaseToken` bracket branch, comparator, sentinel guard, slug guard, display label. | `core.cts` |
| **PR 2** | Parse/validate read path: bracket heading/dir tolerance + bracket-coherence checks. | `roadmap.cts`, `validate.cts`, `verify.cts` |
| **PR 3** | Migrator: legacy + M-NN → bracket; dry-run/dirty-guard/rollback (already present), HARD-REFUSE on missing project_code, convention card, fixes for real-layout bugs. | `roadmap-upgrade.cts` |
| **PR 4** | Write path: bracket emit gated on convention, new-project default, STATE.md `milestone:` frontmatter. | `phase.cts`, `state.cts`, `config.cts` |
| **PR 5** | Display + card: `cmdProgressRender` fix, stats `display_id`, statusline, config enum, single-source convention card. | `commands.cts`, `hooks/gsd-statusline.js`, `config.cts` |
| **PR 6** | Generated injection: references, agents/workflows markdown block, `sync-skills` propagation, grep-evidence gate, lift D-DEFAULT. | `references/`, `agents/*.md`, `workflows/**/*.md` |

Each PR is independently green: tolerant reads (PR 2) ship before emit (PR 4), so a partially-landed series never breaks legacy repos.

## (6) ADR as precondition

This ADR is a **precondition** for PRs 1–6 and must be merged first (it is the maintainer's stated #612 acceptance gate). It lands at `docs/adr/612-bracket-phase-id-convention.md`. PR 0 contains only this ADR, the plan-dimension spec, and the collision test — no runtime behavior change — so it is reviewable and mergeable on its own.

## Consequences

- **Positive:** every token uniquely parseable; one pure model; milestone-detection correct under READING-B; legacy repos untouched; migration is opt-in and reversible.
- **Negative:** a migration window where reads must tolerate three forms; a second milestone authority (bracket integer vs STATE.md `milestone:`) whose coherence-check teeth are weak (see DECISIONS-TO-RATIFY); the `getMilestoneFromPhaseId` return-form coupling to archive-dir naming is unresolved.

---

## DECISIONS-TO-RATIFY

These require human ratification before the corresponding PR proceeds.

1. **M-NN deprecation stance + removal trigger** — ✅ **RESOLVED (see §2).** Bracket is terminal; M-NN is a `next`-only RC intermediate with **no stable adopters** (evidence: `latest`=`1.2.0` predates #565; M-NN ships only in `1.3.0-rc.1`/`next`), superseded before `1.3.0` stabilizes; end state = `null` + `bracket`. The only remaining maintainer choice is which `1.3.0-rc` carries the cutover — release mechanics, not design.

2. **Bare `02-04` resolution** (gates PR 1 `normalizePhaseName` / PR 2 resolvers). Options:
   - **(i) Throw a disambiguation error** (old-arch D-IDENT): `Ambiguous phase id '02-04' — use 'GSD.02-04' or '04'`. Kills the silent footgun; but redux `normalizePhaseName('02-04')` currently returns `'02-04'` (does NOT silently truncate — the old-arch CJS truncation bug does not reproduce), so the throw is a *new* behavior, not just a fix.
   - **(ii) Keep current M-NN reading** (`02-04` = milestone 02/phase 04) under M-NN/`null`; only the bracket path rejects it. Less disruptive.
   - **(iii) Context-param disambiguation** — resolver takes a `surface: 'phase'|'plan'` hint. More plumbing.

3. **`phase_naming` vs `phase_id_convention` axis relationship** (gates PR 4 `config.cts` build-default). Are these two independent axes (`phase_naming: sequential|…` and `phase_id_convention: null|milestone-prefixed|bracket`) or are they conflated? `config.cts:251` sets `phase_naming` in the build-default but omits `phase_id_convention`. Confirm before wiring the new-project `'bracket'` default.

4. **`getMilestoneFromPhaseId` return form under bracket + archive-dir naming** (gates PR 1 + PR 2 archived resolution). Does it return `vN.0` (STATE.md parity, lowest churn — recommended) or a bare integer? Value-coupled to the archive-dir glob (`^v[\d.]+-phases$`) and the `result.archived` literal in `findPhaseInternal`; **the archive-dir naming convention under bracket is otherwise undefined** — ratify both together.

5. **W021 code reassignment** (gates PR 2). Two unrelated checks emit `W021` (M-NN prefix-mismatch + milestone-complete-vs-unstarted). The second must move to a new, currently-unassigned warning code when the first is replaced. Assign the number.

6. **Convention card single-source location** (gates PR 5/PR 6). The ASCII grammar card must render identically at installer completion, migrator start (dry-run AND apply), and in docs (ADDENDUM-1). Ratify the single source module/path so it is not duplicated.

7. **`milestone:` authority for the coherence check** (gates PR 2 W021-successor teeth). STATE.md `milestone:` is the active-milestone authority (Q3); the bracket section heading also carries an integer (ADDENDUM-3). For the *coherence* comparison, which is authoritative when they disagree, and does the check have real teeth if milestone is self-declared per-phase? Pin the interplay.

8. **SDK helper follow-up is out of scope here.** (Informational — no ratification needed, but flag.) In old-arch the SDK `helpers.ts` decimal-model artifacts were deferred. In redux there is no separate SDK layer, so READING-B lands directly in `core.cts:693` — there is no separate follow-up. Confirm no other redux module re-implements the leading-int rule before closing this out (grep `getMilestoneFromPhaseId` consumers).
