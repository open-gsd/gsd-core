'use strict';

/**
 * Property-based tests for normalizePhaseReqIds range expansion (#1269).
 *
 * Module: gsd-core/bin/lib/gap-checker.cjs
 * Exported: normalizePhaseReqIds(rawVal)
 *
 * Range form (#1269): a `--phase-req-ids` list element of the shape
 * `<PREFIX>-NN..<PREFIX>-MM` (identical prefix both sides, identical bound digit
 * width, ascending numeric NN ≤ MM) expands in place to the individual IDs,
 * preserving the bounds' zero-pad width; ambiguous/invalid ranges stay literal
 * (fail-closed).
 *
 * Properties tested:
 *   (a) valid ascending same-prefix, same-width range → length == MM-NN+1, all
 *       elements share the prefix, suffixes are strictly monotonic NN..MM,
 *       width preserved
 *   (b) NN == MM → single-element expansion equal to the (re-padded) bound
 *   (c) literal preservation: a non-range token round-trips unchanged
 *   (d) fail-closed: descending and mismatched-prefix ranges stay literal
 *   (d3) fail-closed: differing-width bounds stay literal
 *   (d4) fail-closed: non-numeric bounds stay literal
 *   (d5) fail-closed: missing left/right bound stays literal
 *   (d6) fail-closed: multi-dot tokens stay literal
 *   (e) never throws on arbitrary string input
 *
 * Lives in a sibling *.property.test.cjs file (the established property-test
 * convention). Its effective prefix `gap-checker.property` does not match the
 * `gap-checker` production prefix, so it does not count against the per-module
 * test-file cap; the unit/integration fixtures are folded into
 * bug-447-gap-analysis-phase-req-ids.test.cjs instead.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('./helpers/fast-check-setup.cjs');

const { normalizePhaseReqIds } = require('../gsd-core/bin/lib/gap-checker.cjs');

// A safe prefix that always ends in '-', contains no whitespace, commas,
// brackets, quotes, parens, or dots (those are stripped/split by the
// normalizer), and never collides with the null/TBD/none sentinels.
const prefixArb = fc
  .stringMatching(/^[A-Za-z][A-Za-z0-9]{0,5}$/)
  .filter(s => !/^(null|tbd|none)$/i.test(s))
  .map(s => `${s}-`);

const widthArb = fc.integer({ min: 1, max: 4 });

function pad(n, width) {
  return String(n).padStart(width, '0');
}

describe('#1269 normalizePhaseReqIds — range expansion properties', () => {
  test('(a) valid ascending same-prefix, same-width range expands to MM-NN+1 monotonic same-prefix IDs', () => {
    fc.assert(fc.property(
      prefixArb,
      fc.integer({ min: 0, max: 50 }),
      fc.integer({ min: 0, max: 50 }),
      widthArb,
      (prefix, a, b, w) => {
        const lo = Math.min(a, b);
        const hi = Math.max(a, b);
        // Both bounds share width w; choose w wide enough to hold hi so neither
        // bound is truncated and both render at the SAME digit width.
        const width = Math.max(w, String(hi).length);
        const loStr = pad(lo, width);
        const hiStr = pad(hi, width);
        const token = `${prefix}${loStr}..${prefix}${hiStr}`;

        const result = normalizePhaseReqIds(token);

        // length == MM - NN + 1
        assert.strictEqual(result.length, hi - lo + 1, `length for ${token}`);
        // all elements share the prefix
        for (const id of result) {
          assert.ok(id.startsWith(prefix), `${id} must start with ${prefix}`);
        }
        // suffixes are strictly monotonic NN..MM, each padded to the shared width
        result.forEach((id, i) => {
          const expectedNum = lo + i;
          assert.strictEqual(id, `${prefix}${pad(expectedNum, width)}`,
            `element ${i} of ${token}`);
        });
      },
    ));
  });

  test('(d3) differing-width bounds stay literal (fail-closed)', () => {
    fc.assert(fc.property(
      prefixArb,
      fc.integer({ min: 0, max: 50 }),
      fc.integer({ min: 0, max: 50 }),
      widthArb,
      widthArb,
      (prefix, a, b, wA, wB) => {
        const lo = Math.min(a, b);
        const hi = Math.max(a, b);
        const loStr = pad(lo, wA);
        const hiStr = pad(hi, wB);
        // Only exercise the differing-width case here.
        fc.pre(loStr.length !== hiStr.length);
        const token = `${prefix}${loStr}..${prefix}${hiStr}`;
        assert.deepStrictEqual(normalizePhaseReqIds(token), [token]);
      },
    ));
  });

  test('(d4) non-numeric bounds stay literal (fail-closed)', () => {
    fc.assert(fc.property(
      prefixArb,
      // A suffix containing at least one non-digit so the bound is non-numeric.
      fc.stringMatching(/^[0-9]*[A-Za-z][0-9A-Za-z]*$/),
      fc.stringMatching(/^[0-9]*[A-Za-z][0-9A-Za-z]*$/),
      (prefix, sLo, sHi) => {
        const token = `${prefix}${sLo}..${prefix}${sHi}`;
        assert.deepStrictEqual(normalizePhaseReqIds(token), [token]);
      },
    ));
  });

  test('(d5) missing left or right bound stays literal (fail-closed)', () => {
    fc.assert(fc.property(
      prefixArb,
      fc.integer({ min: 0, max: 99 }),
      widthArb,
      fc.boolean(),
      (prefix, n, w, dropLeft) => {
        const bound = `${prefix}${pad(n, w)}`;
        const token = dropLeft ? `..${bound}` : `${bound}..`;
        assert.deepStrictEqual(normalizePhaseReqIds(token), [token]);
      },
    ));
  });

  test('(d6) multi-dot tokens stay literal (fail-closed)', () => {
    fc.assert(fc.property(
      prefixArb,
      fc.integer({ min: 0, max: 50 }),
      fc.integer({ min: 0, max: 50 }),
      fc.integer({ min: 0, max: 50 }),
      widthArb,
      (prefix, a, b, c, w) => {
        const token = `${prefix}${pad(a, w)}..${prefix}${pad(b, w)}..${prefix}${pad(c, w)}`;
        assert.deepStrictEqual(normalizePhaseReqIds(token), [token]);
      },
    ));
  });

  test('(b) NN == MM expands to a single re-padded bound', () => {
    fc.assert(fc.property(
      prefixArb,
      fc.integer({ min: 0, max: 99 }),
      widthArb,
      (prefix, n, w) => {
        const nStr = pad(n, w);
        const token = `${prefix}${nStr}..${prefix}${nStr}`;
        const result = normalizePhaseReqIds(token);
        // Expected width is nStr.length, not w: when n has more digits than w
        // (e.g. n=99, w=1), pad() returns the un-truncated "99", so the emitted
        // ID preserves the bound's actual width — which is what the range parser does.
        assert.deepStrictEqual(result, [`${prefix}${pad(n, nStr.length)}`]);
      },
    ));
  });

  test('(c) a non-range single token round-trips unchanged (literal preservation)', () => {
    fc.assert(fc.property(
      prefixArb,
      fc.integer({ min: 0, max: 999 }),
      widthArb,
      (prefix, n, w) => {
        const id = `${prefix}${pad(n, w)}`; // a plain ID, no '..'
        assert.deepStrictEqual(normalizePhaseReqIds(id), [id]);
      },
    ));
  });

  test('(d) descending range stays literal (fail-closed)', () => {
    fc.assert(fc.property(
      prefixArb,
      fc.integer({ min: 1, max: 50 }),
      fc.integer({ min: 1, max: 50 }),
      widthArb,
      (prefix, a, b, w) => {
        fc.pre(a !== b);
        const hi = Math.max(a, b);
        const lo = Math.min(a, b);
        // Deliberately put the larger bound first → descending → must stay literal.
        const token = `${prefix}${pad(hi, w)}..${prefix}${pad(lo, w)}`;
        assert.deepStrictEqual(normalizePhaseReqIds(token), [token]);
      },
    ));
  });

  test('(d2) mismatched-prefix range stays literal (fail-closed)', () => {
    fc.assert(fc.property(
      prefixArb,
      prefixArb,
      fc.integer({ min: 0, max: 50 }),
      fc.integer({ min: 0, max: 50 }),
      widthArb,
      (p1, p2, a, b, w) => {
        fc.pre(p1 !== p2);
        const lo = Math.min(a, b);
        const hi = Math.max(a, b);
        const token = `${p1}${pad(lo, w)}..${p2}${pad(hi, w)}`;
        assert.deepStrictEqual(normalizePhaseReqIds(token), [token]);
      },
    ));
  });

  test('(e) never throws on arbitrary string input', () => {
    fc.assert(fc.property(fc.string(), (s) => {
      // Either a valid normalized value or null — but never an exception.
      assert.doesNotThrow(() => normalizePhaseReqIds(s));
    }));
  });
});
