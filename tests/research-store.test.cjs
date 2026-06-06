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
const { cleanup } = require('./helpers.cjs');

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
    cleanup(tmpCwd);
    cleanup(tmpHome);
  });

  test('returns {hit:false, stale:false, entry:null} for missing key, does not throw', () => {
    assert.doesNotThrow(() => {
      const result = getResearch(tmpCwd, 'nonexistentkey', { homeDir: tmpHome });
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
    cleanup(tmpCwd);
    cleanup(tmpHome);
  });

  test('returns {hit:false, stale:false, entry:null} on corrupt JSON, does not throw', () => {
    // Write garbage JSON to the expected path for a 'web' source (project tier)
    const dir = resolveStorePath(tmpCwd, 'web', { homeDir: tmpHome });
    fs.mkdirSync(dir, { recursive: true });
    const corruptKey = 'corruptkey123';
    fs.writeFileSync(path.join(dir, `${corruptKey}.json`), '{');

    assert.doesNotThrow(() => {
      const result = getResearch(tmpCwd, corruptKey, { homeDir: tmpHome });
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
    cleanup(tmpCwd);
    cleanup(tmpHome);
  });

  function putAtZero(cwd, home, key) {
    const clockZero = { now: () => 0 };
    // version:'4.17.21' prevents the blank-version TTL cap so TTL stays at 30d
    putResearch(
      cwd,
      key,
      { content: 'data', source: 'curated', provider: 'p', confidence: 'HIGH', kind: 'docs', version: '4.17.21' },
      { clock: clockZero, homeDir: home }
    );
  }

  test('now = ttl-1 → stale:false', () => {
    const key = researchKey({ ecosystem: 'x', kind: 'docs', query: 'ttl-minus-1' });
    putAtZero(tmpCwd, tmpHome, key);
    const result = getResearch(tmpCwd, key, { clock: { now: () => TTL_30D - 1 }, homeDir: tmpHome });
    assert.equal(result.hit, true);
    assert.equal(result.stale, false, 'age = ttl-1 should NOT be stale');
  });

  test('now = ttl → stale:false (strict > boundary: equal is not stale)', () => {
    const key = researchKey({ ecosystem: 'x', kind: 'docs', query: 'ttl-exact' });
    putAtZero(tmpCwd, tmpHome, key);
    const result = getResearch(tmpCwd, key, { clock: { now: () => TTL_30D }, homeDir: tmpHome });
    assert.equal(result.hit, true);
    assert.equal(result.stale, false, 'age = ttl exactly should NOT be stale (strict >)');
  });

  test('now = ttl+1 → stale:true', () => {
    const key = researchKey({ ecosystem: 'x', kind: 'docs', query: 'ttl-plus-1' });
    putAtZero(tmpCwd, tmpHome, key);
    const result = getResearch(tmpCwd, key, { clock: { now: () => TTL_30D + 1 }, homeDir: tmpHome });
    assert.equal(result.hit, true);
    assert.equal(result.stale, true, 'age = ttl+1 should be stale');
  });
});

// ---------------------------------------------------------------------------
// Cycle 8: resolveStorePath tiers — source-derived (I1)
// ---------------------------------------------------------------------------

describe('research-store: resolveStorePath tiers', () => {
  const FAKE_HOME = '/fake/home';
  const FAKE_CWD = '/fake/cwd';

  test("source 'curated' → under injected homeDir/.gsd/research-cache", () => {
    const p = resolveStorePath(FAKE_CWD, 'curated', { homeDir: FAKE_HOME });
    assert.equal(p, path.join(FAKE_HOME, '.gsd', 'research-cache'));
  });

  test("source 'web' (project) → under cwd/.planning/research/.cache", () => {
    const p = resolveStorePath(FAKE_CWD, 'web', { homeDir: FAKE_HOME });
    assert.equal(p, path.join(FAKE_CWD, '.planning', 'research', '.cache'));
  });

  test("source 'synthesis' (project) → under cwd/.planning/research/.cache", () => {
    const p = resolveStorePath(FAKE_CWD, 'synthesis', { homeDir: FAKE_HOME });
    assert.equal(p, path.join(FAKE_CWD, '.planning', 'research', '.cache'));
  });

  test("source 'legitimacy' (project) → under cwd/.planning/research/.cache", () => {
    const p = resolveStorePath(FAKE_CWD, 'legitimacy', { homeDir: FAKE_HOME });
    assert.equal(p, path.join(FAKE_CWD, '.planning', 'research', '.cache'));
  });

  test('paths are absolute', () => {
    const curated = resolveStorePath(FAKE_CWD, 'curated', { homeDir: FAKE_HOME });
    const web = resolveStorePath(FAKE_CWD, 'web', { homeDir: FAKE_HOME });
    assert.ok(path.isAbsolute(curated));
    assert.ok(path.isAbsolute(web));
  });
});

// ---------------------------------------------------------------------------
// I1 REGRESSION: putResearch with source:'web', kind:'docs' → project tier
// (currently fails: kind:'docs' forces user tier regardless of source)
// ---------------------------------------------------------------------------

describe('research-store: I1 regression — source is the tier axis', () => {
  let tmpCwd;
  let tmpHome;

  beforeEach(() => {
    tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-rs-i1-cwd-'));
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-rs-i1-home-'));
  });

  afterEach(() => {
    cleanup(tmpCwd);
    cleanup(tmpHome);
  });

  test('source:web + kind:docs → file in PROJECT dir, NOT user dir', () => {
    const key = researchKey({ ecosystem: 'npm', library: 'axios', version: '1.0.0', query: 'get', kind: 'docs' });
    putResearch(
      tmpCwd,
      key,
      { content: 'web data', source: 'web', provider: 'web', confidence: 'HIGH', kind: 'docs' },
      { homeDir: tmpHome }
    );

    const projectFile = path.join(tmpCwd, '.planning', 'research', '.cache', `${key}.json`);
    const userFile = path.join(tmpHome, '.gsd', 'research-cache', `${key}.json`);

    assert.ok(fs.existsSync(projectFile), 'file should exist in project dir (.planning/research/.cache)');
    assert.ok(!fs.existsSync(userFile), 'file should NOT exist in user dir (~/.gsd/research-cache)');
  });

  test('source:curated + kind:web → file in USER dir, NOT project dir', () => {
    const key = researchKey({ ecosystem: 'npm', library: 'zod', version: '3.0.0', query: 'parse', kind: 'web' });
    putResearch(
      tmpCwd,
      key,
      { content: 'curated data', source: 'curated', provider: 'ctx7', confidence: 'HIGH', kind: 'web' },
      { homeDir: tmpHome }
    );

    const projectFile = path.join(tmpCwd, '.planning', 'research', '.cache', `${key}.json`);
    const userFile = path.join(tmpHome, '.gsd', 'research-cache', `${key}.json`);

    assert.ok(fs.existsSync(userFile), 'file should exist in user dir (~/.gsd/research-cache)');
    assert.ok(!fs.existsSync(projectFile), 'file should NOT exist in project dir');
  });
});

// ---------------------------------------------------------------------------
// W4 REGRESSION: getResearch prefers FRESHEST across both tiers
// (currently returns first-match regardless of staleness)
// ---------------------------------------------------------------------------

describe('research-store: W4a regression — prefer fresh over stale across tiers', () => {
  const DAY_MS = 86_400_000;
  let tmpCwd;
  let tmpHome;

  beforeEach(() => {
    tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-rs-w4-cwd-'));
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-rs-w4-home-'));
  });

  afterEach(() => {
    cleanup(tmpCwd);
    cleanup(tmpHome);
  });

  test('fresh project entry wins over stale curated entry for same key', () => {
    // After fix: source derives tier. We use distinct source values so entries land in different tiers.
    // We compute the key without kind so both entries share the same key.
    const key = researchKey({ ecosystem: 'npm', library: 'react', version: '18.0.0', query: 'hooks' });

    // Seed a STALE curated entry directly into user tier directory
    const userDir = path.join(tmpHome, '.gsd', 'research-cache');
    fs.mkdirSync(userDir, { recursive: true });
    const staleEntry = {
      content: 'stale curated content',
      source: 'curated',
      provider: 'ctx7',
      confidence: 'HIGH',
      fetched_at: new Date(0).toISOString(), // epoch → always stale at t=100d
      ttl: 30 * DAY_MS,
      kind: 'docs',
    };
    fs.writeFileSync(path.join(userDir, `${key}.json`), JSON.stringify(staleEntry));

    // Seed a FRESH web entry directly into project tier directory
    const freshClock = { now: () => 100 * DAY_MS }; // well beyond the curated entry's TTL
    const projectDir = path.join(tmpCwd, '.planning', 'research', '.cache');
    fs.mkdirSync(projectDir, { recursive: true });
    const freshEntry = {
      content: 'fresh web content',
      source: 'web',
      provider: 'web',
      confidence: 'HIGH',
      fetched_at: new Date(100 * DAY_MS).toISOString(), // brand new
      ttl: DAY_MS,
      kind: 'docs',
    };
    fs.writeFileSync(path.join(projectDir, `${key}.json`), JSON.stringify(freshEntry));

    // Now at freshClock time, curated is stale (age=100d > 30d ttl) but web is fresh (age=0 < 1d ttl)
    const result = getResearch(tmpCwd, key, { clock: freshClock, homeDir: tmpHome });

    assert.equal(result.hit, true, 'should find a hit');
    assert.equal(result.stale, false, 'should return the FRESH entry (stale:false)');
    assert.equal(result.entry.content, 'fresh web content', 'should return fresh web content, not stale curated');
    assert.equal(result.entry.source, 'web', 'source should be web');
  });
});

// ---------------------------------------------------------------------------
// W4b REGRESSION: blank version caps TTL at DAY_MS
// (currently blank version still gets 30d curated TTL)
// ---------------------------------------------------------------------------

describe('research-store: W4b regression — blank version caps TTL', () => {
  const DAY_MS = 86_400_000;
  let tmpCwd;
  let tmpHome;

  beforeEach(() => {
    tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-rs-w4b-cwd-'));
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-rs-w4b-home-'));
  });

  afterEach(() => {
    cleanup(tmpCwd);
    cleanup(tmpHome);
  });

  test('curated + HIGH + version blank → ttl = DAY_MS (capped)', () => {
    const key = researchKey({ ecosystem: 'npm', library: 'lodash', version: '', query: 'chunk', kind: 'docs' });
    const entry = putResearch(
      tmpCwd,
      key,
      { content: 'data', source: 'curated', provider: 'ctx7', confidence: 'HIGH', kind: 'docs', version: '' },
      { homeDir: tmpHome }
    );
    assert.equal(entry.ttl, DAY_MS, 'blank version should cap TTL at DAY_MS, not 30*DAY_MS');
  });

  test('curated + HIGH + version "1.2.3" → ttl = 30 * DAY_MS (uncapped)', () => {
    const key = researchKey({ ecosystem: 'npm', library: 'lodash', version: '1.2.3', query: 'chunk', kind: 'docs' });
    const entry = putResearch(
      tmpCwd,
      key,
      { content: 'data', source: 'curated', provider: 'ctx7', confidence: 'HIGH', kind: 'docs', version: '1.2.3' },
      { homeDir: tmpHome }
    );
    assert.equal(entry.ttl, 30 * DAY_MS, 'non-blank version should NOT cap TTL');
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
    cleanup(tmpCwd);
    cleanup(tmpHome);
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

    const result = getResearch(tmpCwd, key, { clock: fixedClock, homeDir: tmpHome });

    assert.equal(result.hit, true, 'hit should be true');
    assert.equal(result.stale, false, 'stale should be false at time 0');
    assert.ok(result.entry !== null, 'entry should not be null');
    assert.equal(result.entry.content, 'lodash chunk docs', 'content preserved');
    assert.equal(result.entry.source, 'curated');
    assert.equal(result.entry.confidence, 'HIGH');
  });
});

// ---------------------------------------------------------------------------
// FINDING 1 REGRESSION: key validation / path-traversal prevention
// ---------------------------------------------------------------------------

describe('research-store: isValidResearchKey exported', () => {
  const { isValidResearchKey } = require('../gsd-core/bin/lib/research-store.cjs');

  test('isValidResearchKey is exported', () => {
    assert.equal(typeof isValidResearchKey, 'function', 'isValidResearchKey must be exported');
  });

  test('64-char hex key is valid', () => {
    assert.equal(isValidResearchKey('a'.repeat(64)), true);
    assert.equal(isValidResearchKey('0123456789abcdef'.repeat(4)), true);
  });

  test('short key is invalid', () => {
    assert.equal(isValidResearchKey('abc'), false);
  });

  test('traversal key is invalid', () => {
    assert.equal(isValidResearchKey('../../../etc/passwd'), false);
  });

  test('non-hex 64-char key is invalid', () => {
    assert.equal(isValidResearchKey('g'.repeat(64)), false);
  });

  test('non-string is invalid', () => {
    assert.equal(isValidResearchKey(null), false);
    assert.equal(isValidResearchKey(undefined), false);
    assert.equal(isValidResearchKey(123), false);
  });
});

describe('research-store: putResearch rejects traversal key', () => {
  let tmpCwd;
  let tmpHome;

  beforeEach(() => {
    tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-rs-trav-cwd-'));
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-rs-trav-home-'));
  });

  afterEach(() => {
    cleanup(tmpCwd);
    cleanup(tmpHome);
  });

  test('putResearch throws on traversal key and does NOT write any file outside cache dir', () => {
    const traversalKey = '../../../' + 'x'.repeat(10);
    // Verify no file is created outside
    const outsideTarget = path.join(os.tmpdir(), 'x'.repeat(10) + '.json');
    // Remove any pre-existing file at traversal target
    try { fs.unlinkSync(outsideTarget); } catch { /* ignore */ }

    assert.throws(
      () => putResearch(tmpCwd, traversalKey, { content: 'evil', source: 'web', provider: 'p', confidence: 'HIGH', kind: 'docs' }, { homeDir: tmpHome }),
      /invalid research key/i
    );
    assert.equal(fs.existsSync(outsideTarget), false, 'traversal target must not be created');
  });

  test('putResearch throws on short/fake key', () => {
    assert.throws(
      () => putResearch(tmpCwd, 'abc', { content: 'x', source: 'web', provider: 'p', confidence: 'HIGH', kind: 'docs' }, { homeDir: tmpHome }),
      /invalid research key/i
    );
  });

  test('putResearch succeeds with valid 64-hex key', () => {
    const key = researchKey({ ecosystem: 'npm', library: 'react', version: '18.0.0', query: 'hooks', kind: 'docs' });
    assert.doesNotThrow(() => {
      putResearch(tmpCwd, key, { content: 'ok', source: 'web', provider: 'p', confidence: 'HIGH', kind: 'docs' }, { homeDir: tmpHome });
    });
  });
});

describe('research-store: getResearch rejects traversal key', () => {
  let tmpCwd;
  let tmpHome;

  beforeEach(() => {
    tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-rs-trav2-cwd-'));
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-rs-trav2-home-'));
  });

  afterEach(() => {
    cleanup(tmpCwd);
    cleanup(tmpHome);
  });

  test('getResearch returns {hit:false} on traversal key and does NOT read outside cache dir', () => {
    const traversalKey = '../../../etc/passwd';
    const result = getResearch(tmpCwd, traversalKey, { homeDir: tmpHome });
    assert.equal(result.hit, false, 'traversal key must return hit:false');
    assert.equal(result.stale, false);
    assert.equal(result.entry, null);
  });

  test('getResearch returns {hit:false} on short key', () => {
    const result = getResearch(tmpCwd, 'k1', { homeDir: tmpHome });
    assert.equal(result.hit, false);
  });
});

// ---------------------------------------------------------------------------
// FINDING 3 REGRESSION: malformed cache metadata treated as fresh
// ---------------------------------------------------------------------------

describe('research-store: getResearch rejects malformed cache metadata', () => {
  let tmpCwd;
  let tmpHome;

  beforeEach(() => {
    tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-rs-malformed-cwd-'));
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-rs-malformed-home-'));
  });

  afterEach(() => {
    cleanup(tmpCwd);
    cleanup(tmpHome);
  });

  function writeEntry(dir, key, entry) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${key}.json`), JSON.stringify(entry));
  }

  test('missing fetched_at → hit:false (not treated as fresh)', () => {
    const key = researchKey({ ecosystem: 'npm', library: 'bad', version: '1.0.0', query: 'q', kind: 'docs' });
    const dir = path.join(tmpCwd, '.planning', 'research', '.cache');
    writeEntry(dir, key, { content: 'x', source: 'web', provider: 'p', confidence: 'HIGH', kind: 'docs', ttl: 86400000 });
    // fetched_at is missing
    const result = getResearch(tmpCwd, key, { homeDir: tmpHome });
    assert.equal(result.hit, false, 'missing fetched_at must return hit:false');
  });

  test('ttl = "abc" (string) → hit:false', () => {
    const key = researchKey({ ecosystem: 'npm', library: 'bad2', version: '1.0.0', query: 'q', kind: 'docs' });
    const dir = path.join(tmpCwd, '.planning', 'research', '.cache');
    writeEntry(dir, key, { content: 'x', source: 'web', provider: 'p', confidence: 'HIGH', kind: 'docs', fetched_at: new Date().toISOString(), ttl: 'abc' });
    const result = getResearch(tmpCwd, key, { homeDir: tmpHome });
    assert.equal(result.hit, false, 'string ttl must return hit:false');
  });

  test('ttl = 0 → hit:false', () => {
    const key = researchKey({ ecosystem: 'npm', library: 'bad3', version: '1.0.0', query: 'q', kind: 'docs' });
    const dir = path.join(tmpCwd, '.planning', 'research', '.cache');
    writeEntry(dir, key, { content: 'x', source: 'web', provider: 'p', confidence: 'HIGH', kind: 'docs', fetched_at: new Date().toISOString(), ttl: 0 });
    const result = getResearch(tmpCwd, key, { homeDir: tmpHome });
    assert.equal(result.hit, false, 'ttl=0 must return hit:false');
  });

  test('ttl = -1 (negative) → hit:false', () => {
    const key = researchKey({ ecosystem: 'npm', library: 'bad4', version: '1.0.0', query: 'q', kind: 'docs' });
    const dir = path.join(tmpCwd, '.planning', 'research', '.cache');
    writeEntry(dir, key, { content: 'x', source: 'web', provider: 'p', confidence: 'HIGH', kind: 'docs', fetched_at: new Date().toISOString(), ttl: -1 });
    const result = getResearch(tmpCwd, key, { homeDir: tmpHome });
    assert.equal(result.hit, false, 'negative ttl must return hit:false');
  });

  test('fetched_at = "not-a-date" → hit:false', () => {
    const key = researchKey({ ecosystem: 'npm', library: 'bad5', version: '1.0.0', query: 'q', kind: 'docs' });
    const dir = path.join(tmpCwd, '.planning', 'research', '.cache');
    writeEntry(dir, key, { content: 'x', source: 'web', provider: 'p', confidence: 'HIGH', kind: 'docs', fetched_at: 'not-a-date', ttl: 86400000 });
    const result = getResearch(tmpCwd, key, { homeDir: tmpHome });
    assert.equal(result.hit, false, 'invalid fetched_at must return hit:false');
  });

  test('valid entry still works', () => {
    const key = researchKey({ ecosystem: 'npm', library: 'good', version: '1.0.0', query: 'q', kind: 'docs' });
    const dir = path.join(tmpCwd, '.planning', 'research', '.cache');
    writeEntry(dir, key, { content: 'valid', source: 'web', provider: 'p', confidence: 'HIGH', kind: 'docs', fetched_at: new Date().toISOString(), ttl: 86400000 });
    const result = getResearch(tmpCwd, key, { homeDir: tmpHome });
    assert.equal(result.hit, true, 'valid entry should still hit');
  });
});
