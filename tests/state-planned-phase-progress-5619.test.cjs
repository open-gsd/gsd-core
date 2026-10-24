'use strict';

/**
 * #5619 — `state.planned-phase` writes its progress block through the `progress-ratchet` merge with
 * `deriveProgressKeys: true` (src/state.cts cmdStatePlannedPhase). That arm compared completed counters
 * with `typeof === 'number'`, but parsed frontmatter scalars are STRINGS ("2", not 2): both sides read as
 * -Infinity, the #2969 ratchet-up never fired, and `percent` kept the disk-derived value beside the
 * stored counters, so a block like 1/2 phases, 1/2 plans could be written at 0%.
 *
 * Every fixture here uses the string spelling production emits; the numeric spelling is covered by
 * tests/state-transition.test.cjs and cross-checked in one row below.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('./helpers/fast-check-setup.cjs');

const {
  applyStatePreservation,
  openStateTransaction,
  FIELD_CLASSIFICATION,
} = require('../gsd-core/bin/lib/state-transition.cjs');
const { computeProgressPercent, toFiniteNumber } = require('../gsd-core/bin/lib/state-document.cjs');
const { SCOPE } = require('../gsd-core/bin/lib/planning-scope.cjs');

/** Every preserve-when-unchanged field wired as "unchanged this write", so only `progress` is probed. */
function neutralBodyDeltas() {
  const deltas = {};
  for (const [field, cls] of Object.entries(FIELD_CLASSIFICATION)) {
    if (cls.preservation === 'preserve-when-unchanged') {
      deltas[field] = { pre: 'unchanged-source', post: 'unchanged-source' };
    }
  }
  return deltas;
}

/** The progress block `state.planned-phase` leaves: `curated` is the stored block, `derived` the disk scan. */
function plannedPhaseMerge(curated, derived, { deriveProgressKeys = true } = {}) {
  const transaction = openStateTransaction({
    snapshot: { progress: curated },
    resync: false,
    ...(deriveProgressKeys ? { deriveProgressKeys: true } : {}),
    bodyDeltas: neutralBodyDeltas(),
  });
  return applyStatePreservation({ transaction, postFm: { progress: derived } }).postFm.progress;
}

function percentOf(block) {
  return computeProgressPercent(
    toFiniteNumber(block.completed_plans),
    toFiniteNumber(block.total_plans),
    toFiniteNumber(block.completed_phases),
    toFiniteNumber(block.total_phases),
    SCOPE.COMPLETE,
  );
}

describe('state.planned-phase progress merge on string-valued frontmatter (#5619)', () => {
  test('stored counters above derived: percent follows the written counters (#5619)', () => {
    const written = plannedPhaseMerge(
      { total_plans: '2', completed_plans: '1', total_phases: '2', completed_phases: '1', percent: '50' },
      { total_plans: '2', completed_plans: '0', total_phases: '2', completed_phases: '0', percent: 0 },
    );
    assert.equal(toFiniteNumber(written.completed_plans), 1, 'the stored counter is kept');
    assert.equal(toFiniteNumber(written.completed_phases), 1, 'the stored counter is kept');
    assert.equal(toFiniteNumber(written.percent), percentOf(written), 'percent is computed over the counters written');
    assert.equal(toFiniteNumber(written.percent), 50);
  });

  test('a derived completed_plans above stored ratchets up on string scalars (#5619)', () => {
    const written = plannedPhaseMerge(
      { total_plans: '3', completed_plans: '0', total_phases: '0', completed_phases: '0', percent: '0' },
      { total_plans: '3', completed_plans: '1', total_phases: '0', completed_phases: '0', percent: 33 },
    );
    assert.equal(toFiniteNumber(written.completed_plans), 1, 'the larger on-disk count is written');
    assert.equal(toFiniteNumber(written.percent), percentOf(written), 'percent follows the ratcheted counter');
  });

  test('a derived count below stored never lowers a counter (#5619)', () => {
    const written = plannedPhaseMerge(
      { total_plans: '54', completed_plans: '50', total_phases: '2', completed_phases: '1', percent: '50' },
      { total_plans: '54', completed_plans: '47', total_phases: '2', completed_phases: '1', percent: 50 },
    );
    assert.equal(written.completed_plans, '50');
    assert.equal(toFiniteNumber(written.percent), percentOf(written));
  });

  test('an equal count keeps the stored value and spelling (#5619)', () => {
    const written = plannedPhaseMerge(
      { total_plans: '4', completed_plans: '2', total_phases: '1', completed_phases: '0', percent: '0' },
      { total_plans: '4', completed_plans: 2, total_phases: '1', completed_phases: 0, percent: 0 },
    );
    assert.strictEqual(written.completed_plans, '2', 'the stored string spelling stands on a tie');
  });

  test('ratchet boundary: below, at, above the stored count (#5619)', () => {
    const stored = 5;
    for (const [derivedCount, expected] of [[stored - 1, stored], [stored, stored], [stored + 1, stored + 1]]) {
      const written = plannedPhaseMerge(
        { total_plans: '9', completed_plans: String(stored), total_phases: '0', completed_phases: '0', percent: '55' },
        { total_plans: '9', completed_plans: String(derivedCount), total_phases: '0', completed_phases: '0', percent: 50 },
      );
      assert.equal(toFiniteNumber(written.completed_plans), expected, `derived ${derivedCount} against stored ${stored}`);
      assert.equal(toFiniteNumber(written.percent), percentOf(written), `percent coherent at derived ${derivedCount}`);
    }
  });

  test('a withheld derived percent stays withheld (#5619)', () => {
    const written = plannedPhaseMerge(
      { total_plans: '2', completed_plans: '1', total_phases: '2', completed_phases: '1', percent: '50' },
      { total_plans: '2', completed_plans: '0', total_phases: '2', completed_phases: '0' },
    );
    assert.equal('percent' in written, false, 'no percent is invented when the derivation withheld one');
  });

  test('numeric and string scalars give the same merge (#5619)', () => {
    const asNumbers = plannedPhaseMerge(
      { total_plans: 3, completed_plans: 0, total_phases: 0, completed_phases: 0, percent: 0 },
      { total_plans: 3, completed_plans: 1, total_phases: 0, completed_phases: 0, percent: 33 },
    );
    const asStrings = plannedPhaseMerge(
      { total_plans: '3', completed_plans: '0', total_phases: '0', completed_phases: '0', percent: '0' },
      { total_plans: '3', completed_plans: '1', total_phases: '0', completed_phases: '0', percent: 33 },
    );
    assert.equal(toFiniteNumber(asNumbers.completed_plans), toFiniteNumber(asStrings.completed_plans));
    assert.equal(toFiniteNumber(asNumbers.percent), toFiniteNumber(asStrings.percent));
  });

  test('totals take the derived value in both directions (#5619)', () => {
    const grown = plannedPhaseMerge(
      { total_plans: '2', completed_plans: '2', total_phases: '1', completed_phases: '1', percent: '100' },
      { total_plans: '4', completed_plans: '2', total_phases: '1', completed_phases: '1', percent: 50 },
    );
    assert.equal(toFiniteNumber(grown.total_plans), 4);
    const shrunk = plannedPhaseMerge(
      { total_plans: '6', completed_plans: '2', total_phases: '1', completed_phases: '0', percent: '0' },
      { total_plans: '3', completed_plans: '2', total_phases: '1', completed_phases: '0', percent: 0 },
    );
    assert.equal(toFiniteNumber(shrunk.total_plans), 3);
  });

  test('a body-only write still restores progress wholesale (#5619)', () => {
    const curated = { total_plans: '54', completed_plans: '50', percent: '93' };
    const written = plannedPhaseMerge(curated, { total_plans: '54', completed_plans: '54', percent: 100 }, { deriveProgressKeys: false });
    assert.deepEqual(written, curated, 'without the derive flag the stored block is restored as it was');
  });

  test('percent is coherent with the written counters for any counters (#5619)', () => {
    const spelled = fc.boolean();
    const count = fc.integer({ min: 0, max: 40 });
    fc.assert(
      fc.property(count, count, fc.integer({ min: 1, max: 40 }), spelled, spelled,
        (storedPlans, derivedPlans, totalPlans, storedAsString, derivedAsString) => {
          const totalPhases = 0; // no phase data: percent is the plan fraction alone
          const spell = (n, asString) => (asString ? String(n) : n);
          const storedDone = Math.min(storedPlans, totalPlans);
          const derivedDone = Math.min(derivedPlans, totalPlans);
          const written = plannedPhaseMerge(
            { total_plans: spell(totalPlans, storedAsString), completed_plans: spell(storedDone, storedAsString), total_phases: spell(totalPhases, storedAsString), completed_phases: spell(0, storedAsString), percent: spell(0, storedAsString) },
            { total_plans: spell(totalPlans, derivedAsString), completed_plans: spell(derivedDone, derivedAsString), total_phases: spell(totalPhases, derivedAsString), completed_phases: spell(0, derivedAsString), percent: 0 },
          );
          assert.equal(toFiniteNumber(written.completed_plans), Math.max(storedDone, derivedDone));
          assert.equal(toFiniteNumber(written.percent), percentOf(written));
        }),
    );
  });
});
