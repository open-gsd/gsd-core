'use strict';

/**
 * Behaviour of the shared surrogate-safe UTF-16 cap (#5639).
 *
 * `capCodeUnits` in `src/code-unit-cap.cts` serves `prefixedCap` (gate-predicate-evaluator),
 * the Pi description cap (runtime-artifact-conversion) and the raw-status token cut (verification).
 * Caller behaviour is covered by tests/verification-status.test.cjs, tests/pi-workflow-handoff.test.cjs
 * and tests/install-runtime-artifacts.test.cjs.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('./helpers/fast-check-setup.cjs');

const { capCodeUnits } = require('../gsd-core/bin/lib/code-unit-cap.cjs');

const isLoneSurrogateFree = (s) => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);

describe('capCodeUnits', () => {
  test('keeps text that fits, whole', () => {
    assert.equal(capCodeUnits('abc', 3, 'head'), 'abc');
    assert.equal(capCodeUnits('abc', 3, 'tail'), 'abc');
  });

  test('cuts one unit below and above the budget', () => {
    assert.equal(capCodeUnits('ab', 3, 'head'), 'ab');
    assert.equal(capCodeUnits('ab', 3, 'tail'), 'ab');
    assert.equal(capCodeUnits('abc', 2, 'head'), 'ab');
    assert.equal(capCodeUnits('abc', 2, 'tail'), 'bc');
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
