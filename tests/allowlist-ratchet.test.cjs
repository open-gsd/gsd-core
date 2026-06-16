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
  assertFileBaseline,
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

// ─── assertFileBaseline ──────────────────────────────────────────────────────

describe('assertFileBaseline', () => {
  test('exact match: current equals baseline — fail never called', () => {
    const { fail, calls } = makeFail();
    const result = assertFileBaseline({
      label: 'workflow-size',
      current: { 'a.md': 100, 'b.md': 200 },
      baseline: { 'a.md': 100, 'b.md': 200 },
      fail,
    });
    assert.strictEqual(calls.length, 0, 'fail should not be called on an exact match');
    assert.deepStrictEqual(result.grown, []);
    assert.deepStrictEqual(result.shrunk, []);
    assert.deepStrictEqual(result.added, []);
    assert.deepStrictEqual(result.removed, []);
  });

  test('growth: a file larger than baseline — fail called, delta reported', () => {
    const { fail, calls } = makeFail();
    const result = assertFileBaseline({
      label: 'workflow-size',
      current: { 'a.md': 154, 'b.md': 200 },
      baseline: { 'a.md': 100, 'b.md': 200 },
      fail,
    });
    assert.strictEqual(calls.length, 1, 'fail should be called once for growth');
    assert.ok(calls[0].includes('grew') || calls[0].includes('grow'), 'message should describe growth');
    assert.ok(calls[0].includes('a.md'), 'message should name the grown file');
    assert.ok(calls[0].includes('100') && calls[0].includes('154'), 'message should show from → to');
    assert.ok(calls[0].includes('54'), 'message should show the +delta');
    assert.deepStrictEqual(result.grown.map((g) => g.name), ['a.md']);
    assert.strictEqual(result.grown[0].delta, 54);
  });

  test('shrink: a file smaller than baseline — fail called as stale (auto-tighten)', () => {
    const { fail, calls } = makeFail();
    const result = assertFileBaseline({
      label: 'workflow-size',
      current: { 'a.md': 80, 'b.md': 200 },
      baseline: { 'a.md': 100, 'b.md': 200 },
      fail,
    });
    assert.strictEqual(calls.length, 1, 'fail should be called once for a stale (shrunk) baseline');
    assert.ok(/stale|smaller|shrank|shrunk/i.test(calls[0]), 'message should flag a stale/shrunk baseline');
    assert.ok(calls[0].includes('a.md'), 'message should name the shrunk file');
    assert.deepStrictEqual(result.shrunk.map((s) => s.name), ['a.md']);
    assert.strictEqual(result.shrunk[0].delta, 20);
  });

  test('added: a file absent from baseline — fail called', () => {
    const { fail, calls } = makeFail();
    const result = assertFileBaseline({
      label: 'workflow-size',
      current: { 'a.md': 100, 'new.md': 50 },
      baseline: { 'a.md': 100 },
      fail,
    });
    assert.strictEqual(calls.length, 1, 'fail should be called once for an unbaselined new file');
    assert.ok(/not in the baseline|new|missing/i.test(calls[0]), 'message should flag the unbaselined file');
    assert.ok(calls[0].includes('new.md'), 'message should name the new file');
    assert.deepStrictEqual(result.added, ['new.md']);
  });

  test('removed: a baseline entry with no current file — fail called', () => {
    const { fail, calls } = makeFail();
    const result = assertFileBaseline({
      label: 'workflow-size',
      current: { 'a.md': 100 },
      baseline: { 'a.md': 100, 'gone.md': 70 },
      fail,
    });
    assert.strictEqual(calls.length, 1, 'fail should be called once for an orphaned baseline entry');
    assert.ok(/no longer exist|removed|orphan/i.test(calls[0]), 'message should flag the orphaned entry');
    assert.ok(calls[0].includes('gone.md'), 'message should name the orphaned entry');
    assert.deepStrictEqual(result.removed, ['gone.md']);
  });

  test('multiple categories at once — one fail per non-empty category', () => {
    const { fail, calls } = makeFail();
    const result = assertFileBaseline({
      label: 'workflow-size',
      current: { 'grow.md': 150, 'shrink.md': 50, 'new.md': 10 },
      baseline: { 'grow.md': 100, 'shrink.md': 100, 'gone.md': 30 },
      fail,
    });
    // grown(1) + shrunk(1) + added(1) + removed(1) = 4 categories
    assert.strictEqual(calls.length, 4, 'one fail per non-empty category');
    assert.deepStrictEqual(result.grown.map((g) => g.name), ['grow.md']);
    assert.deepStrictEqual(result.shrunk.map((s) => s.name), ['shrink.md']);
    assert.deepStrictEqual(result.added, ['new.md']);
    assert.deepStrictEqual(result.removed, ['gone.md']);
  });

  test('updateHint appears in every failure message', () => {
    const { fail, calls } = makeFail();
    assertFileBaseline({
      label: 'workflow-size',
      current: { 'grow.md': 150, 'new.md': 10 },
      baseline: { 'grow.md': 100, 'gone.md': 30 },
      fail,
      updateHint: 'Run `npm run size:baseline`',
    });
    assert.ok(calls.length >= 2, 'multiple categories should each fail');
    for (const msg of calls) {
      assert.ok(msg.includes('Run `npm run size:baseline`'), 'every message should carry the updateHint');
    }
  });

  test('empty inputs — fail never called', () => {
    const { fail, calls } = makeFail();
    const result = assertFileBaseline({
      label: 'workflow-size',
      current: {},
      baseline: {},
      fail,
    });
    assert.strictEqual(calls.length, 0);
    assert.deepStrictEqual(result.grown, []);
    assert.deepStrictEqual(result.shrunk, []);
    assert.deepStrictEqual(result.added, []);
    assert.deepStrictEqual(result.removed, []);
  });

  test('returned category lists are sorted by name', () => {
    const { fail } = makeFail();
    const result = assertFileBaseline({
      label: 'workflow-size',
      current: { 'z.md': 10, 'a.md': 10, 'm.md': 10 },
      baseline: {},
      fail,
    });
    assert.deepStrictEqual(result.added, ['a.md', 'm.md', 'z.md'], 'added should be sorted');
  });

  test('label appears in failure messages', () => {
    const { fail, calls } = makeFail();
    assertFileBaseline({
      label: 'my-size-guard',
      current: { 'a.md': 200 },
      baseline: { 'a.md': 100 },
      fail,
    });
    assert.ok(calls[0].includes('my-size-guard'), 'label should appear in message');
  });
});
