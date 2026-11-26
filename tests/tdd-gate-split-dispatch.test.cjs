'use strict';

/**
 * #4696 — execute-phase splits a `type: tdd` plan into a RED dispatch and a GREEN/REFACTOR dispatch when the
 * two gates resolve to different models. The orchestrator is a workflow, so the contract is its shipped text.
 * Behavior of the model resolution is pinned in tdd-gate-model-overrides.test.cjs.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const EXECUTE_PHASE = 'gsd-core/workflows/execute-phase.md';
const SPLIT_STEP = 'gsd-core/workflows/execute-phase/steps/tdd-gate-split-dispatch.md';
const GATE_REF = 'gsd-core/references/tdd-gate-dispatch.md';
const EXECUTOR = 'agents/gsd-executor.md';

function read(rel) {
  // allow-test-rule: source-text-is-the-product (#4696) — shipped workflow and reference text is what the orchestrator loads
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

describe('#4696 execute-phase split dispatch step', () => {
  test('execute-phase step 3 points at the split step', () => {
    assert.ok(read(EXECUTE_PHASE).includes('execute-phase/steps/tdd-gate-split-dispatch.md'));
  });

  test('the split predicate names all three conditions', () => {
    const text = read(SPLIT_STEP);
    assert.ok(text.includes('TDD_MODE'), 'TDD_MODE');
    assert.ok(text.includes('phase.tdd-applicable'), 'plan type is read through phase.tdd-applicable');
    assert.ok(text.includes('plan_type'), 'plan_type');
    assert.ok(/differ/i.test(text), 'models must differ');
  });

  test('both gate models resolve through the gate keys with the executor as fallback', () => {
    const text = read(SPLIT_STEP);
    assert.ok(text.includes(':tdd-red'));
    assert.ok(text.includes(':tdd-green-refactor'));
    assert.ok(text.includes('--fallback-agent "$EXECUTOR_TYPE"'));
  });

  test('a split plan is forced in-tree before each dispatch', () => {
    const text = read(SPLIT_STEP);
    assert.ok(text.includes('--force-isolation none'));
  });

  test('a RED commit is verified before the GREEN dispatch, and its absence halts', () => {
    const text = read(SPLIT_STEP);
    assert.ok(text.includes('test({phase}-{plan})') || text.includes('test(${PHASE}-${PLAN})'));
    assert.ok(/halt/i.test(text));
  });

  test('non-Agent backends keep the single dispatch', () => {
    const text = read(SPLIT_STEP);
    assert.ok(text.includes('orchestrator-worktree'));
    assert.ok(text.includes('executor_runtime'));
  });

  test('a failed model resolve keeps the single dispatch', () => {
    const text = read(SPLIT_STEP);
    assert.ok(/single dispatch/i.test(text));
    assert.ok(text.includes('EXECUTOR_MODEL_SOURCE'));
  });

  test('the default dispatch template still carries model="{executor_model}"', () => {
    assert.ok(read(EXECUTE_PHASE).includes('model="{executor_model}"'));
  });
});

describe('#4696 gate dispatch reference', () => {
  test('RED dispatch writes no SUMMARY and no implementation; GREEN dispatch never reruns RED', () => {
    const text = read(GATE_REF);
    assert.ok(text.includes('TDD_GATE=red'));
    assert.ok(text.includes('TDD_GATE=green-refactor'));
    assert.ok(/SUMMARY\.md/.test(text));
    assert.ok(/never (re-?run|repeat)/i.test(text));
  });

  test('the executor agent carries no restatement of the gate dispatch', () => {
    const agent = read(EXECUTOR);
    assert.ok(!agent.includes('TDD_GATE=red'));
    assert.ok(!agent.includes('TDD_GATE=green-refactor'));
  });
});
