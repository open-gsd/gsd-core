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
const { readSentinelAt } = require('../hooks/lib/isolation-sentinel.js');

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

  // #4904: a phase query lists its plans' records itself, so that read needs the same
  // parent check as the keyed reads above: the hold must not read through a linked directory.
  test('row 8: the hold\'s phase-scope read of plan records refuses a linked keyed directory', () => {
    outsideRecord(outside, path.join('keyed', `${h.PHASE}--${h.PLAN}.json`));
    fs.mkdirSync(path.join(root, '.gsd'), { recursive: true });
    link(path.join(outside, 'keyed'), path.join(root, h.KEYED_DIR_REL));
    const read = readSentinelAt(root, { dispatchIds: { phase: h.PHASE, plan: null }, ownScope: true });
    assert.deepEqual(read, { present: false });
  });

  test('control: the same read finds that record in a real keyed directory', () => {
    outsideRecord(root, path.join(h.KEYED_DIR_REL, `${h.PHASE}--${h.PLAN}.json`));
    const read = readSentinelAt(root, { dispatchIds: { phase: h.PHASE, plan: null }, ownScope: true });
    assert.equal(read.present, true);
    assert.equal(read.plan, h.PLAN);
  });
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

// #4904 (option (c)): an executor-identity record that is a link, a hard link, a FIFO, or sits in a linked
// directory cannot be read, and it may name the type, so the classification scan fails closed (`scanOverflow`)
// rather than reading the record as absent. The signal-free hostile rows are in
// tests/held-query-executor-identity.test.cjs.
describe('#4904 hostile executor-identity records fail classification closed', { skip: SKIP }, () => {
  const { readSentinel, IDENTITY_RECORD_DIR } = require('../hooks/lib/isolation-sentinel.js');
  const NOW = 1_000_000;
  const clock = { now: () => NOW };
  const body = JSON.stringify({
    schema: 1, phase: '02', plan: null, executor_type: null, executor_types: ['acme-rails-executor'],
    executor_types_truncated: false, written_at: NOW,
  });
  let root;
  let outside;
  before(() => {
    root = createTempDir('gsd-4904-plat-root-');
    fs.mkdirSync(path.join(root, '.planning'));
    outside = createTempDir('gsd-4904-plat-out-');
  });
  after(() => { cleanup(root); cleanup(outside); });
  afterEach(() => {
    cleanup(path.join(root, '.gsd'));
    for (const entry of fs.readdirSync(outside)) cleanup(path.join(outside, entry));
  });
  const identityFile = () => path.join(root, IDENTITY_RECORD_DIR, 'phase+02.json');
  const realOutside = () => h.writeFileAt(outside, 'real.json', body);
  const read = () => readSentinel(root, { clock, subagentType: 'acme-ui-executor', dispatchIds: { phase: '03', plan: null } });

  const rows = [
    ['a symlink to a valid record elsewhere', () => link(realOutside(), identityFile())],
    ['a hard link to a valid record elsewhere', () => {
      fs.mkdirSync(path.dirname(identityFile()), { recursive: true });
      fs.linkSync(realOutside(), identityFile());
    }],
    ['a FIFO', () => mkfifo(identityFile())],
    ['a record directory that is a symlink to an outside directory', () => {
      h.writeFileAt(outside, path.join('ids', 'phase+02.json'), body);
      fs.mkdirSync(path.join(root, '.gsd'), { recursive: true });
      link(path.join(outside, 'ids'), path.join(root, IDENTITY_RECORD_DIR));
    }],
  ];
  for (const [label, plant] of rows) {
    test(`${label}: scanOverflow`, () => {
      plant();
      assert.equal(read().scanOverflow, true);
    });
  }

  test('control: the same record as a regular file is read, not overflow', () => {
    h.writeFileAt(root, path.join(IDENTITY_RECORD_DIR, 'phase+02.json'), body);
    const r = read();
    assert.equal(r.scanOverflow, undefined);
    assert.ok(r.candidates.some((c) => c.identity && c.executorTypes.includes('acme-rails-executor')));
  });
});

// #4904: an identity directory the writer cannot write to makes a held query record its decision instead of
// holding (a hold the guards could not classify by would allow what `next` blocks).
describe('#4904 an unwritable identity directory: the query does not hold', { skip: SKIP || (process.getuid && process.getuid() === 0 ? 'root ignores the mode' : false) }, () => {
  const { IDENTITY_RECORD_DIR } = require('../hooks/lib/isolation-sentinel.js');
  const { runGsdTools, createTempGitProject, homeSandboxEnv, TOOLS_PATH } = require('./helpers.cjs');
  const { runNode } = require('./helpers/process-seam.cjs');
  let root;
  before(() => { root = createTempGitProject('gsd-4904-plat-ro-'); });
  after(() => {
    try { fs.chmodSync(path.join(root, IDENTITY_RECORD_DIR), 0o755); } catch { /* absent */ }
    cleanup(root);
  });

  test('mode 0555 on .gsd/dispatch-isolation-identity: held false, with the warning', () => {
    const env = { ...homeSandboxEnv(root), GSD_TEST_MODE: '1', GSD_NOW_MS: '1000000' };
    const forced = runGsdTools(['dispatch-isolation', '--raw', '--phase', '02', '--force-isolation', 'none'], root, env);
    assert.ok(forced.success, forced.error);
    fs.mkdirSync(path.join(root, IDENTITY_RECORD_DIR), { recursive: true });
    fs.chmodSync(path.join(root, IDENTITY_RECORD_DIR), 0o555);
    const r = runNode([TOOLS_PATH, 'dispatch-isolation', '--json', '--phase', '02'],
      { cwd: root, env: { ...process.env, ...env, GSD_NOW_MS: '1060000' }, timeoutMs: PROBE_TIMEOUT_MS });
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).held, false);
    assert.match(r.stderr, /could not record executor identity/);
  });
});

// #4904: a decision write removes its scope's identity record, and never through a linked directory.
describe('#4904 a decision write never removes a file through a linked identity directory', { skip: SKIP }, () => {
  const { IDENTITY_RECORD_DIR } = require('../hooks/lib/isolation-sentinel.js');
  const { runGsdTools, createTempGitProject, homeSandboxEnv } = require('./helpers.cjs');
  let root;
  let outside;
  before(() => { root = createTempGitProject('gsd-4904-plat-rm-'); outside = createTempDir('gsd-4904-plat-rm-out-'); });
  after(() => { cleanup(root); cleanup(outside); });

  test('the outside file survives; the same file in a real directory is removed (control)', () => {
    const env = { ...homeSandboxEnv(root), GSD_TEST_MODE: '1', GSD_NOW_MS: '1000000' };
    const victim = h.writeFileAt(outside, 'phase+02.json', 'keep');
    fs.mkdirSync(path.join(root, '.gsd'), { recursive: true });
    link(outside, path.join(root, IDENTITY_RECORD_DIR));
    let r = runGsdTools(['record-dispatch-isolation', '--isolation', 'none', '--phase', '02'], root, env);
    assert.ok(r.success, r.error);
    assert.equal(fs.readFileSync(victim, 'utf8'), 'keep');
    fs.unlinkSync(path.join(root, IDENTITY_RECORD_DIR));
    const own = h.writeFileAt(root, path.join(IDENTITY_RECORD_DIR, 'phase+02.json'), '{}');
    r = runGsdTools(['record-dispatch-isolation', '--isolation', 'none', '--phase', '02'], root, env);
    assert.ok(r.success, r.error);
    assert.equal(fs.existsSync(own), false);
  });
});

// #4904: the identity writer refuses a linked record directory, so a held query never writes (or prunes)
// outside the project; it records its decision instead of holding.
describe('#4904 a held query never writes through a linked identity directory', { skip: SKIP }, () => {
  const { IDENTITY_RECORD_DIR } = require('../hooks/lib/isolation-sentinel.js');
  const { runGsdTools, createTempGitProject, homeSandboxEnv, TOOLS_PATH } = require('./helpers.cjs');
  const { runNode } = require('./helpers/process-seam.cjs');
  let root;
  let outside;
  before(() => { root = createTempGitProject('gsd-4904-plat-wl-'); outside = createTempDir('gsd-4904-plat-wl-out-'); });
  after(() => { cleanup(root); cleanup(outside); });

  test('held false, and the outside directory is unchanged', () => {
    const env = { ...homeSandboxEnv(root), GSD_TEST_MODE: '1', GSD_NOW_MS: '1000000' };
    const forced = runGsdTools(['dispatch-isolation', '--raw', '--phase', '02', '--force-isolation', 'none'], root, env);
    assert.ok(forced.success, forced.error);
    h.writeFileAt(outside, 'other.json', 'keep');
    link(outside, path.join(root, IDENTITY_RECORD_DIR));
    const r = runNode([TOOLS_PATH, 'dispatch-isolation', '--json', '--phase', '02'],
      { cwd: root, env: { ...process.env, ...env, GSD_NOW_MS: '1060000' }, timeoutMs: PROBE_TIMEOUT_MS });
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).held, false);
    assert.deepEqual(fs.readdirSync(outside), ['other.json']);
    assert.equal(fs.readFileSync(path.join(outside, 'other.json'), 'utf8'), 'keep');
  });
});
