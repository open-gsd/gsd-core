'use strict';

/**
 * Behavioral tests for write-set.cjs
 *
 * Module: gsd-core/bin/lib/write-set.cjs
 * Exports: writeSetComplete (Result<T> is a pure type re-exported at compile
 * time only — nothing to assert on it at runtime beyond markdown-table.cjs's
 * own re-export continuing to work, covered by tests/markdown-table.test.cjs).
 *
 * Covers (ADR-2143 §5/§6):
 *   - writeSetComplete happy path: all-applied → true, one-not-applied → false
 *   - BOUNDARY coverage: empty write-set (0 outcomes), single outcome, two outcomes
 *   - an empty write-set is never "complete" (no vacuous-true on a no-op)
 *   - fast-check property: writeSetComplete(ws) === (ws.length > 0 && every applied)
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('./helpers/fast-check-setup.cjs');

const { writeSetComplete } = require('../gsd-core/bin/lib/write-set.cjs');

describe('writeSetComplete', () => {
  test('every surface applied → true', () => {
    assert.equal(
      writeSetComplete([
        { surface: 'checkbox', applied: true },
        { surface: 'traceability', applied: true },
      ]),
      true,
    );
  });

  test('one surface not applied → false (AND across surfaces, never OR)', () => {
    assert.equal(
      writeSetComplete([
        { surface: 'checkbox', applied: true },
        { surface: 'traceability', applied: false },
      ]),
      false,
    );
  });

  test('no surfaces applied → false', () => {
    assert.equal(
      writeSetComplete([
        { surface: 'checkbox', applied: false },
        { surface: 'traceability', applied: false },
      ]),
      false,
    );
  });

  // BOUNDARY: 0 outcomes (limit-1 relative to the smallest real set), 1 outcome
  // (limit), 2 outcomes (limit+1) — the write-set shape has no upper bound, but
  // the meaningful boundary here is "is there anything to be complete about".
  test('BOUNDARY: empty write-set (0 outcomes) is never complete', () => {
    assert.equal(writeSetComplete([]), false,
      'an empty write-set must not vacuously report complete — that would let a ' +
      'no-op masquerade as full success, the exact OR-into-one-flag class ADR-2143 §6 prohibits');
  });

  test('BOUNDARY: single-outcome write-set (1 outcome) — applied true is complete', () => {
    assert.equal(writeSetComplete([{ surface: 'checkbox', applied: true }]), true);
  });

  test('BOUNDARY: single-outcome write-set (1 outcome) — applied false is not complete', () => {
    assert.equal(writeSetComplete([{ surface: 'checkbox', applied: false }]), false);
  });

  test('BOUNDARY: two-outcome write-set (2 outcomes) — both true is complete', () => {
    assert.equal(
      writeSetComplete([
        { surface: 'checkbox', applied: true },
        { surface: 'traceability', applied: true },
      ]),
      true,
    );
  });

  // ─── Property test ───────────────────────────────────────────────────────────

  const outcomeArb = fc.record({
    surface: fc.string({ minLength: 1, maxLength: 12 }),
    applied: fc.boolean(),
  });

  test('property: writeSetComplete(ws) === (ws.length > 0 && every outcome applied)', () => {
    fc.assert(
      fc.property(fc.array(outcomeArb, { maxLength: 8 }), (ws) => {
        const expected = ws.length > 0 && ws.every((o) => o.applied);
        assert.equal(writeSetComplete(ws), expected);
      }),
    );
  });
});
