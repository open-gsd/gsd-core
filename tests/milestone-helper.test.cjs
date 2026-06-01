// Tests for getMilestoneFromPhaseId and getPhaseDirFromPhaseId helpers (issue #39).

'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  getMilestoneFromPhaseId,
  getPhaseDirFromPhaseId,
} = require('../get-shit-done/bin/lib/core.cjs');

// ─── getMilestoneFromPhaseId ────────────────────────────────────────────────

describe('getMilestoneFromPhaseId', () => {
  test('maps milestone integer 1 to v1.0', () => {
    assert.strictEqual(getMilestoneFromPhaseId('1-01'), 'v1.0');
  });

  test('uses only the top-level integer: 2-4-1 → v2.0', () => {
    assert.strictEqual(getMilestoneFromPhaseId('2-4-1'), 'v2.0');
  });

  test('handles double-digit milestone: 10-01 → v10.0', () => {
    assert.strictEqual(getMilestoneFromPhaseId('10-01'), 'v10.0');
  });

  test('returns null for sentinel 999 (backlog)', () => {
    assert.strictEqual(getMilestoneFromPhaseId('999-1'), null);
  });

  test('returns null for sentinel 0 (pre-milestone spike)', () => {
    assert.strictEqual(getMilestoneFromPhaseId('0-1'), null);
  });

  test('returns null when there is no hyphen separator', () => {
    assert.strictEqual(getMilestoneFromPhaseId('1'), null);
  });

  test('strips project_code prefix: CK-2-01 → v2.0', () => {
    assert.strictEqual(getMilestoneFromPhaseId('CK-2-01'), 'v2.0');
  });

  test('strips longer project_code prefix: GSD-10-01 → v10.0', () => {
    assert.strictEqual(getMilestoneFromPhaseId('GSD-10-01'), 'v10.0');
  });

  test('returns null for fully non-numeric input', () => {
    assert.strictEqual(getMilestoneFromPhaseId('invalid'), null);
  });
});

// ─── getPhaseDirFromPhaseId ─────────────────────────────────────────────────

describe('getPhaseDirFromPhaseId', () => {
  test('produces zero-padded dir with project code', () => {
    assert.strictEqual(
      getPhaseDirFromPhaseId('2-01', 'Setup Database', 'GSD'),
      'GSD-02-01-setup-database',
    );
  });

  test('omits project code when not provided', () => {
    assert.strictEqual(
      getPhaseDirFromPhaseId('2-01', 'Setup Database'),
      '02-01-setup-database',
    );
  });

  test('handles double-digit milestone with project code', () => {
    assert.strictEqual(
      getPhaseDirFromPhaseId('10-01', 'Build Feature', 'CK'),
      'CK-10-01-build-feature',
    );
  });

  test('produces zero-padded dir without project code: 1-01 → 01-01-setup', () => {
    assert.strictEqual(
      getPhaseDirFromPhaseId('1-01', 'Setup'),
      '01-01-setup',
    );
  });

  test('returns null for phase IDs without the M-NN hyphen form', () => {
    assert.strictEqual(
      getPhaseDirFromPhaseId('nohyphen', 'Some Title', 'GSD'),
      null,
    );
  });
});
