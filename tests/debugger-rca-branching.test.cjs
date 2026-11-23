'use strict';

// RCA output schema: invariant specification (epic #1957 Phase 2A, #1960).
//
// The repo-text half of this file (the reference, the agent's @-include and reasoning checkpoint, the DEBUG.md
// template field and the philosophy note) is the `debugger-rca-branching` text contract,
// scripts/static-checks/text-contracts/debugger-rca-branching.cjs, run by `npm run lint:ci`. What stays here are the
// pure-JS fixtures that exercise the documented data model: root_causes holds every CONFIRMED candidate (one OR a
// small set: the AND-gate decides whether more than one is kept), eliminated holds the rest, the two never overlap,
// and every candidate lands in exactly one bucket. They are a specification of the schema invariants, not a test of
// production code (which is prompt-level).

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

function assertRcaSchemaInvariants(output) {
  assert.ok(Array.isArray(output.root_causes), 'root_causes must be a list (set-valued)');
  assert.ok(Array.isArray(output.eliminated), 'eliminated must be a list');
  assert.ok(output.root_causes.length >= 1, 'at least one confirmed root cause is required');
  const rootIds = new Set(output.root_causes.map((c) => c.id));
  const elimIds = new Set(output.eliminated.map((c) => c.id));
  for (const id of rootIds) {
    assert.ok(!elimIds.has(id), `cause ${id} appears in BOTH root_causes and eliminated (must be disjoint)`);
  }
  // AND-gate self-consistency: if the gate fired (yes: failure requires >=2 simultaneous conditions), a single
  // confirmed cause cannot fully account for the symptom; investigation is incomplete.
  const andGateYes = /^yes\b/i.test(String(output.and_gate || '').trim());
  if (andGateYes) {
    assert.ok(
      output.root_causes.length >= 2,
      `and_gate=yes requires >=2 confirmed causes (got ${output.root_causes.length}) — single-cause with AND-gate=yes means investigation is incomplete`
    );
  }
}

describe('RCA output schema — invariant specification', () => {
  test('fixture A — two contributing causes (AND-gate yes): both recorded in root_causes', () => {
    const output = {
      // The agent confirmed BOTH causes (AND-gate fired — both required simultaneously).
      root_causes: [
        { id: 'race-condition', category: 'code', evidence: 'two async writers, no lock' },
        { id: 'missing-index', category: 'config', evidence: 'full-table scan under load amplifies the race window' },
      ],
      eliminated: [{ id: 'timezone', category: 'environment', evidence: 'reproduced in UTC too' }],
      and_gate: 'yes — both the race AND the missing index are required to produce the observed corruption',
    };
    assertRcaSchemaInvariants(output);
    assert.strictEqual(output.root_causes.length, 2, 'both contributing causes must be recorded (criterion 1)');
    const cats = new Set(output.root_causes.map((c) => c.category));
    assert.ok(cats.size >= 2, 'the confirmed causes span >=2 categories (branching is real)');
  });

  test('fixture B — single-cause (AND-gate no): one root_cause, identical to today (criterion 2)', () => {
    const output = {
      root_causes: [
        { id: 'off-by-one', category: 'code', evidence: 'loop bound < instead of <=' },
      ],
      eliminated: [
        { id: 'config-default', category: 'config', evidence: 'unchanged in repro' },
        { id: 'env-var', category: 'environment', evidence: 'unset in repro' },
      ],
      and_gate: 'no — the off-by-one alone fully accounts for the symptom',
    };
    assertRcaSchemaInvariants(output);
    assert.strictEqual(output.root_causes.length, 1, 'single-cause session records exactly one root cause (criterion 2: unaffected)');
  });

  test('invariant: a confirmed cause can never also appear in eliminated', () => {
    const bad = {
      root_causes: [{ id: 'x', category: 'code', evidence: 'e' }],
      eliminated: [{ id: 'x', category: 'code', evidence: 'e' }],
      and_gate: 'no',
    };
    assert.throws(() => assertRcaSchemaInvariants(bad), /disjoint/);
  });

  test('invariant: AND-gate=yes with a single confirmed cause is flagged as incomplete', () => {
    const incomplete = {
      root_causes: [{ id: 'only-one', category: 'code', evidence: 'e' }],
      eliminated: [],
      and_gate: 'yes — two conditions required simultaneously',
    };
    assert.throws(() => assertRcaSchemaInvariants(incomplete), />=2/);
  });
});
