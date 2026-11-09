'use strict';

/**
 * Behavioral suite for the timeout evidence validator (#4689).
 *
 * TESTING-STANDARDS.md "Every new or changed timeout constant states its evidence" requires each
 * numeric constant exported by tests/helpers/timeouts.cjs to carry a TIMEOUT_EVIDENCE entry.
 * `validateTimeoutEvidence` (tests/helpers/timeout-evidence.cjs) checks that data. Synthetic
 * constants below are neutral test data for the validator, not timeouts.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('./helpers/fast-check-setup.cjs');

const { validateTimeoutEvidence, MIN_TIMEOUT_MARGIN } = require('./helpers/timeout-evidence.cjs');
const timeoutsExports = require('./helpers/timeouts.cjs');
const { TIMEOUT_EVIDENCE } = timeoutsExports;
const { DEFAULT_TIMEOUT_MS } = require('./helpers/process-seam.cjs');

const OBSERVED_MS = 100;

/** A valid `measured` entry; overrides replace individual fields. */
function measured(overrides = {}) {
  return {
    kind: 'measured',
    observedMaxMs: OBSERVED_MS,
    worstPlatform: 'linux',
    samples: { linux: 3 },
    source: 'synthetic-source',
    window: 'synthetic-window',
    ...overrides,
  };
}

const rulesOf = (violations) => violations.map((v) => `${v.constant}:${v.rule}`);

describe('validateTimeoutEvidence', () => {
  test('every timeouts.cjs constant carries valid evidence', () => {
    const violations = validateTimeoutEvidence(timeoutsExports, TIMEOUT_EVIDENCE);
    assert.deepEqual(violations, [], `timeout evidence violations:\n${JSON.stringify(violations, null, 2)}`);
  });

  test('margin floor: one ms under 2x is rejected', () => {
    const value = MIN_TIMEOUT_MARGIN * OBSERVED_MS - 1;
    const violations = validateTimeoutEvidence({ CLASS_A_MS: value }, { CLASS_A_MS: measured() });
    assert.deepEqual(rulesOf(violations), ['CLASS_A_MS:margin-below-minimum']);
    assert.match(violations[0].detail, new RegExp(String(value)));
    assert.match(violations[0].detail, new RegExp(String(OBSERVED_MS)));
    assert.match(violations[0].detail, /1\.99/);
  });

  test('margin floor: exactly 2x passes', () => {
    const value = MIN_TIMEOUT_MARGIN * OBSERVED_MS;
    assert.deepEqual(validateTimeoutEvidence({ CLASS_A_MS: value }, { CLASS_A_MS: measured() }), []);
  });

  test('margin floor: one ms over 2x passes', () => {
    const value = MIN_TIMEOUT_MARGIN * OBSERVED_MS + 1;
    assert.deepEqual(validateTimeoutEvidence({ CLASS_A_MS: value }, { CLASS_A_MS: measured() }), []);
  });

  test('margin floor holds for arbitrary observations', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1e6 }),
        fc.integer({ min: 1, max: 3e6 }),
        (observed, value) => {
          const violations = validateTimeoutEvidence(
            { CLASS_A_MS: value },
            { CLASS_A_MS: measured({ observedMaxMs: observed }) },
          );
          const passes = violations.length === 0;
          return passes === (value >= 2 * observed);
        },
      ),
      { seed: 42, numRuns: 200 },
    );
  });

  test('an exported constant without evidence is reported', () => {
    const violations = validateTimeoutEvidence({ CLASS_A_MS: 500 }, {});
    assert.deepEqual(rulesOf(violations), ['CLASS_A_MS:missing-evidence']);
  });

  test('evidence for a non-exported name is reported', () => {
    const violations = validateTimeoutEvidence({}, { CLASS_B_MS: measured() });
    assert.deepEqual(rulesOf(violations), ['CLASS_B_MS:orphan-evidence']);
  });

  test('non-positive or non-numeric observations are rejected', () => {
    for (const bad of [0, -1, NaN, Infinity, '7424', null]) {
      const violations = validateTimeoutEvidence(
        { CLASS_A_MS: 1e9 },
        { CLASS_A_MS: measured({ observedMaxMs: bad }) },
      );
      assert.deepEqual(rulesOf(violations), ['CLASS_A_MS:invalid-observed'], `observedMaxMs=${String(bad)}`);
    }
  });

  test('platform must be win32/darwin/linux', () => {
    for (const bad of ['windows', '', undefined]) {
      const violations = validateTimeoutEvidence(
        { CLASS_A_MS: 1000 },
        { CLASS_A_MS: measured({ worstPlatform: bad }) },
      );
      assert.deepEqual(rulesOf(violations), ['CLASS_A_MS:invalid-platform'], `worstPlatform=${String(bad)}`);
    }
  });

  test('censored entry states the threshold as its upper bound', () => {
    const entry = measured({ worstPlatform: null, censoredBelowMs: 2000, observedMaxMs: 2000 });
    assert.deepEqual(validateTimeoutEvidence({ CLASS_A_MS: 4000 }, { CLASS_A_MS: entry }), []);
  });

  test('censored observation must equal its threshold', () => {
    const entry = measured({ worstPlatform: null, censoredBelowMs: 2000, observedMaxMs: 1500 });
    const violations = validateTimeoutEvidence({ CLASS_A_MS: 4000 }, { CLASS_A_MS: entry });
    assert.deepEqual(rulesOf(violations), ['CLASS_A_MS:invalid-censor']);
  });

  test('samples must be non-negative integers with at least one > 0', () => {
    for (const bad of [undefined, {}, { linux: 0, darwin: 0 }, { linux: 1.5 }, { linux: -1 }]) {
      const violations = validateTimeoutEvidence(
        { CLASS_A_MS: 1000 },
        { CLASS_A_MS: measured({ samples: bad }) },
      );
      assert.deepEqual(rulesOf(violations), ['CLASS_A_MS:invalid-samples'], `samples=${JSON.stringify(bad)}`);
    }
  });

  test('a mirror equal to its source passes', () => {
    const entry = { kind: 'mirror', of: { module: 'source-module.cjs', export: 'SOURCE_MS' } };
    const resolveMirror = () => 750;
    assert.deepEqual(validateTimeoutEvidence({ CLASS_A_MS: 750 }, { CLASS_A_MS: entry }, { resolveMirror }), []);
  });

  test('a mirror that drifts from its source is reported', () => {
    const entry = { kind: 'mirror', of: { module: 'source-module.cjs', export: 'SOURCE_MS' } };
    const resolveMirror = () => 751;
    const violations = validateTimeoutEvidence({ CLASS_A_MS: 750 }, { CLASS_A_MS: entry }, { resolveMirror });
    assert.deepEqual(rulesOf(violations), ['CLASS_A_MS:mirror-mismatch']);
  });

  test('an unresolvable mirror is reported', () => {
    const entry = { kind: 'mirror', of: { module: 'source-module.cjs', export: 'SOURCE_MS' } };
    const resolvers = [
      () => undefined,
      () => {
        throw new Error('Cannot find module');
      },
    ];
    for (const resolveMirror of resolvers) {
      const violations = validateTimeoutEvidence({ CLASS_A_MS: 750 }, { CLASS_A_MS: entry }, { resolveMirror });
      assert.deepEqual(rulesOf(violations), ['CLASS_A_MS:mirror-unresolvable']);
    }
    const malformed = validateTimeoutEvidence(
      { CLASS_A_MS: 750 },
      { CLASS_A_MS: { kind: 'mirror', of: { module: 'source-module.cjs' } } },
      { resolveMirror: () => 750 },
    );
    assert.deepEqual(rulesOf(malformed), ['CLASS_A_MS:mirror-unresolvable']);
  });

  test('exempt kinds need only a reason', () => {
    const violations = validateTimeoutEvidence(
      { CLASS_A_MS: 1, CLASS_B_MS: 2 },
      {
        CLASS_A_MS: { kind: 'fixture-data', reason: 'value is fixture payload, not a spawn timeout' },
        CLASS_B_MS: { kind: 'test-backstop', reason: 'outer guard around a pathological input' },
      },
    );
    assert.deepEqual(violations, []);
  });

  test('exempt entry without a reason is reported', () => {
    for (const reason of ['', undefined]) {
      for (const kind of ['fixture-data', 'test-backstop']) {
        const entry = reason === undefined ? { kind } : { kind, reason };
        const violations = validateTimeoutEvidence({ CLASS_A_MS: 1 }, { CLASS_A_MS: entry });
        assert.deepEqual(rulesOf(violations), ['CLASS_A_MS:missing-reason'], `${kind} reason=${String(reason)}`);
      }
    }
  });

  test('unknown evidence kind is reported', () => {
    const violations = validateTimeoutEvidence({ CLASS_A_MS: 1 }, { CLASS_A_MS: { kind: 'guess' } });
    assert.deepEqual(rulesOf(violations), ['CLASS_A_MS:unknown-kind']);
  });

  test('non-numeric exports are not treated as constants', () => {
    const exportsLike = {
      CLASS_A_MS: 1000,
      TIMEOUT_EVIDENCE_LIKE: { nested: true },
      helperFn: () => 1,
      NOT_FINITE: Infinity,
      NOT_A_NUMBER: NaN,
      LABEL: 'text',
    };
    const violations = validateTimeoutEvidence(exportsLike, { CLASS_A_MS: measured() });
    assert.deepEqual(violations, []);
  });

  test('every violation is reported, not just the first', () => {
    const violations = validateTimeoutEvidence(
      { CLASS_A_MS: 150, CLASS_B_MS: 5, CLASS_C_MS: 7 },
      {
        CLASS_A_MS: measured(),
        CLASS_C_MS: { kind: 'fixture-data', reason: '' },
        CLASS_Z_MS: { kind: 'test-backstop', reason: 'r' },
      },
    );
    assert.deepEqual(rulesOf(violations), [
      'CLASS_A_MS:margin-below-minimum',
      'CLASS_B_MS:missing-evidence',
      'CLASS_C_MS:missing-reason',
      'CLASS_Z_MS:orphan-evidence',
    ]);
  });

  test('non-object evidence entries are rejected', () => {
    for (const bad of [[], null, 42, 'measured', undefined]) {
      const violations = validateTimeoutEvidence({ CLASS_A_MS: 1000 }, { CLASS_A_MS: bad });
      assert.deepEqual(rulesOf(violations), ['CLASS_A_MS:unknown-kind'], `entry=${JSON.stringify(bad)}`);
    }
  });
});

describe('seam default parity', () => {
  test('SEAM_DEFAULT is the seam\'s own default', () => {
    assert.equal(timeoutsExports.SEAM_DEFAULT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  });
});
