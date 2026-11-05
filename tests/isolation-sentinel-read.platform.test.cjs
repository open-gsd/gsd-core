'use strict';

/**
 * #5758: named pipes, devices and links at the dispatch-isolation record must read as absent.
 *
 * Platform file: mkfifo and symlinks are POSIX, so every case skips on win32. The signal-free rows
 * (oversize, boundary, directory-at-path, unchanged parse results, the property) are in
 * tests/isolation-sentinel-read.test.cjs.
 *
 * Every read runs in a child process under a hard kill timer. `signal === null` proves the child
 * returned by itself; a blocked reader is killed and reports SIGKILL. The decision of each hook with
 * the hostile record in place must equal its decision with no record at all.
 */

const { describe, test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createTempDir, cleanup } = require('./helpers.cjs');
const h = require('./helpers/isolation-sentinel-read.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

const SKIP = process.platform === 'win32' ? 'POSIX-only: mkfifo and symlinks' : false;

function mkfifo(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  execFileSync('mkfifo', [file], { timeout: PROBE_TIMEOUT_MS });
}

function link(target, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.symlinkSync(target, file);
}

/** Valid fresh `none` record in a directory outside the project, for links to point at. */
function outsideRecord(outside, rel) {
  h.writeFileAt(outside, rel, JSON.stringify(h.validBody()));
  return path.join(outside, rel);
}

const SCENARIOS = [
  { row: 1, name: 'FIFO at the legacy slot', plant: (root) => mkfifo(path.join(root, h.LEGACY_REL)) },
  { row: 2, name: 'FIFO at the plan-keyed record', plant: (root) => mkfifo(path.join(root, h.KEYED_REL)) },
  { row: 3, name: 'symlink to /dev/zero at the legacy slot', plant: (root) => link('/dev/zero', path.join(root, h.LEGACY_REL)) },
  { row: 3, name: 'symlink to /dev/zero at the plan-keyed record', plant: (root) => link('/dev/zero', path.join(root, h.KEYED_REL)) },
  { row: 3, name: 'symlink to a FIFO at the legacy slot', plant: (root, outside) => {
    const fifo = path.join(outside, 'pipe');
    mkfifo(fifo);
    link(fifo, path.join(root, h.LEGACY_REL));
  } },
  { row: 4, name: 'symlink to a valid fresh sentinel elsewhere (legacy slot)', plant: (root, outside) => {
    link(outsideRecord(outside, 'real.json'), path.join(root, h.LEGACY_REL));
  } },
  { row: 4, name: 'symlink to a valid fresh record elsewhere (plan-keyed record)', plant: (root, outside) => {
    link(outsideRecord(outside, 'real.json'), path.join(root, h.KEYED_REL));
  } },
  { row: 4, name: 'hard link to a valid fresh sentinel elsewhere (legacy slot)', plant: (root, outside) => {
    const real = outsideRecord(outside, 'real.json');
    fs.mkdirSync(path.join(root, '.gsd'), { recursive: true });
    fs.linkSync(real, path.join(root, h.LEGACY_REL));
  } },
  { row: 4, name: 'hard link to a valid fresh record elsewhere (plan-keyed record)', plant: (root, outside) => {
    const real = outsideRecord(outside, 'real.json');
    fs.mkdirSync(path.join(root, h.KEYED_DIR_REL), { recursive: true });
    fs.linkSync(real, path.join(root, h.KEYED_REL));
  } },
  { row: 7, name: '.gsd is a symlink to an outside directory holding a valid sentinel', plant: (root, outside) => {
    outsideRecord(outside, path.join('gsd', 'dispatch-isolation-sentinel.json'));
    link(path.join(outside, 'gsd'), path.join(root, '.gsd'));
  } },
  { row: 7, name: '.gsd is a symlink to an outside directory holding a valid keyed record', plant: (root, outside) => {
    outsideRecord(outside, path.join('gsd', 'dispatch-isolation', `${h.PHASE}--${h.PLAN}.json`));
    link(path.join(outside, 'gsd'), path.join(root, '.gsd'));
  } },
  { row: 8, name: '.gsd/dispatch-isolation is a symlink to an outside directory with a valid keyed record', plant: (root, outside) => {
    outsideRecord(outside, path.join('keyed', `${h.PHASE}--${h.PLAN}.json`));
    fs.mkdirSync(path.join(root, '.gsd'), { recursive: true });
    link(path.join(outside, 'keyed'), path.join(root, h.KEYED_DIR_REL));
  } },
];

describe('#5758 readSentinel: hostile records read as absent and return', { skip: SKIP }, () => {
  let root;
  let outside;
  before(() => {
    root = createTempDir('gsd-5758-plat-root-');
    fs.mkdirSync(path.join(root, '.planning'));
    outside = createTempDir('gsd-5758-plat-out-');
  });
  after(() => {
    cleanup(root);
    cleanup(outside);
  });
  afterEach(() => {
    cleanup(path.join(root, '.gsd'));
    for (const entry of fs.readdirSync(outside)) cleanup(path.join(outside, entry));
  });

  for (const s of SCENARIOS) {
    test(`row ${s.row}: ${s.name}`, () => {
      s.plant(root, outside);
      const r = h.readSentinelBounded(root, { phase: h.PHASE, plan: h.PLAN });
      assert.equal(r.signal, null, 'the read must return by itself, not be killed by the timer');
      assert.deepEqual(r.result, { present: false });
    });
  }
});

describe('#5758 hooks: a hostile record leaves both hooks at the no-sentinel decision', { skip: SKIP }, () => {
  let guardRoot;
  let cursorRoot;
  let outside;
  before(() => {
    guardRoot = h.makeGuardProject();
    cursorRoot = h.makeCursorProject();
    outside = createTempDir('gsd-5758-plat-hook-out-');
  });
  after(() => {
    cleanup(guardRoot);
    cleanup(cursorRoot);
    cleanup(outside);
  });
  afterEach(() => {
    cleanup(path.join(guardRoot, '.gsd'));
    cleanup(path.join(cursorRoot, '.gsd'));
    for (const entry of fs.readdirSync(outside)) cleanup(path.join(outside, entry));
  });

  for (const s of SCENARIOS) {
    test(`row ${s.row}: ${s.name}`, () => {
      const guardControl = h.runGuard(guardRoot);
      const cursorControl = h.runCursor(cursorRoot);
      assert.equal(guardControl.status, 2, 'control: flag-less dispatch is denied');
      assert.match(cursorControl.stdout, /"permission":"deny"/, 'control: main checkout is denied');

      s.plant(guardRoot, outside);
      const guard = h.runGuard(guardRoot);
      cleanup(path.join(guardRoot, '.gsd'));
      for (const entry of fs.readdirSync(outside)) cleanup(path.join(outside, entry));
      s.plant(cursorRoot, outside);
      const cursor = h.runCursor(cursorRoot);

      assert.equal(guard.signal, null, 'agent guard must exit by itself');
      assert.equal(cursor.signal, null, 'cursor hook must exit by itself');
      assert.deepEqual([guard.status, guard.stdout, guard.stderr], [guardControl.status, guardControl.stdout, guardControl.stderr]);
      assert.deepEqual([cursor.status, cursor.stdout], [cursorControl.status, cursorControl.stdout]);
    });
  }
});
