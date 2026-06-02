'use strict';

/**
 * Characterization tests for the deterministic clock seam module.
 * Locks the realClock export shape and GSD_NOW_MS / GSD_TEST_MODE pinning.
 */
const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { realClock } = require('../get-shit-done/bin/lib/clock.cjs');

describe('realClock export shape', () => {
  test('exports realClock object with now, nowIso, today, sleep', () => {
    assert.equal(typeof realClock.now, 'function');
    assert.equal(typeof realClock.nowIso, 'function');
    assert.equal(typeof realClock.today, 'function');
    assert.equal(typeof realClock.sleep, 'function');
  });
});

describe('realClock.now()', () => {
  let savedTestMode;
  let savedNowMs;

  beforeEach(() => {
    savedTestMode = process.env.GSD_TEST_MODE;
    savedNowMs = process.env.GSD_NOW_MS;
    delete process.env.GSD_TEST_MODE;
    delete process.env.GSD_NOW_MS;
  });

  afterEach(() => {
    if (savedTestMode === undefined) delete process.env.GSD_TEST_MODE;
    else process.env.GSD_TEST_MODE = savedTestMode;
    if (savedNowMs === undefined) delete process.env.GSD_NOW_MS;
    else process.env.GSD_NOW_MS = savedNowMs;
  });

  test('returns a number close to Date.now() in production mode', () => {
    const before = Date.now();
    const result = realClock.now();
    const after = Date.now();
    assert.ok(typeof result === 'number');
    assert.ok(result >= before && result <= after);
  });

  test('uses pinned GSD_NOW_MS when GSD_TEST_MODE is set', () => {
    process.env.GSD_TEST_MODE = '1';
    process.env.GSD_NOW_MS = '1749000000000';
    assert.strictEqual(realClock.now(), 1749000000000);
  });

  test('ignores GSD_NOW_MS when GSD_TEST_MODE is absent', () => {
    delete process.env.GSD_TEST_MODE;
    process.env.GSD_NOW_MS = '1749000000000';
    const result = realClock.now();
    // Should NOT be the pinned value
    assert.notEqual(result, 1749000000000);
  });

  test('rejects float GSD_NOW_MS and falls back to Date.now()', () => {
    process.env.GSD_TEST_MODE = '1';
    process.env.GSD_NOW_MS = '12.5';
    const before = Date.now();
    const result = realClock.now();
    const after = Date.now();
    assert.ok(result >= before && result <= after);
  });

  test('rejects scientific notation GSD_NOW_MS and falls back', () => {
    process.env.GSD_TEST_MODE = '1';
    process.env.GSD_NOW_MS = '1e10';
    const before = Date.now();
    const result = realClock.now();
    const after = Date.now();
    assert.ok(result >= before && result <= after);
  });

  test('rejects empty GSD_NOW_MS and falls back', () => {
    process.env.GSD_TEST_MODE = '1';
    process.env.GSD_NOW_MS = '';
    const before = Date.now();
    const result = realClock.now();
    const after = Date.now();
    assert.ok(result >= before && result <= after);
  });
});

describe('realClock.nowIso()', () => {
  let savedTestMode;
  let savedNowMs;

  beforeEach(() => {
    savedTestMode = process.env.GSD_TEST_MODE;
    savedNowMs = process.env.GSD_NOW_MS;
    process.env.GSD_TEST_MODE = '1';
    process.env.GSD_NOW_MS = '1749000000000';
  });

  afterEach(() => {
    if (savedTestMode === undefined) delete process.env.GSD_TEST_MODE;
    else process.env.GSD_TEST_MODE = savedTestMode;
    if (savedNowMs === undefined) delete process.env.GSD_NOW_MS;
    else process.env.GSD_NOW_MS = savedNowMs;
  });

  test('returns ISO 8601 string from pinned now()', () => {
    const result = realClock.nowIso();
    assert.equal(typeof result, 'string');
    assert.ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(result));
    assert.equal(result, new Date(1749000000000).toISOString());
  });
});

describe('realClock.today()', () => {
  let savedTestMode;
  let savedNowMs;

  beforeEach(() => {
    savedTestMode = process.env.GSD_TEST_MODE;
    savedNowMs = process.env.GSD_NOW_MS;
    process.env.GSD_TEST_MODE = '1';
    process.env.GSD_NOW_MS = '1749000000000';
  });

  afterEach(() => {
    if (savedTestMode === undefined) delete process.env.GSD_TEST_MODE;
    else process.env.GSD_TEST_MODE = savedTestMode;
    if (savedNowMs === undefined) delete process.env.GSD_NOW_MS;
    else process.env.GSD_NOW_MS = savedNowMs;
  });

  test('returns YYYY-MM-DD from pinned now()', () => {
    const result = realClock.today();
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(result));
    const expected = new Date(1749000000000).toISOString().split('T')[0];
    assert.equal(result, expected);
  });
});
