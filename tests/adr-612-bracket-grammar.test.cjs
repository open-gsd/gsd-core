'use strict';

/**
 * PR-1 (#2249 / epic #612) — bracket phase-ID core grammar.
 *
 * Ratified contract: docs/adr/612-bracket-phase-id-convention.md, Decisions 1/4/6.
 * One pure round-trippable model added INSIDE src/phase-id.cts (the ADR-2121
 * single canonical owner): parsePhaseId / renderPhaseId / toDir sharing one
 * PhaseId shape, alongside the existing M-NN helpers. READING-B: the milestone
 * comes from the `[PROJECT.MM]` / `{CODE}.{MM}-` prefix, never the phase-token
 * leading integer.
 *
 * Sibling of tests/adr-612-collision-characterization.test.cjs (the PR-0 anchor):
 * that file locks the CURRENT M-NN collapse (`normalizePhaseName('2-01.02-01')
 * === '02'`); this file locks the bracket grammar that resolves the same
 * `(milestone, phase, subphase, plan)` identity to exactly one tuple on the
 * gated bracket path.
 *
 * All assertions are BEHAVIORAL: call the exported function, assert its typed
 * output. No source-grep. The example tables mirror ADR §3; the two fast-check
 * blocks are the generative round-trip / disk-display bijection properties the
 * #612 approval requires (ADR Decision 4).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');

const core = require('../gsd-core/bin/lib/phase-id.cjs');

const p2 = (n) => String(n).padStart(2, '0');

// ─── ADR §3 round-trip example table (doc-parity) ───────────────────────────
const TABLE = [
  { display: '[GSD.02] 05.03-01', dir: 'GSD.02-05.03-feature' },
  { display: '[GSD.02] 05',       dir: 'GSD.02-05-feature' },
  { display: '[CK.01] 12.04',     dir: 'CK.01-12.04-feature' },
];

describe('bracket grammar: emit/render round-trip pair (ADR §3)', () => {
  test('render(parse(display)) === display', () => {
    for (const { display } of TABLE) {
      assert.strictEqual(core.renderPhaseId(core.parsePhaseId(display)), display);
    }
  });

  test('toDir(parse(display), slug) === dir', () => {
    for (const { display, dir } of TABLE) {
      assert.strictEqual(core.toDir(core.parsePhaseId(display), 'feature'), dir);
    }
  });

  test('parse is idempotent across surfaces: parse(dir) and parse(display) agree on the tuple', () => {
    for (const { display, dir } of TABLE) {
      const a = core.parsePhaseId(display);
      const b = core.parsePhaseId(dir);
      assert.strictEqual(
        `${b.project}.${b.milestone}-${b.phase}`,
        `${a.project}.${a.milestone}-${a.phase}`,
      );
    }
  });
});

// ─── ADR §1 collision-test acceptance (the full 5-tuple, post-fix) ───────────
describe('bracket grammar: full 5-tuple parse (ADR §1 acceptance)', () => {
  test('parsePhaseId resolves a complete milestone/phase/subphase/plan identity', () => {
    const parsed = core.parsePhaseId('GSD.02-05.03-01');
    assert.deepStrictEqual(parsed, {
      project:   'GSD',
      milestone: '02', // from the bracket/dir prefix (READING-B), not the leading int
      phase:     '05',
      subphase:  '03',
      plan:      '01',
    });
    assert.strictEqual(core.renderPhaseId(parsed), '[GSD.02] 05.03-01');
    assert.strictEqual(core.toDir(parsed, 'some-feature'), 'GSD.02-05.03-some-feature');
  });

  test('a plan without a subphase round-trips (display -[LL] with no .SS)', () => {
    const id = core.parsePhaseId('[GSD.02] 05-01');
    assert.strictEqual(id.subphase, undefined);
    assert.strictEqual(id.plan, '01');
    assert.strictEqual(core.renderPhaseId(id), '[GSD.02] 05-01');
  });

  test('a bare dir/token arg with no trailing segment parses (contract #2 "bare bracket arg")', () => {
    // `GSD.02-05` — the on-disk/CLI token with neither sub-phase, plan, nor slug.
    const id = core.parsePhaseId('GSD.02-05');
    assert.deepStrictEqual(id, { project: 'GSD', milestone: '02', phase: '05' });
    assert.strictEqual(core.renderPhaseId(id), '[GSD.02] 05');
  });
});

// ─── Bare/ambiguous tokens are rejected — only the bracket parser throws ─────
describe('bracket grammar: parsePhaseId rejects ambiguous non-bracket tokens (ADR conservative default #8a)', () => {
  test("bare '02-04' (the cross-subsystem ambiguity) is rejected by the bracket parser", () => {
    // '02-04' has no bracket and no {CODE}.{MM}- dot-prefix, so it matches
    // neither branch — the new bracket parser throws rather than guess a tuple.
    // The rejection lives ONLY here; normalizePhaseName still returns it intact
    // (see adr-612-collision-characterization.test.cjs), so no existing path
    // gains a throw.
    assert.throws(() => core.parsePhaseId('02-04'), /not a bracket phase id/);
    // The legacy reader is untouched by this rejection.
    assert.strictEqual(core.normalizePhaseName('02-04'), '02-04');
  });

  test('other non-bracket forms are rejected', () => {
    assert.throws(() => core.parsePhaseId('05'), /not a bracket phase id/);
    assert.throws(() => core.parsePhaseId('2-01'), /not a bracket phase id/);
    assert.throws(() => core.parsePhaseId(''), /not a bracket phase id/);
  });
});

// ─── READING-B milestone source (gated on 'bracket'; legacy paths intact) ────
describe('bracket grammar: getMilestoneFromPhaseId READING-B', () => {
  test("milestone comes from the [PROJECT.MM] prefix, not the phase-token leading int", () => {
    // 'GSD.02-05.03' → milestone 02 (v2.0), NOT phase 05 (v5.0). ADR Decision 6.
    assert.strictEqual(core.getMilestoneFromPhaseId('GSD.02-05.03', 'bracket'), 'v2.0');
  });

  test('sentinel milestone ranges (0.x / 999.x) resolve to null', () => {
    assert.strictEqual(core.getMilestoneFromPhaseId('GSD.00-01', 'bracket'), null);
    assert.strictEqual(core.getMilestoneFromPhaseId('GSD.999-01', 'bracket'), null);
  });

  test('a bracket-convention call on a non-bracket string returns null (no throw)', () => {
    // Negative branch: convention === 'bracket' but the string has no
    // {CODE}.{MM} prefix → null, not an exception.
    assert.strictEqual(core.getMilestoneFromPhaseId('2-01', 'bracket'), null);
  });

  test("legacy M-NN path is byte-unchanged when convention is absent / not 'bracket'", () => {
    // READING-A leading-int rule, current behavior — must not regress.
    assert.strictEqual(core.getMilestoneFromPhaseId('2-01'), 'v2.0');
    assert.strictEqual(core.getMilestoneFromPhaseId('CK-2-01'), 'v2.0');
    assert.strictEqual(core.getMilestoneFromPhaseId('2-01', 'milestone-prefixed'), 'v2.0');
    // Sentinel + non-milestone forms preserved on the legacy path.
    assert.strictEqual(core.getMilestoneFromPhaseId('0-01'), null);
    assert.strictEqual(core.getMilestoneFromPhaseId('05'), null);
  });
});

// ─── extractPhaseToken: bracket dir form (gated on convention) ───────────────
// The bracket dir `{CODE}.{MM}-{PP}` is string-indistinguishable from the legacy
// #2043 letter-prefixed-decimal family (`P0.3-2`) when the code ends in a digit,
// so the new bracket reader fires ONLY under an explicit `convention` arg — the
// same gating decision as getMilestoneFromPhaseId's READING-B. Convention-less
// callers keep the legacy reading byte-identical (pinned across the whole
// numeric-tail family in tests/phase-id.test.cjs).
describe('bracket grammar: extractPhaseToken (bracket path gated on convention)', () => {
  test("extracts the phase token PP[.SS] from a bracket dir under convention 'bracket'", () => {
    assert.strictEqual(core.extractPhaseToken('CK.02-02.01-slug', 'bracket'), '02.01');
    assert.strictEqual(core.extractPhaseToken('GSD.02-05-feature', 'bracket'), '05');
    assert.strictEqual(core.extractPhaseToken('GSD.02-05.03-01', 'bracket'), '05.03'); // plan is not part of the token
  });

  test('the bracket path is OFF by default: a convention-less call keeps the legacy reading', () => {
    // Without the signal the bracket branch is skipped; `GSD.02` matches neither
    // the leading-int nor the letter-prefix legacy rule, so the whole dir name is
    // returned unchanged (prior behaviour) rather than parsed as a bracket dir.
    assert.strictEqual(core.extractPhaseToken('GSD.02-05.03-01'), 'GSD.02-05.03-01');
  });

  test('legacy code-prefixed dirs still extract as before (no regression)', () => {
    assert.strictEqual(core.extractPhaseToken('CK-01-foo'), 'CK-01');
    assert.strictEqual(core.extractPhaseToken('02-04-some-slug'), '02-04');
  });
});

// ─── comparator: existing comparePhaseNum orders extracted bracket tokens ─────
// ADR §Phases PR-1 row names "comparator". No NEW comparator code is required:
// bracket phase tokens flow through extractPhaseToken (which yields the
// dot-decimal `PP[.SS]` form), and comparePhaseNum's existing numeric+decimal
// branch already orders that form. Cross-MILESTONE ordering (a milestone-
// qualified key) is a resolution/lookup concern deferred to PR-2
// (bracketQualifiedKey), not core grammar — the last case below shows the
// boundary: two tokens from different milestones compare equal because the
// extracted token is milestone-blind by construction.
describe('bracket grammar: comparePhaseNum orders extracted bracket phase tokens', () => {
  const tok = (d) => core.extractPhaseToken(d, 'bracket');
  test('phase order: 05 < 12', () => {
    assert.ok(core.comparePhaseNum(tok('GSD.02-05'), tok('GSD.02-12')) < 0);
    assert.ok(core.comparePhaseNum(tok('GSD.02-12'), tok('GSD.02-05')) > 0);
  });

  test('sub-phase order: 05.03 < 05.10, and a bare phase sorts before its sub-phases', () => {
    assert.ok(core.comparePhaseNum(tok('GSD.02-05.03'), tok('GSD.02-05.10')) < 0);
    assert.ok(core.comparePhaseNum(tok('GSD.02-05'), tok('GSD.02-05.03')) < 0);
  });

  test('the extracted token is milestone-blind: same PP[.SS] across milestones compares equal (PR-2 owns qualified ordering)', () => {
    assert.strictEqual(core.comparePhaseNum(tok('GSD.02-05.03'), tok('CK.09-05.03')), 0);
  });
});

// ─── sentinel guard: isSentinelPhaseId / SENTINEL_RANGES ────────────────────
describe('bracket grammar: sentinel guard', () => {
  test('SENTINEL_RANGES are the {0, 999} milestone ranges', () => {
    assert.deepStrictEqual([...core.SENTINEL_RANGES], [0, 999]);
  });

  test('isSentinelPhaseId is true for milestone 0 / 999 across forms', () => {
    // Bracket forms: milestone in the `{CODE}.{MM}` prefix (gated on convention).
    assert.strictEqual(core.isSentinelPhaseId('GSD.999-01', 'bracket'), true);
    assert.strictEqual(core.isSentinelPhaseId('GSD.00-01', 'bracket'), true);
    // Legacy/bare leading-int forms need no convention.
    assert.strictEqual(core.isSentinelPhaseId('999.1'), true);
    assert.strictEqual(core.isSentinelPhaseId('0.1'), true);
  });

  test('isSentinelPhaseId is false for ordinary milestones and for tokens with no leading integer', () => {
    assert.strictEqual(core.isSentinelPhaseId('GSD.02-05', 'bracket'), false);
    assert.strictEqual(core.isSentinelPhaseId('2-01'), false);
    // Negative branch: a string with no leading integer at all → false.
    assert.strictEqual(core.isSentinelPhaseId('feature-branch'), false);
  });

  test('the bracket sentinel path is OFF by default: a convention-less #1324 dir is not a sentinel', () => {
    // `P0.0-foundation` is a real #1324 letter-prefixed phase, NOT milestone-0
    // sentinel. Auto-detecting the `P0`/`.0` prefix would be a false positive
    // (the same root ambiguity gated in extractPhaseToken), so without the
    // convention signal the legacy leading-int rule applies and returns false.
    assert.strictEqual(core.isSentinelPhaseId('P0.0-foundation'), false);
    assert.strictEqual(core.isSentinelPhaseId('P0.999-x'), false);
  });
});

// ─── slug guard: toDir never emits a path-traversal slug ────────────────────
describe('bracket grammar: toDir slug guard', () => {
  test('a hostile slug is sanitized to a safe filesystem token', () => {
    const id = core.parsePhaseId('[GSD.02] 05');
    const dir = core.toDir(id, '../../etc/passwd');
    assert.ok(!dir.includes('/'), `dir must not contain a path separator: ${dir}`);
    assert.ok(!dir.includes('..'), `dir must not contain '..': ${dir}`);
    assert.strictEqual(dir, 'GSD.02-05-etc-passwd');
  });

  test('a clean slug is preserved (round-trip unaffected)', () => {
    assert.strictEqual(core.toDir(core.parsePhaseId('[GSD.02] 05.03-01'), 'feature'), 'GSD.02-05.03-feature');
  });
});

// ─── canonical token/heading sources for the downstream read path (PR-2) ─────
describe('bracket grammar: exported canonical sources (drift-guard owner)', () => {
  test('BRACKET_PHASE_TOKEN_SOURCE matches the bracket numeric run (dot-or-dash sub-separator)', () => {
    const re = new RegExp(`^${core.BRACKET_PHASE_TOKEN_SOURCE}$`);
    // The bracket dir/heading numeric run: MM-PP[.SS] (dash milestone↔phase, dot phase↔subphase).
    assert.ok(re.test('02-05.03'), 'MM-PP.SS run');
    assert.ok(re.test('02-05'), 'MM-PP run');
    assert.ok(re.test('05.03'), 'PP.SS phase token');
    assert.ok(re.test('05'), 'bare phase');
    assert.ok(re.test('12A'), 'letter variant');
    assert.ok(!re.test('slug'), 'non-numeric is not a token');
  });

  test('PHASE_HEADING_PREFIX_SRC matches a bracket-or-Phase heading intro, not a bare number', () => {
    const re = new RegExp(`^${core.PHASE_HEADING_PREFIX_SRC}`);
    assert.ok(re.test('[GSD.02] 05: Title'), 'bracket prefix');
    assert.ok(re.test('Phase 5: Title'), 'Phase prefix');
    assert.ok(re.test('[GSD.02] Phase 5: Title'), 'bracket + Phase prefix');
    assert.ok(!re.test('05: Title'), 'a bare number is not a phase heading intro');
  });
});

// ─── fast-check generative properties (ADR Decision 4) ──────────────────────
// A genuinely generative project code over the repo's [A-Z][A-Z0-9_]* grammar.
const projectArb = fc
  .tuple(
    fc.constantFrom(...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')),
    fc.array(fc.constantFrom(...'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_'.split('')), { maxLength: 5 }),
  )
  .map(([head, rest]) => head + rest.join(''));
// A clean, non-numeric slug: unchanged by the slug guard and never mistaken for
// a plan (so the disk↔display bijection is exact on the identity tuple).
const slugArb = fc
  .array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz'.split('')), { minLength: 1, maxLength: 8 })
  .map((cs) => cs.join(''));
const numArb = fc.integer({ min: 1, max: 99 });
const optNumArb = fc.option(numArb, { nil: undefined });

describe('bracket grammar — properties (fast-check)', () => {
  test('round-trip: renderPhaseId(parsePhaseId(display)) === display for every well-formed display', () => {
    fc.assert(
      fc.property(projectArb, numArb, numArb, optNumArb, optNumArb, (proj, mm, pp, ss, ll) => {
        let display = `[${proj}.${p2(mm)}] ${p2(pp)}`;
        if (ss !== undefined) display += `.${p2(ss)}`;
        if (ll !== undefined) display += `-${p2(ll)}`;
        return core.renderPhaseId(core.parsePhaseId(display)) === display;
      }),
    );
  });

  test('disk↔display bijection: toDir(parse(display), slug) is the canonical dir and re-parses to the same identity', () => {
    fc.assert(
      fc.property(projectArb, numArb, numArb, optNumArb, slugArb, (proj, mm, pp, ss, slug) => {
        let display = `[${proj}.${p2(mm)}] ${p2(pp)}`;
        if (ss !== undefined) display += `.${p2(ss)}`;
        const id = core.parsePhaseId(display);
        const dir = core.toDir(id, slug);
        const expectedDir = `${proj}.${p2(mm)}-${p2(pp)}${ss !== undefined ? '.' + p2(ss) : ''}-${slug}`;
        if (dir !== expectedDir) return false;
        const back = core.parsePhaseId(dir);
        return (
          back.project === id.project &&
          back.milestone === id.milestone &&
          back.phase === id.phase &&
          back.subphase === id.subphase
        );
      }),
    );
  });
});
