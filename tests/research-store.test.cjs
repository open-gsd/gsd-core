'use strict';

/**
 * Behavioral tests for research-store.cjs
 *
 * No source-grep. All tests call exported functions and assert on returned objects.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  researchKey,
  ttlForSource,
  resolveStorePath,
  putResearch,
  getResearch,
} = require('../gsd-core/bin/lib/research-store.cjs');

// ---------------------------------------------------------------------------
// Cycle 2: researchKey deterministic + sensitive
// ---------------------------------------------------------------------------

describe('research-store: researchKey deterministic + sensitive', () => {
  const base = { ecosystem: 'npm', library: 'lodash', version: '4.17.21', query: 'chunk', kind: 'docs' };

  test('same inputs produce the same key', () => {
    const k1 = researchKey({ ...base });
    const k2 = researchKey({ ...base });
    assert.equal(k1, k2);
  });

  test('key is a 64-char hex sha256', () => {
    const k = researchKey(base);
    assert.match(k, /^[0-9a-f]{64}$/);
  });

  test('changing ecosystem changes the key', () => {
    assert.notEqual(researchKey({ ...base, ecosystem: 'pypi' }), researchKey(base));
  });

  test('changing library changes the key', () => {
    assert.notEqual(researchKey({ ...base, library: 'underscore' }), researchKey(base));
  });

  test('changing version changes the key', () => {
    assert.notEqual(researchKey({ ...base, version: '3.0.0' }), researchKey(base));
  });

  test('changing query changes the key', () => {
    assert.notEqual(researchKey({ ...base, query: 'merge' }), researchKey(base));
  });

  test('changing kind changes the key', () => {
    assert.notEqual(researchKey({ ...base, kind: 'web' }), researchKey(base));
  });

  test('never throws on arbitrary/missing inputs', () => {
    assert.doesNotThrow(() => researchKey({}));
    assert.doesNotThrow(() => researchKey({ ecosystem: null, library: undefined, version: 42, query: '', kind: false }));
  });
});

// ---------------------------------------------------------------------------
// Cycle 4: getResearch on missing key → {hit:false, stale:false, entry:null}
// ---------------------------------------------------------------------------

describe('research-store: getResearch missing key', () => {
  let tmpCwd;
  let tmpHome;

  beforeEach(() => {
    tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-rs-cwd-'));
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-rs-home-'));
  });

  afterEach(() => {
    fs.rmSync(tmpCwd, { recursive: true, force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  test('returns {hit:false, stale:false, entry:null} for missing key, does not throw', () => {
    assert.doesNotThrow(() => {
      const result = getResearch(tmpCwd, 'nonexistentkey', { homeDir: tmpHome, kind: 'web' });
      assert.equal(result.hit, false);
      assert.equal(result.stale, false);
      assert.equal(result.entry, null);
    });
  });

  test('returns {hit:false} when kind omitted and key absent in both tiers', () => {
    const result = getResearch(tmpCwd, 'nonexistentkey2', { homeDir: tmpHome });
    assert.equal(result.hit, false);
    assert.equal(result.stale, false);
    assert.equal(result.entry, null);
  });
});

// ---------------------------------------------------------------------------
// Cycle 5: getResearch on corrupt entry file → {hit:false, stale:false, entry:null}
// ---------------------------------------------------------------------------

describe('research-store: getResearch corrupt file', () => {
  let tmpCwd;
  let tmpHome;

  beforeEach(() => {
    tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-rs-cwd-'));
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-rs-home-'));
  });

  afterEach(() => {
    fs.rmSync(tmpCwd, { recursive: true, force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  test('returns {hit:false, stale:false, entry:null} on corrupt JSON, does not throw', () => {
    // Write garbage JSON to the expected path for a 'web' kind entry
    const dir = resolveStorePath(tmpCwd, 'web', { homeDir: tmpHome });
    fs.mkdirSync(dir, { recursive: true });
    const corruptKey = 'corruptkey123';
    fs.writeFileSync(path.join(dir, `${corruptKey}.json`), '{');

    assert.doesNotThrow(() => {
      const result = getResearch(tmpCwd, corruptKey, { homeDir: tmpHome, kind: 'web' });
      assert.equal(result.hit, false);
      assert.equal(result.stale, false);
      assert.equal(result.entry, null);
    });
  });
});

// ---------------------------------------------------------------------------
// Cycle 6: ttlForSource policy — 30d / 7d / 1d
// ---------------------------------------------------------------------------

describe('research-store: ttlForSource policy', () => {
  const DAY_MS = 86_400_000;

  test('curated + HIGH → 30 days', () => {
    assert.equal(ttlForSource('curated', 'HIGH'), 30 * DAY_MS);
  });

  test('curated + MEDIUM → 7 days', () => {
    assert.equal(ttlForSource('curated', 'MEDIUM'), 7 * DAY_MS);
  });

  test('web source → 1 day (regardless of confidence)', () => {
    assert.equal(ttlForSource('web', 'HIGH'), DAY_MS);
  });

  test('confidence LOW → 1 day (regardless of source)', () => {
    assert.equal(ttlForSource('curated', 'LOW'), DAY_MS);
  });

  test('default (unknown source + confidence) → 1 day', () => {
    assert.equal(ttlForSource('unknown', 'UNKNOWN'), DAY_MS);
  });
});

// ---------------------------------------------------------------------------
// Cycle 7: STALENESS BOUNDARY (clock seam)
// Put at clock now=0; ttl = 30d (curated/HIGH = 2592000000ms)
// now = ttl-1 → stale:false
// now = ttl   → stale:false  (strict >; equal is NOT stale)
// now = ttl+1 → stale:true
// ---------------------------------------------------------------------------

describe('research-store: staleness boundary (clock seam)', () => {
  const DAY_MS = 86_400_000;
  const TTL_30D = 30 * DAY_MS;
  let tmpCwd;
  let tmpHome;

  beforeEach(() => {
    tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-rs-cwd-'));
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-rs-home-'));
  });

  afterEach(() => {
    fs.rmSync(tmpCwd, { recursive: true, force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  function putAtZero(cwd, home, key) {
    const clockZero = { now: () => 0 };
    putResearch(
      cwd,
      key,
      { content: 'data', source: 'curated', provider: 'p', confidence: 'HIGH', kind: 'docs' },
      { clock: clockZero, homeDir: home }
    );
  }

  test('now = ttl-1 → stale:false', () => {
    const key = researchKey({ ecosystem: 'x', kind: 'docs', query: 'ttl-minus-1' });
    putAtZero(tmpCwd, tmpHome, key);
    const result = getResearch(tmpCwd, key, { clock: { now: () => TTL_30D - 1 }, homeDir: tmpHome, kind: 'docs' });
    assert.equal(result.hit, true);
    assert.equal(result.stale, false, 'age = ttl-1 should NOT be stale');
  });

  test('now = ttl → stale:false (strict > boundary: equal is not stale)', () => {
    const key = researchKey({ ecosystem: 'x', kind: 'docs', query: 'ttl-exact' });
    putAtZero(tmpCwd, tmpHome, key);
    const result = getResearch(tmpCwd, key, { clock: { now: () => TTL_30D }, homeDir: tmpHome, kind: 'docs' });
    assert.equal(result.hit, true);
    assert.equal(result.stale, false, 'age = ttl exactly should NOT be stale (strict >)');
  });

  test('now = ttl+1 → stale:true', () => {
    const key = researchKey({ ecosystem: 'x', kind: 'docs', query: 'ttl-plus-1' });
    putAtZero(tmpCwd, tmpHome, key);
    const result = getResearch(tmpCwd, key, { clock: { now: () => TTL_30D + 1 }, homeDir: tmpHome, kind: 'docs' });
    assert.equal(result.hit, true);
    assert.equal(result.stale, true, 'age = ttl+1 should be stale');
  });
});

// ---------------------------------------------------------------------------
// Cycle 8: resolveStorePath tiers
// ---------------------------------------------------------------------------

describe('research-store: resolveStorePath tiers', () => {
  const FAKE_HOME = '/fake/home';
  const FAKE_CWD = '/fake/cwd';

  test("kind 'docs' (curated) → under injected homeDir/.gsd/research-cache", () => {
    const p = resolveStorePath(FAKE_CWD, 'docs', { homeDir: FAKE_HOME });
    assert.equal(p, path.join(FAKE_HOME, '.gsd', 'research-cache'));
  });

  test("kind 'web' (project) → under cwd/.planning/research/.cache", () => {
    const p = resolveStorePath(FAKE_CWD, 'web', { homeDir: FAKE_HOME });
    assert.equal(p, path.join(FAKE_CWD, '.planning', 'research', '.cache'));
  });

  test("kind 'synthesis' (project) → under cwd/.planning/research/.cache", () => {
    const p = resolveStorePath(FAKE_CWD, 'synthesis', { homeDir: FAKE_HOME });
    assert.equal(p, path.join(FAKE_CWD, '.planning', 'research', '.cache'));
  });

  test("kind 'legitimacy' (project) → under cwd/.planning/research/.cache", () => {
    const p = resolveStorePath(FAKE_CWD, 'legitimacy', { homeDir: FAKE_HOME });
    assert.equal(p, path.join(FAKE_CWD, '.planning', 'research', '.cache'));
  });

  test('paths are absolute', () => {
    const docs = resolveStorePath(FAKE_CWD, 'docs', { homeDir: FAKE_HOME });
    const web = resolveStorePath(FAKE_CWD, 'web', { homeDir: FAKE_HOME });
    assert.ok(path.isAbsolute(docs));
    assert.ok(path.isAbsolute(web));
  });
});

// ---------------------------------------------------------------------------
// Cycle 1: TRACER BULLET — round-trip put then get
// ---------------------------------------------------------------------------

describe('research-store: tracer bullet round-trip', () => {
  let tmpCwd;
  let tmpHome;

  beforeEach(() => {
    tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-rs-cwd-'));
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-rs-home-'));
  });

  afterEach(() => {
    fs.rmSync(tmpCwd, { recursive: true, force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  test('put then get returns hit:true, stale:false, entry with content preserved', () => {
    const fixedClock = { now: () => 0 };
    const key = researchKey({ ecosystem: 'npm', library: 'lodash', version: '4.17.21', query: 'chunk', kind: 'docs' });

    const stored = putResearch(
      tmpCwd,
      key,
      { content: 'lodash chunk docs', source: 'curated', provider: 'npm', confidence: 'HIGH', kind: 'docs' },
      { clock: fixedClock, homeDir: tmpHome }
    );

    assert.equal(stored.content, 'lodash chunk docs', 'putResearch returns entry with content');

    const result = getResearch(tmpCwd, key, { clock: fixedClock, homeDir: tmpHome, kind: 'docs' });

    assert.equal(result.hit, true, 'hit should be true');
    assert.equal(result.stale, false, 'stale should be false at time 0');
    assert.ok(result.entry !== null, 'entry should not be null');
    assert.equal(result.entry.content, 'lodash chunk docs', 'content preserved');
    assert.equal(result.entry.source, 'curated');
    assert.equal(result.entry.confidence, 'HIGH');
  });
});
