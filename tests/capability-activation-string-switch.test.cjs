'use strict';

/**
 * capability-activation-string-switch.test.cjs — #4795.
 *
 * `_resolveActivationValue` gates every capability hook on one config key. A hand-edited config can spell
 * a boolean switch as a string, and `Boolean("false")` is true, so a switch the file says is off used to
 * turn on. A string is now read for its meaning; every non-string keeps plain truthiness.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');

const { _resolveActivationValue } = require('../gsd-core/bin/lib/capability-activation.cjs');

const KEY = 'workflow.some_switch';
const REGISTRY = {};

function resolve(value) {
  return _resolveActivationValue(KEY, { workflow: { some_switch: value } }, undefined, REGISTRY);
}

const OFF = ['', 'false', '0', 'no', 'off'];

describe('capability activation: string switches', () => {
  for (const spelling of OFF) {
    test(`offStringIsOff (${JSON.stringify(spelling)})`, () => {
      assert.equal(resolve(spelling), false);
    });
  }

  for (const spelling of ['true', '1', 'yes', 'on', 'medium']) {
    test(`otherStringIsOn (${JSON.stringify(spelling)})`, () => {
      assert.equal(resolve(spelling), true);
    });
  }

  test('caseAndWhitespaceDoNotChangeMeaning', () => {
    for (const spelling of ['FALSE', 'False', ' off ', '\tNo\n', ' 0 ']) assert.equal(resolve(spelling), false);
  });

  test('nonStringsKeepPlainTruthiness', () => {
    assert.equal(resolve(true), true);
    assert.equal(resolve(false), false);
    assert.equal(resolve(1), true);
    assert.equal(resolve(0), false);
    assert.equal(resolve(null), false);
    assert.equal(resolve({}), true);
  });

  test('absentKeyIsOff', () => {
    assert.equal(_resolveActivationValue(KEY, {}, undefined, REGISTRY), false);
  });

  // Property: any casing and surrounding whitespace of an off spelling is off.
  test('everyCasingAndPaddingOfAnOffSpellingIsOff', () => {
    const pad = fc.string({ unit: fc.constantFrom(' ', '\t', '\n'), maxLength: 3 });
    const casing = fc.tuple(fc.constantFrom(...OFF), fc.array(fc.boolean(), { minLength: 5, maxLength: 5 }));
    fc.assert(
      fc.property(pad, casing, pad, (left, [base, flips], right) => {
        const cased = [...base].map((ch, i) => (flips[i % flips.length] ? ch.toUpperCase() : ch)).join('');
        return resolve(`${left}${cased}${right}`) === false;
      }),
      { seed: 4795, numRuns: 200 },
    );
  });

  // Property: a string that is not an off spelling (after trim and lowercasing) is on.
  test('everyOtherNonEmptyStringIsOn', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 12 }), (text) => {
        const normalized = text.trim().toLowerCase();
        return resolve(text) === !OFF.includes(normalized);
      }),
      { seed: 4795, numRuns: 200 },
    );
  });
});
