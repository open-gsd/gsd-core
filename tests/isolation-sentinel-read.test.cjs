'use strict';

/**
 * #5758: the dispatch-isolation sentinel reader is a bounded, link-refusing read of a regular file.
 *
 * Matrix: .gsd/bug/fix-5758-sentinel-bounded-read/50-test-matrix.md. This file holds the rows that
 * need no special files or links (oversize, the SENTINEL_MAX_BYTES boundary, directory-at-path,
 * unchanged parse results, the property); the pipe / link / device rows live in
 * tests/isolation-sentinel-read.platform.test.cjs.
 */

const { describe, test, before, after, afterEach, mock } = require('node:test');
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
      decidedBy: 'caller',
      decidedAt: now,
      holdExpired: false,
      executorType: null,
      executorTypes: [],
      executorTypesTruncated: false,
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

describe('#5758 readSentinel: object-identity re-checks after the open', () => {
  let root;
  const realLstat = fs.lstatSync;
  before(() => {
    root = createTempDir('gsd-5758-ident-');
    fs.mkdirSync(path.join(root, '.planning'));
  });
  after(() => cleanup(root));
  afterEach(() => {
    mock.restoreAll();
    cleanup(path.join(root, '.gsd'));
  });

  /** Stats-shaped copy of the real lstat of `p`, with `patch` applied. */
  function patched(p, patch, rest) {
    const st = realLstat.call(fs, p, ...rest);
    return Object.assign(Object.create(Object.getPrototypeOf(st)), st, patch);
  }

  /**
   * `ino` higher by the number of swapped calls so far, in the same numeric type the caller asked for
   * ({ bigint: true } gives bigint). The identity keeps moving on every call, so the bounded retry of a refused
   * read (#6213) cannot see two consistent stats of a swapped object and accept it.
   */
  const nextIno = (st, n = 1) => ({ ino: typeof st.ino === 'bigint' ? st.ino + BigInt(n) : st.ino + n });

  /** Make the Nth and later lstat calls for `target` answer `patchFor(target)`. */
  function swapAfter(target, calls, patch) {
    let seen = 0;
    mock.method(fs, 'lstatSync', (p, ...rest) => {
      if (path.resolve(String(p)) !== target) return realLstat.call(fs, p, ...rest);
      seen += 1;
      return seen > calls ? patched(p, patch(realLstat.call(fs, p, ...rest), seen), rest) : realLstat.call(fs, p, ...rest);
    });
  }

  test('control: with no swap the record reads as present', () => {
    h.writeFileAt(root, h.LEGACY_REL, JSON.stringify(h.validBody()));
    assert.equal(readSentinel(root).present, true);
  });

  test('a parent directory whose identity changes between the check and the open reads as absent', () => {
    h.writeFileAt(root, h.LEGACY_REL, JSON.stringify(h.validBody()));
    swapAfter(path.join(root, '.gsd'), 1, nextIno);
    assert.deepEqual(readSentinel(root), { present: false });
  });

  test('a parent directory that turns into a link after the open reads as absent', () => {
    h.writeFileAt(root, h.LEGACY_REL, JSON.stringify(h.validBody()));
    swapAfter(path.join(root, '.gsd'), 1, () => ({ isSymbolicLink: () => true, isDirectory: () => false }));
    assert.deepEqual(readSentinel(root), { present: false });
  });

  test('a file that is not the object the pre-open lstat saw reads as absent', () => {
    h.writeFileAt(root, h.LEGACY_REL, JSON.stringify(h.validBody()));
    swapAfter(path.join(root, h.LEGACY_REL), 0, nextIno);
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

// #4904 review 2026-11-17, Minor 1: the hold's phase-scope read lists the phase's plan records itself. That
// listing is bounded like the guards' classification scan: past MAX_SCANNED_DIR_ENTRIES directory entries the
// hold cannot see every plan record, so the read answers "no hold" instead of reading without a bound.
describe('#4904 the hold\'s phase-scope listing of plan records is bounded', () => {
  const { readSentinelAt, MAX_SCANNED_DIR_ENTRIES, KEYED_SENTINEL_DIR } = sentinel;
  const PHASE = '03';
  const WRITTEN_AT = 5_000_000;
  let root;
  before(() => { root = createTempDir('gsd-4904-plan-list-'); });
  after(() => cleanup(root));
  afterEach(() => cleanup(path.join(root, '.gsd')));

  // One fresh caller `none` for plan 03-01, plus enough other entries to make `entries` in the record directory.
  function plant(entries) {
    const dir = path.join(root, KEYED_SENTINEL_DIR);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${PHASE}--03-01.json`), JSON.stringify({
      isolation: 'none', harness_flag: null, phase: PHASE, plan: '03-01', decided_by: 'caller',
      decided_at: WRITTEN_AT, written_at: WRITTEN_AT,
    }));
    for (let i = 1; i < entries; i += 1) fs.writeFileSync(path.join(dir, `filler-${i}.txt`), '');
    assert.equal(fs.readdirSync(dir).length, entries);
  }
  const holdRead = () => readSentinelAt(root, { clock: clockAt(WRITTEN_AT + 1000), dispatchIds: { phase: PHASE, plan: null }, ownScope: true });

  test('is exported as 1024 entries', () => {
    assert.equal(MAX_SCANNED_DIR_ENTRIES, 1024);
  });

  for (const [entries, held] of [[MAX_SCANNED_DIR_ENTRIES - 1, true], [MAX_SCANNED_DIR_ENTRIES, true], [MAX_SCANNED_DIR_ENTRIES + 1, false]]) {
    test(`${entries} entries: the plan record is ${held ? 'read' : 'not read, and nothing is held'}`, () => {
      plant(entries);
      const read = holdRead();
      if (held) {
        assert.equal(read.present, true);
        assert.equal(read.plan, '03-01');
        assert.equal(read.isolation, 'none');
      } else {
        assert.deepEqual(read, { present: false });
      }
    });
  }
});
