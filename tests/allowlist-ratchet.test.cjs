'use strict';

/**
 * Tests for scripts/lib/allowlist-ratchet.cjs
 *
 * Covers assertWithinAllowlist and assertTightCeiling.
 * Uses a non-throwing fake `fail` that records messages into an array so we can
 * assert on call count and message content without early-exit on first failure.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  assertWithinAllowlist,
  assertTightCeiling,
} = require('../scripts/lib/allowlist-ratchet.cjs');

// ─── Fake fail helper ────────────────────────────────────────────────────────

/**
 * Returns a { fail, calls } pair.  `fail` records its message without throwing,
 * so tests can observe every violation rather than stopping at the first.
 */
function makeFail() {
  const calls = [];
  return {
    calls,
    fail(msg) {
      calls.push(msg);
    },
  };
}

// ─── assertWithinAllowlist ───────────────────────────────────────────────────

describe('assertWithinAllowlist', () => {
  test('clean case: current subset of known, no stale entries — fail never called', () => {
    const { fail, calls } = makeFail();
    const result = assertWithinAllowlist({
      label: 'test-guard',
      current: ['a.ts', 'b.ts'],
      known: ['a.ts', 'b.ts'],
      fail,
    });
    assert.strictEqual(calls.length, 0, 'fail should not be called');
    assert.deepStrictEqual(result.novel, []);
    assert.deepStrictEqual(result.stale, []);
  });

  test('novel detected: id in current but not in known — fail called with that id', () => {
    const { fail, calls } = makeFail();
    const result = assertWithinAllowlist({
      label: 'novel-guard',
      current: ['a.ts', 'b.ts', 'c.ts'],
      known: ['a.ts', 'b.ts'],
      fail,
    });
    assert.strictEqual(calls.length, 1, 'fail should be called once for novel');
    assert.ok(calls[0].includes('c.ts'), 'message should mention the novel id');
    assert.ok(
      calls[0].includes('fix at the source'),
      'message should include fix-at-source guidance'
    );
    assert.deepStrictEqual(result.novel, ['c.ts']);
    assert.deepStrictEqual(result.stale, []);
  });

  test('stale detected: id in known but not in current — fail called with that id', () => {
    const { fail, calls } = makeFail();
    const result = assertWithinAllowlist({
      label: 'stale-guard',
      current: ['a.ts'],
      known: ['a.ts', 'b.ts'],
      fail,
    });
    assert.strictEqual(calls.length, 1, 'fail should be called once for stale');
    assert.ok(calls[0].includes('b.ts'), 'message should mention the stale id');
    assert.ok(
      calls[0].includes('ratchets toward zero'),
      'message should include ratchet-toward-zero language'
    );
    assert.deepStrictEqual(result.novel, []);
    assert.deepStrictEqual(result.stale, ['b.ts']);
  });

  test('stale message includes pruneHint when provided', () => {
    const { fail, calls } = makeFail();
    assertWithinAllowlist({
      label: 'prune-guard',
      current: ['a.ts'],
      known: ['a.ts', 'b.ts'],
      fail,
      pruneHint: 'edit scripts/my-allowlist.json',
    });
    assert.ok(
      calls[0].includes('edit scripts/my-allowlist.json'),
      'message should include the pruneHint'
    );
  });

  test('both novel and stale at once — fail called twice', () => {
    const { fail, calls } = makeFail();
    const result = assertWithinAllowlist({
      label: 'both-guard',
      current: ['a.ts', 'c.ts'],  // c.ts is new, b.ts is fixed
      known: ['a.ts', 'b.ts'],
      fail,
    });
    assert.strictEqual(calls.length, 2, 'fail should be called once for novel and once for stale');
    const allMessages = calls.join('\n');
    assert.ok(allMessages.includes('c.ts'), 'should mention novel id c.ts');
    assert.ok(allMessages.includes('b.ts'), 'should mention stale id b.ts');
    assert.deepStrictEqual(result.novel, ['c.ts']);
    assert.deepStrictEqual(result.stale, ['b.ts']);
  });

  test('empty inputs — fail never called', () => {
    const { fail, calls } = makeFail();
    const result = assertWithinAllowlist({
      label: 'empty-guard',
      current: [],
      known: [],
      fail,
    });
    assert.strictEqual(calls.length, 0);
    assert.deepStrictEqual(result.novel, []);
    assert.deepStrictEqual(result.stale, []);
  });

  test('order-independence: Sets and arrays produce the same result', () => {
    const callsArr = makeFail();
    const callsSet = makeFail();

    const resultArr = assertWithinAllowlist({
      label: 'order-array',
      current: ['z.ts', 'a.ts', 'm.ts'],
      known: ['a.ts', 'm.ts'],
      fail: callsArr.fail,
    });

    const resultSet = assertWithinAllowlist({
      label: 'order-set',
      current: new Set(['z.ts', 'a.ts', 'm.ts']),
      known: new Set(['a.ts', 'm.ts']),
      fail: callsSet.fail,
    });

    assert.deepStrictEqual(resultArr.novel, resultSet.novel, 'novel should be identical regardless of input type');
    assert.deepStrictEqual(resultArr.stale, resultSet.stale, 'stale should be identical regardless of input type');
    assert.deepStrictEqual(resultArr.novel, ['z.ts'], 'novel should be sorted');
  });

  test('returned novel and stale arrays are sorted', () => {
    const { fail } = makeFail();
    const result = assertWithinAllowlist({
      label: 'sort-guard',
      current: ['z.ts', 'a.ts', 'm.ts', 'new.ts'],
      known: ['z.ts', 'a.ts', 'm.ts', 'old.ts'],
      fail,
    });
    assert.deepStrictEqual(result.novel, ['new.ts']);
    assert.deepStrictEqual(result.stale, ['old.ts']);
  });

  test('current empty, known non-empty — all known are stale', () => {
    const { fail, calls } = makeFail();
    const result = assertWithinAllowlist({
      label: 'all-stale',
      current: [],
      known: ['a.ts', 'b.ts'],
      fail,
    });
    assert.strictEqual(calls.length, 1);
    assert.deepStrictEqual(result.stale, ['a.ts', 'b.ts']);
    assert.deepStrictEqual(result.novel, []);
  });

  test('known empty, current non-empty — all current are novel', () => {
    const { fail, calls } = makeFail();
    const result = assertWithinAllowlist({
      label: 'all-novel',
      current: ['a.ts', 'b.ts'],
      known: [],
      fail,
    });
    assert.strictEqual(calls.length, 1);
    assert.deepStrictEqual(result.novel, ['a.ts', 'b.ts']);
    assert.deepStrictEqual(result.stale, []);
  });
});

// ─── assertTightCeiling ──────────────────────────────────────────────────────

describe('assertTightCeiling', () => {
  test('actualMax under ceiling within grace — ok, fail never called', () => {
    const { fail, calls } = makeFail();
    const result = assertTightCeiling({
      label: 'size-guard',
      actualMax: 90,
      ceiling: 100,
      grace: 15,
      fail,
    });
    assert.strictEqual(calls.length, 0, 'fail should not be called');
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.slack, 10);
  });

  test('actualMax over ceiling — fail called with regression message', () => {
    const { fail, calls } = makeFail();
    const result = assertTightCeiling({
      label: 'size-guard',
      actualMax: 110,
      ceiling: 100,
      grace: 5,
      fail,
    });
    assert.strictEqual(calls.length, 1, 'fail should be called once');
    assert.ok(calls[0].includes('Regression'), 'message should say Regression');
    assert.ok(calls[0].includes('110'), 'message should include actualMax');
    assert.ok(calls[0].includes('100'), 'message should include ceiling');
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.slack, -10);
  });

  test('ceiling too loose (slack > grace) — fail called with tighten message', () => {
    const { fail, calls } = makeFail();
    const result = assertTightCeiling({
      label: 'loose-guard',
      actualMax: 50,
      ceiling: 100,
      grace: 10,
      fail,
    });
    assert.strictEqual(calls.length, 1, 'fail should be called once');
    assert.ok(
      calls[0].toLowerCase().includes('tighten') || calls[0].includes('too far'),
      'message should mention tightening'
    );
    assert.ok(calls[0].includes('Budgets may only decrease'), 'message should include budget policy');
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.slack, 50);
  });

  test('boundary: slack === grace — ok (exactly at the grace limit)', () => {
    const { fail, calls } = makeFail();
    const result = assertTightCeiling({
      label: 'boundary-guard',
      actualMax: 90,
      ceiling: 100,
      grace: 10,
      fail,
    });
    assert.strictEqual(calls.length, 0, 'fail should not be called at exact grace boundary');
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.slack, 10);
  });

  test('actualMax equals ceiling — ok, slack is zero', () => {
    const { fail, calls } = makeFail();
    const result = assertTightCeiling({
      label: 'exact-guard',
      actualMax: 100,
      ceiling: 100,
      grace: 0,
      fail,
    });
    assert.strictEqual(calls.length, 0);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.slack, 0);
  });

  test('grace 0: any slack triggers fail', () => {
    const { fail, calls } = makeFail();
    assertTightCeiling({
      label: 'tight-guard',
      actualMax: 99,
      ceiling: 100,
      grace: 0,
      fail,
    });
    assert.strictEqual(calls.length, 1, 'any slack above 0 should fail when grace is 0');
  });

  test('label appears in failure messages', () => {
    const { fail, calls } = makeFail();
    assertTightCeiling({
      label: 'my-special-guard',
      actualMax: 200,
      ceiling: 100,
      grace: 5,
      fail,
    });
    assert.ok(calls[0].includes('my-special-guard'), 'label should appear in message');
  });
});
