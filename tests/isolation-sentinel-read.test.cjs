'use strict';

/**
 * #5758: the dispatch-isolation sentinel reader is a bounded, link-refusing read of a regular file.
 *
 * Matrix: .gsd/bug/fix-5758-sentinel-bounded-read/50-test-matrix.md. This file holds the rows that
 * need no special files or links (oversize, the SENTINEL_MAX_BYTES boundary, directory-at-path,
 * unchanged parse results, the property); the pipe / link / device rows live in
 * tests/isolation-sentinel-read.platform.test.cjs.
 */

const { describe, test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTempDir, cleanup } = require('./helpers.cjs');
const fc = require('./helpers/fast-check-setup.cjs');
const sentinel = require('../hooks/lib/isolation-sentinel.js');
const h = require('./helpers/isolation-sentinel-read.cjs');

const { readSentinel, SENTINEL_STALE_MS, SENTINEL_MAX_BYTES } = sentinel;

function clockAt(ms) {
  return { now: () => ms };
}

describe('#5758 SENTINEL_MAX_BYTES', () => {
  test('is exported as 4096', () => {
    assert.equal(SENTINEL_MAX_BYTES, 4096);
  });
});

describe('#5758 readSentinel: regular-file bounds', () => {
  let root;
  before(() => {
    root = createTempDir('gsd-5758-read-');
    fs.mkdirSync(path.join(root, '.planning'));
  });
  after(() => cleanup(root));
  afterEach(() => cleanup(path.join(root, '.gsd')));

  test('row 5: a valid sentinel one byte over SENTINEL_MAX_BYTES reads as absent', () => {
    h.writeFileAt(root, h.LEGACY_REL, h.paddedBody(SENTINEL_MAX_BYTES + 1));
    assert.deepEqual(readSentinel(root), { present: false });
  });

  test('row 6: a valid sentinel of exactly SENTINEL_MAX_BYTES and of MAX-1 bytes parses as today', () => {
    for (const bytes of [SENTINEL_MAX_BYTES - 1, SENTINEL_MAX_BYTES]) {
      h.writeFileAt(root, h.LEGACY_REL, h.paddedBody(bytes));
      const read = readSentinel(root);
      assert.equal(read.present, true, `${bytes} bytes`);
      assert.equal(read.stale, false, `${bytes} bytes`);
      assert.equal(read.malformed, false, `${bytes} bytes`);
      assert.equal(read.isolation, 'none', `${bytes} bytes`);
    }
  });

  test('row 5/6: the limit applies to a keyed record too', () => {
    const ids = { phase: h.PHASE, plan: h.PLAN };
    h.writeFileAt(root, h.KEYED_REL, h.paddedBody(SENTINEL_MAX_BYTES + 1));
    assert.deepEqual(readSentinel(root, { dispatchIds: ids }), { present: false }, 'limit+1');
    h.writeFileAt(root, h.KEYED_REL, h.paddedBody(SENTINEL_MAX_BYTES));
    const read = readSentinel(root, { dispatchIds: ids });
    assert.equal(read.present, true, 'limit');
    assert.equal(read.plan, h.PLAN);
  });

  test('row 9: a normal fresh sentinel is unchanged', () => {
    const now = Date.now();
    h.writeFileAt(root, h.LEGACY_REL, JSON.stringify(h.validBody({ harness_flag: 'isolation="worktree"', isolation: 'harness-worktree', written_at: now })));
    assert.deepEqual(readSentinel(root, { clock: clockAt(now + 1000) }), {
      present: true,
      stale: false,
      malformed: false,
      isolation: 'harness-worktree',
      harnessFlag: 'isolation="worktree"',
      phase: h.PHASE,
      plan: h.PLAN,
      writtenAt: now,
    });
  });

  test('row 10: a stale sentinel is unchanged', () => {
    const now = Date.now();
    h.writeFileAt(root, h.LEGACY_REL, JSON.stringify(h.validBody({ written_at: now })));
    const read = readSentinel(root, { clock: clockAt(now + SENTINEL_STALE_MS) });
    assert.equal(read.present, true);
    assert.equal(read.stale, true);
    assert.equal(read.malformed, false);
    assert.equal(read.isolation, 'none');
  });

  test('row 11: malformed JSON is unchanged', () => {
    h.writeFileAt(root, h.LEGACY_REL, '{ this is not json');
    assert.deepEqual(readSentinel(root), { present: true, stale: true, malformed: true });
  });

  test('row 12: an aged none record is still read and still governs its phase (#5479)', () => {
    const now = Date.now();
    const written = now - 2 * SENTINEL_STALE_MS;
    h.writeFileAt(root, h.LEGACY_REL, JSON.stringify(h.validBody({ written_at: written })));
    const read = readSentinel(root, { clock: clockAt(now) });
    assert.equal(read.stale, true);
    assert.equal(sentinel.agedNoneGovernsDispatch(read, { phase: h.PHASE, plan: h.PLAN }, { clock: clockAt(now) }), true);
  });

  test('row 13: a directory at the sentinel path reads as absent', () => {
    fs.mkdirSync(path.join(root, h.LEGACY_REL), { recursive: true });
    assert.deepEqual(readSentinel(root), { present: false });
  });

  test('row 13: a directory at a keyed record path is ignored', () => {
    fs.mkdirSync(path.join(root, h.KEYED_REL), { recursive: true });
    assert.deepEqual(readSentinel(root, { dispatchIds: { phase: h.PHASE, plan: h.PLAN } }), { present: false });
  });

  test('an absent sentinel reads as absent', () => {
    assert.deepEqual(readSentinel(root), { present: false });
  });
});

describe('#5758 readSentinel: oversize hook decisions equal the no-sentinel decision', () => {
  let guardRoot;
  let cursorRoot;
  before(() => {
    guardRoot = h.makeGuardProject();
    cursorRoot = h.makeCursorProject();
  });
  after(() => {
    cleanup(guardRoot);
    cleanup(cursorRoot);
  });
  afterEach(() => {
    cleanup(path.join(guardRoot, '.gsd'));
    cleanup(path.join(cursorRoot, '.gsd'));
  });

  for (const [label, rel] of [['legacy slot', h.LEGACY_REL], ['plan-keyed record', h.KEYED_REL]]) {
    test(`row 5: ${label} of SENTINEL_MAX_BYTES+1 bytes does not change either hook's decision`, () => {
      const guardControl = h.runGuard(guardRoot);
      const cursorControl = h.runCursor(cursorRoot);
      assert.equal(guardControl.status, 2, 'control: flag-less dispatch is denied');
      assert.match(cursorControl.stdout, /"permission":"deny"/, 'control: main checkout is denied');

      h.writeFileAt(guardRoot, rel, h.paddedBody(SENTINEL_MAX_BYTES + 1));
      h.writeFileAt(cursorRoot, rel, h.paddedBody(SENTINEL_MAX_BYTES + 1));
      const guard = h.runGuard(guardRoot);
      const cursor = h.runCursor(cursorRoot);

      assert.equal(guard.signal, null);
      assert.equal(cursor.signal, null);
      assert.deepEqual([guard.status, guard.stdout], [guardControl.status, guardControl.stdout]);
      assert.deepEqual([cursor.status, cursor.stdout], [cursorControl.status, cursorControl.stdout]);
    });

    test(`row 6: ${label} of exactly SENTINEL_MAX_BYTES bytes is honored by both hooks`, () => {
      h.writeFileAt(guardRoot, rel, h.paddedBody(SENTINEL_MAX_BYTES));
      h.writeFileAt(cursorRoot, rel, h.paddedBody(SENTINEL_MAX_BYTES));
      const guard = h.runGuard(guardRoot);
      const cursor = h.runCursor(cursorRoot);
      assert.equal(guard.status, 0, guard.stdout);
      assert.equal(guard.stdout, '');
      assert.doesNotMatch(cursor.stdout, /"permission":"deny"/);
    });
  }

  test('row 9: a normal fresh none sentinel is honored by both hooks', () => {
    h.writeFileAt(guardRoot, h.LEGACY_REL, JSON.stringify(h.validBody()));
    h.writeFileAt(cursorRoot, h.LEGACY_REL, JSON.stringify(h.validBody()));
    const guard = h.runGuard(guardRoot);
    const cursor = h.runCursor(cursorRoot);
    assert.equal(guard.status, 0, guard.stdout);
    assert.equal(guard.stdout, '');
    assert.doesNotMatch(cursor.stdout, /"permission":"deny"/);
  });

  test('row 13: a directory at the sentinel path leaves both hooks at the no-sentinel decision', () => {
    const guardControl = h.runGuard(guardRoot);
    const cursorControl = h.runCursor(cursorRoot);
    fs.mkdirSync(path.join(guardRoot, h.LEGACY_REL), { recursive: true });
    fs.mkdirSync(path.join(cursorRoot, h.LEGACY_REL), { recursive: true });
    const guard = h.runGuard(guardRoot);
    const cursor = h.runCursor(cursorRoot);
    assert.deepEqual([guard.signal, guard.status, guard.stdout], [null, guardControl.status, guardControl.stdout]);
    assert.deepEqual([cursor.signal, cursor.status, cursor.stdout], [null, cursorControl.status, cursorControl.stdout]);
  });
});

describe('#5758 row 14 property: arbitrary regular-file content never throws and honors the size bound', () => {
  let root;
  before(() => {
    root = createTempDir('gsd-5758-prop-');
    fs.mkdirSync(path.join(root, '.planning'));
  });
  after(() => cleanup(root));

  /** The classification today's reader applies to text it successfully read. */
  function classify(text) {
    let parsed;
    try { parsed = JSON.parse(text); } catch { return 'malformed'; }
    if (
      !parsed || typeof parsed !== 'object' ||
      !sentinel.VALID_ISOLATION.has(parsed.isolation) ||
      typeof parsed.written_at !== 'number' || !Number.isFinite(parsed.written_at)
    ) return 'malformed';
    return 'parsed';
  }

  test('content of length 0..SENTINEL_MAX_BYTES+64', () => {
    const file = path.join(root, h.LEGACY_REL);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const bytes = fc.oneof(
      fc.uint8Array({ minLength: 0, maxLength: SENTINEL_MAX_BYTES + 64 }),
      fc.integer({ min: SENTINEL_MAX_BYTES - 2, max: SENTINEL_MAX_BYTES + 3 }).map((n) => Buffer.from(h.paddedBody(n))),
    );
    fc.assert(
      fc.property(bytes, (content) => {
        const buf = Buffer.from(content);
        fs.writeFileSync(file, buf);
        const read = readSentinel(root, { clock: clockAt(Date.now()) });
        if (buf.length > SENTINEL_MAX_BYTES) return read.present === false && Object.keys(read).length === 1;
        const kind = classify(buf.toString('utf-8'));
        if (kind === 'malformed') return read.present === true && read.malformed === true && read.stale === true;
        return read.present === true && read.malformed === false;
      }),
      { numRuns: 120 },
    );
  });
});
