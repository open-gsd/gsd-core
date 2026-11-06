'use strict';

/**
 * One owner for the surrogate-safe UTF-16 cap (#5639, gsd-core-79dl).
 *
 * `capCodeUnits` in `src/gate-predicate-evaluator.cts` is the only place that cuts a string at a code-unit
 * budget. Its callers are `prefixedCap` (gate-predicate-evaluator), the Pi description cap
 * (runtime-artifact-conversion) and the raw-status token cut (verification). The parity
 * test fails when a caller grows its own surrogate-range cut again.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fc = require('./helpers/fast-check-setup.cjs');

const { capCodeUnits } = require('../gsd-core/bin/lib/gate-predicate-evaluator.cjs');

const SRC = path.join(__dirname, '..', 'src');
const OWNER = 'gate-predicate-evaluator.cts';
const CALLERS = ['runtime-artifact-conversion.cts', 'verification.cts'];

const isLoneSurrogateFree = (s) => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);

describe('capCodeUnits', () => {
  test('keeps text that fits, whole', () => {
    assert.equal(capCodeUnits('abc', 3, 'head'), 'abc');
    assert.equal(capCodeUnits('abc', 3, 'tail'), 'abc');
  });

  test('a non-positive budget keeps nothing', () => {
    assert.equal(capCodeUnits('abc', 0, 'head'), '');
    assert.equal(capCodeUnits('abc', 0, 'tail'), '');
    assert.equal(capCodeUnits('abc', -4, 'tail'), '');
  });

  test('head cut drops the orphaned high surrogate', () => {
    assert.equal(capCodeUnits('a\u{1F600}b', 2, 'head'), 'a');
  });

  test('tail cut drops the orphaned low surrogate', () => {
    assert.equal(capCodeUnits('a\u{1F600}b', 2, 'tail'), 'b');
  });

  test('property: within budget, a suffix or prefix of the input, no lone surrogate', () => {
    fc.assert(
      fc.property(
        fc.array(fc.oneof(fc.string({ maxLength: 1 }), fc.constant('\u{1F600}')), { maxLength: 30 }).map((a) => a.join('')),
        fc.integer({ min: -2, max: 40 }),
        fc.constantFrom('head', 'tail'),
        (text, max, keep) => {
          const out = capCodeUnits(text, max, keep);
          assert.ok(out.length <= Math.max(0, max));
          assert.ok(keep === 'head' ? text.startsWith(out) : text.endsWith(out));
          if (isLoneSurrogateFree(text)) assert.ok(isLoneSurrogateFree(out));
        },
      ),
    );
  });
});

describe('the cap sites share the one owner', () => {
  test(`${OWNER} defines capCodeUnits`, () => {
    assert.match(fs.readFileSync(path.join(SRC, OWNER), 'utf8'), /function capCodeUnits\(/);
  });

  for (const file of CALLERS) {
    test(`${file} uses the evaluator's capCodeUnits and keeps no surrogate-range cut of its own`, () => {
      const source = fs.readFileSync(path.join(SRC, file), 'utf8');
      assert.match(source, /gatePredicateEvaluator\.capCodeUnits\(/);
      assert.doesNotMatch(source, /0xd800|0xdbff|\\uD800|\\uDBFF|\\uDC00|\\uDFFF/i);
    });
  }
});
