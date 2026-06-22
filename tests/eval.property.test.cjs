'use strict';

/**
 * Property-based tests for the eval scoring module (#10 / #1579).
 *
 * Module: gsd-core/bin/lib/eval.cjs
 * Exported: computeEvalScore(covered, total, infra), cmdEvalScore(cwd, args, raw)
 *
 * Properties tested:
 *   (a) determinism — computeEvalScore is pure: identical inputs deep-equal across calls
 *   (b) output shape — always { coverage_score, infra_score, overall_score, verdict };
 *       scores finite; verdict is exactly the band implied by overall_score
 *   (c) overall_score derivation — equals round(coverage*0.6 + infra*0.4) within rounding
 *   (d) band monotonicity — a higher overall_score never maps to a lower-quality verdict
 *   (e) valid-domain bounds — for 0<=covered<=total and infra in {ok,partial,missing},
 *       every score lands in [0,100]
 *   (f) never throws — tolerates arbitrary infra tokens/lengths and numeric inputs
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('./helpers/fast-check-setup.cjs');
const { computeEvalScore } = require('../gsd-core/bin/lib/eval.cjs');

const INFRA_TOKENS = ['ok', 'partial', 'missing'];
const VERDICTS = ['PRODUCTION READY', 'NEEDS WORK', 'SIGNIFICANT GAPS', 'NOT IMPLEMENTED'];
const RANK = { 'NOT IMPLEMENTED': 0, 'SIGNIFICANT GAPS': 1, 'NEEDS WORK': 2, 'PRODUCTION READY': 3 };
const band = (o) =>
  o >= 80 ? 'PRODUCTION READY' :
  o >= 60 ? 'NEEDS WORK' :
  o >= 40 ? 'SIGNIFICANT GAPS' : 'NOT IMPLEMENTED';

// Valid-domain generator: 0 <= covered <= total, exactly 5 infra tokens.
const validDomain = fc.record({
  total: fc.nat({ max: 1000 }),
  infra: fc.array(fc.constantFrom(...INFRA_TOKENS), { minLength: 5, maxLength: 5 }),
}).chain(({ total, infra }) =>
  fc.nat({ max: total }).map((covered) => ({ covered, total, infra })));

describe('computeEvalScore — properties', () => {
  test('(a) deterministic / pure', () => {
    fc.assert(fc.property(validDomain, ({ covered, total, infra }) => {
      assert.deepEqual(
        computeEvalScore(covered, total, infra),
        computeEvalScore(covered, total, infra),
      );
    }));
  });

  test('(b) output shape + verdict matches band', () => {
    fc.assert(fc.property(validDomain, ({ covered, total, infra }) => {
      const r = computeEvalScore(covered, total, infra);
      for (const k of ['coverage_score', 'infra_score', 'overall_score']) {
        assert.ok(Number.isFinite(r[k]), `${k} must be finite`);
      }
      assert.ok(VERDICTS.includes(r.verdict), `verdict must be one of the four bands`);
      assert.equal(r.verdict, band(r.overall_score));
    }));
  });

  test('(c) overall_score = round(coverage*0.6 + infra*0.4)', () => {
    fc.assert(fc.property(validDomain, ({ covered, total, infra }) => {
      const r = computeEvalScore(covered, total, infra);
      const expected = Math.round((r.coverage_score * 0.6 + r.infra_score * 0.4) * 100) / 100;
      // coverage_score/infra_score are pre-rounded to 2dp; allow compounded-rounding slack.
      assert.ok(Math.abs(r.overall_score - expected) <= 0.05,
        `overall_score ${r.overall_score} should equal ${expected} within rounding`);
    }));
  });

  test('(d) verdict band monotonic in overall_score', () => {
    fc.assert(fc.property(validDomain, validDomain, (a, b) => {
      const ra = computeEvalScore(a.covered, a.total, a.infra);
      const rb = computeEvalScore(b.covered, b.total, b.infra);
      if (ra.overall_score <= rb.overall_score) {
        assert.ok(RANK[ra.verdict] <= RANK[rb.verdict],
          `score ${ra.overall_score}<=${rb.overall_score} but verdict rank ${ra.verdict}>${rb.verdict}`);
      }
    }));
  });

  test('(e) valid-domain scores stay within [0,100]', () => {
    fc.assert(fc.property(validDomain, ({ covered, total, infra }) => {
      const r = computeEvalScore(covered, total, infra);
      for (const k of ['coverage_score', 'infra_score', 'overall_score']) {
        assert.ok(r[k] >= 0 && r[k] <= 100, `${k}=${r[k]} must be in [0,100]`);
      }
    }));
  });

  test('(f) never throws on arbitrary infra tokens / lengths / numbers', () => {
    fc.assert(fc.property(
      fc.integer({ min: -1000, max: 1000 }),
      fc.integer({ min: -1000, max: 1000 }),
      fc.array(fc.string(), { maxLength: 12 }),
      (covered, total, infra) => {
        assert.doesNotThrow(() => computeEvalScore(covered, total, infra));
      },
    ));
  });
});
