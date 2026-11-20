'use strict';

/**
 * #5120 (epic #4629, ADR-4629 guard roster "No raw STATE.md write outside the
 * seam"): the in-process rows of the test-time value check that scripts/run-tests.cjs
 * installs for the whole suite: the classification rule, the NODE_OPTIONS string, and
 * the report and ledger readers. Nothing here spawns a process; the rows that drive the
 * real preload and the runner live in raw-state-write-guard.process.test.cjs.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTempDir, cleanup } = require('./helpers.cjs');

const GUARD_PATH = path.join(__dirname, '..', 'scripts', 'raw-state-write-guard.cjs');
const {
  classifyStateWrite,
  nodeOptionsWithRequire,
  readStateWriteLedger,
  sameFileKey,
  formatStateWriteReport,
} = require(GUARD_PATH);

/** A write entry exactly as the guard's `observe` appends it (a seam write under the lock), with `overrides`. */
function entry(overrides = {}) {
  return {
    fn: 'renameSync', destination: '/p/STATE.md', source: null, callerFile: '/r/gsd-core/bin/lib/state.cjs', callerLine: 7,
    lockHeld: true, sourceLockHeld: null, violation: false, reason: null, seam: true, relocation: false,
    testFile: null, pid: 1, ...overrides,
  };
}
/** An install sentinel exactly as the guard's `install` appends it, with `overrides`. */
function sentinel(overrides = {}) {
  return { installed: true, preload: true, pid: 1, testFile: null, ...overrides };
}
const ndjson = (...records) => `${records.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n')}\n`;

describe('classifyStateWrite: the approved rule, with the lock (#5120, review Major 1 and Major 3)', () => {
  const lib = (name) => path.join('/x', 'gsd-core', 'bin', 'lib', name);
  const notRecorded = { recorded: false, violation: false, seam: false, relocation: false, reason: null };

  test('a product write onto STATE.md that no seam function made is a raw violation, lock or not', () => {
    for (const lockHeld of [false, true]) {
      const c = classifyStateWrite({ destination: '/p/.planning/STATE.md', callerFile: lib('roadmap-upgrade.cjs'), viaSeam: false, lockHeld });
      assert.deepEqual(c, { recorded: true, violation: true, seam: false, relocation: false, reason: 'raw' }, `lockHeld ${lockHeld}`);
    }
    // A rename from any file not named STATE.md onto STATE.md authors its bytes: raw.
    const t = classifyStateWrite({ destination: '/p/STATE.md', source: '/p/STATE.md.tmp', callerFile: lib('workstream.cjs'), viaSeam: false, lockHeld: true });
    assert.deepEqual(t, { recorded: true, violation: true, seam: false, relocation: false, reason: 'raw' });
  });

  test('a seam write onto STATE.md passes only under the STATE.md lock', () => {
    const locked = classifyStateWrite({ destination: '/p/.planning/STATE.md', callerFile: lib('state.cjs'), viaSeam: true, lockHeld: true });
    assert.deepEqual(locked, { recorded: true, violation: false, seam: true, relocation: false, reason: null });
    for (const lockHeld of [false, undefined, null, 'yes']) {
      const c = classifyStateWrite({ destination: '/p/.planning/STATE.md', callerFile: lib('workstream.cjs'), viaSeam: true, lockHeld });
      assert.deepEqual(c, { recorded: true, violation: true, seam: true, relocation: false, reason: 'unlocked' }, `lockHeld ${String(lockHeld)}`);
    }
  });

  test('a rename or copy from a file named STATE.md is a relocation, held to the lock on both ends', () => {
    const base = { destination: '/p/.planning/workstreams/w/STATE.md', source: '/p/.planning/STATE.md', callerFile: lib('workstream.cjs'), viaSeam: false };
    assert.deepEqual(classifyStateWrite({ ...base, lockHeld: true, sourceLockHeld: true }), { recorded: true, violation: false, seam: false, relocation: true, reason: null });
    for (const [lockHeld, sourceLockHeld] of [[true, false], [false, true], [false, false], [true, null]]) {
      assert.deepEqual(
        classifyStateWrite({ ...base, lockHeld, sourceLockHeld }),
        { recorded: true, violation: true, seam: false, relocation: true, reason: 'unlocked' },
        `lockHeld ${lockHeld}, sourceLockHeld ${sourceLockHeld}`,
      );
    }
    // A relocation through a seam function is a seam write: only the destination lock is asked for.
    const viaSeam = classifyStateWrite({ ...base, viaSeam: true, lockHeld: true, sourceLockHeld: false });
    assert.deepEqual(viaSeam, { recorded: true, violation: false, seam: true, relocation: false, reason: null });
  });

  test('test code, scripts and non-STATE.md basenames are not recorded', () => {
    assert.deepEqual(classifyStateWrite({ destination: '/p/STATE.md', callerFile: '/repo/tests/x.test.cjs', viaSeam: false }), notRecorded);
    assert.deepEqual(classifyStateWrite({ destination: '/p/STATE.md', callerFile: '/repo/tests/x.test.cjs', viaSeam: true, lockHeld: false }), notRecorded);
    assert.deepEqual(classifyStateWrite({ destination: '/p/STATE.md', callerFile: '/repo/scripts/run-tests.cjs', viaSeam: false }), notRecorded);
    assert.deepEqual(classifyStateWrite({ destination: '/p/STATE.md', callerFile: null, viaSeam: false }), notRecorded);
    // The repo-root launchers (bin/install.js) are not payload, even in a checkout named gsd-core.
    assert.deepEqual(classifyStateWrite({ destination: '/p/STATE.md', callerFile: '/home/u/gsd-core/bin/install.js', viaSeam: false }), notRecorded);
    for (const name of ['STATE.md.bak', 'STATE.md.lock', 'STATE.md.tmp.123', 'PROJECT.md', 'state.md', 'XSTATE.md']) {
      assert.deepEqual(classifyStateWrite({ destination: `/p/${name}`, source: '/p/STATE.md', callerFile: lib('a.cjs'), viaSeam: false }), notRecorded, name);
    }
  });

  test('Windows separators classify the same as POSIX ones', () => {
    const c = classifyStateWrite({ destination: 'C:\\p\\.planning\\STATE.md', callerFile: 'C:\\repo\\gsd-core\\bin\\lib\\phase.cjs', viaSeam: false });
    assert.deepEqual(c, { recorded: true, violation: true, seam: false, relocation: false, reason: 'raw' });
    const s = classifyStateWrite({ destination: 'C:\\p\\STATE.md', callerFile: 'C:\\repo\\gsd-core\\bin\\lib\\state.cjs', viaSeam: true, lockHeld: true });
    assert.deepEqual(s, { recorded: true, violation: false, seam: true, relocation: false, reason: null });
    const r = classifyStateWrite({ destination: 'C:\\p\\w\\STATE.md', source: 'C:\\p\\STATE.md', callerFile: 'C:\\repo\\gsd-core\\bin\\lib\\workstream.cjs', viaSeam: false, lockHeld: true, sourceLockHeld: true });
    assert.deepEqual(r, { recorded: true, violation: false, seam: false, relocation: true, reason: null });
  });
});

describe('nodeOptionsWithRequire', () => {
  test('prepends a quoted --require and keeps existing options (the innermost run\'s shim loads first)', () => {
    assert.equal(nodeOptionsWithRequire('--max-old-space-size=4096', '/a/b.cjs'), '--require "/a/b.cjs" --max-old-space-size=4096');
    // A nested run prepends its own shim ahead of the outer run's, so its preload wins.
    const outer = nodeOptionsWithRequire(undefined, '/outer/shim.cjs');
    assert.equal(nodeOptionsWithRequire(outer, '/inner/shim.cjs'), '--require "/inner/shim.cjs" --require "/outer/shim.cjs"');
    assert.equal(nodeOptionsWithRequire(undefined, '/a/b.cjs'), '--require "/a/b.cjs"');
    assert.equal(nodeOptionsWithRequire('  ', '/a/b.cjs'), '--require "/a/b.cjs"');
  });
});

describe('formatStateWriteReport (ADR-3408 Decision 5: the zero is never reported alone)', () => {
  const ZERO = 'run-tests: raw STATE.md writes in product code: 0; seam writes and relocations onto STATE.md: 0 (0 relocations), of which without the STATE.md lock: 0; unreadable ledger lines: 0;';

  test('a clean run reports the zero beside the seam-write, relocation, unlocked and unreadable-line counts', () => {
    const entries = [
      { violation: false, seam: true, relocation: false, lockHeld: true },
      { violation: false, seam: false, relocation: true, lockHeld: true, sourceLockHeld: true },
    ];
    const r = formatStateWriteReport({ entries, tornLines: 0 });
    assert.equal(r.failed, false);
    assert.deepEqual(r.lines, ['run-tests: raw STATE.md writes in product code: 0; seam writes and relocations onto STATE.md: 2 (1 relocation), of which without the STATE.md lock: 0; unreadable ledger lines: 0; the check loaded in 0 processes']);
  });

  test('a raw write and an unlocked seam write each fail the run and are named with caller, destination and test file (#5120 review Major 1)', () => {
    const entries = [
      { violation: true, reason: 'raw', seam: false, relocation: false, lockHeld: false, fn: 'writeFileSync', destination: '/p/STATE.md', callerFile: '/r/gsd-core/bin/lib/x.cjs', callerLine: 7, testFile: '/r/tests/y.test.cjs' },
      { violation: true, reason: 'unlocked', seam: true, relocation: false, lockHeld: false, fn: 'renameSync', destination: '/p/STATE.md', callerFile: '/r/gsd-core/bin/lib/w.cjs', callerLine: 216, testFile: null },
    ];
    const r = formatStateWriteReport({ entries, tornLines: 0 });
    assert.equal(r.failed, true);
    assert.deepEqual(r.lines, [
      'run-tests: raw STATE.md writes in product code: 1; seam writes and relocations onto STATE.md: 1 (0 relocations), of which without the STATE.md lock: 1; unreadable ledger lines: 0; the check loaded in 0 processes',
      '  raw write: writeFileSync /p/STATE.md from /r/gsd-core/bin/lib/x.cjs:7 (test: /r/tests/y.test.cjs)',
      '  seam write without the STATE.md lock: renameSync /p/STATE.md from /r/gsd-core/bin/lib/w.cjs:216 (test: unknown)',
    ]);
    // The unlocked write alone fails the run: the count is enforced, not only printed.
    assert.equal(formatStateWriteReport({ entries: [entries[1]], tornLines: 0 }).failed, true);
  });

  test('an unreadable ledger is unreadable evidence: it fails the run, never reads as zero (#5170)', () => {
    const read = readStateWriteLedger(path.join(__dirname, 'no-such-ledger.ndjson'));
    assert.deepEqual(read, { entries: null, installs: 0, preloadInstalls: 0, preloadTestFiles: [], tornLines: 0 });
    const r = formatStateWriteReport(read);
    assert.equal(r.failed, true);
    assert.equal(r.lines[0], 'run-tests: raw STATE.md write check: ledger unreadable, so the check did not run');
  });

  test('a torn ledger line fails the run: it can be a violation a killed process cut off (#5120 review Minor 5)', (t) => {
    const dir = createTempDir('rswg-ledger-');
    t.after(() => cleanup(dir));
    const file = path.join(dir, 'l.ndjson');
    fs.writeFileSync(file, `${JSON.stringify(entry())}\n{"violati`);
    const read = readStateWriteLedger(file);
    assert.deepEqual(read, { entries: [entry()], installs: 0, preloadInstalls: 0, preloadTestFiles: [], tornLines: 1 });
    const r = formatStateWriteReport(read);
    assert.equal(r.failed, true, 'a torn line is unreadable evidence');
    assert.deepEqual(r.lines, [
      'run-tests: raw STATE.md writes in product code: 0; seam writes and relocations onto STATE.md: 1 (0 relocations), of which without the STATE.md lock: 0; unreadable ledger lines: 1; the check loaded in 0 processes',
      'run-tests: raw STATE.md write check: 1 ledger line did not parse (a process killed mid-record can cut off a violation), so the counts above are not evidence',
    ]);
  });

  test('a ledger line that parses to null or a string is an unreadable line, not an entry, and fails the run (#5120 review)', (t) => {
    const dir = createTempDir('rswg-null-');
    t.after(() => cleanup(dir));
    const file = path.join(dir, 'l.ndjson');
    fs.writeFileSync(file, ndjson('null', entry(), '"x"'));
    const read = readStateWriteLedger(file);
    assert.deepEqual(read, { entries: [entry()], installs: 0, preloadInstalls: 0, preloadTestFiles: [], tornLines: 2 });
    const r = formatStateWriteReport(read, { chunksRun: 0 });
    assert.equal(r.failed, true);
    assert.match(r.lines[1], /^run-tests: raw STATE\.md write check: 2 ledger lines did not parse/);
  });

  test('a line that parses to an array, and an install sentinel that also carries a write field, are unreadable lines that fail the run (#5120 pre-push review N6)', (t) => {
    const dir = createTempDir('rswg-shape-');
    t.after(() => cleanup(dir));
    const file = path.join(dir, 'l.ndjson');
    fs.writeFileSync(file, ndjson(
      entry(),
      '[1]',
      '[]',
      sentinel({ pid: 1, violation: true }),
      sentinel({ pid: 2, fn: 'writeFileSync' }),
      sentinel({ pid: 3, testFile: '/r/tests/a.test.cjs' }),
    ));
    const read = readStateWriteLedger(file);
    assert.deepEqual(read, {
      entries: [entry()], installs: 1, preloadInstalls: 1,
      preloadTestFiles: ['/r/tests/a.test.cjs'], tornLines: 4,
    });
    assert.equal(formatStateWriteReport(read).failed, true, 'unreadable lines are not evidence');
  });

  test('a ledger line is a record only in one of the two exact shapes the guard writes; every other parsed line is unreadable (#5120 pre-push review R2-n2)', (t) => {
    const dir = createTempDir('rswg-exact-');
    t.after(() => cleanup(dir));
    const file = path.join(dir, 'l.ndjson');
    const withoutKey = (o, key) => { const c = { ...o }; delete c[key]; return c; };
    const malformed = [
      {},
      { x: 1 },
      [],
      'null',
      '7',
      '"installed"',
      sentinel({ installed: 'true' }),
      sentinel({ extra: 1 }),
      withoutKey(sentinel(), 'testFile'),
      sentinel({ preload: 1 }),
      sentinel({ pid: 1.5 }),
      sentinel({ testFile: 3 }),
      withoutKey(entry(), 'relocation'),
      entry({ extra: true }),
      entry({ lockHeld: 'true' }),
      entry({ callerLine: '7' }),
      entry({ reason: 'other' }),
      entry({ sourceLockHeld: 'no' }),
      entry({ pid: '1' }),
      { installed: true, ...entry() },
    ];
    assert.ok(malformed.length >= 10);
    // The valid ones are what the real guard appends: a plain and a relocation-shaped entry, a
    // preload and a direct-require sentinel with and without a test file.
    const validEntries = [entry(), entry({ fn: 'renameSync', source: '/p/STATE.md', sourceLockHeld: false, lockHeld: true, violation: true, reason: 'unlocked', seam: false, relocation: true, callerLine: null, testFile: '/r/tests/a.test.cjs' })];
    const validSentinels = [sentinel({ testFile: '/r/tests/a.test.cjs' }), sentinel({ preload: false, pid: 2 })];
    fs.writeFileSync(file, ndjson(...malformed.slice(0, 7), validEntries[0], sentinel({ testFile: '/r/tests/a.test.cjs' }), ...malformed.slice(7), validEntries[1], validSentinels[1]));
    const read = readStateWriteLedger(file);
    assert.equal(read.tornLines, malformed.length);
    assert.deepEqual(read.entries, validEntries);
    assert.equal(read.installs, 2);
    assert.equal(read.preloadInstalls, 1);
    assert.deepEqual(read.preloadTestFiles, ['/r/tests/a.test.cjs']);
    assert.equal(formatStateWriteReport(read).failed, true, 'malformed lines are unreadable evidence');
  });

  test('install sentinels are counted beside the writes, never as one of them, and preload sentinels name their test files (#5120 audit, review Minor 6)', (t) => {
    const dir = createTempDir('rswg-sentinel-');
    t.after(() => cleanup(dir));
    const file = path.join(dir, 'l.ndjson');
    fs.writeFileSync(file, ndjson(
      sentinel({ pid: 1 }),
      entry(),
      sentinel({ preload: false, pid: 2, testFile: '/r/tests/direct.test.cjs' }),
      sentinel({ pid: 3, testFile: '/r/tests/b.test.cjs' }),
      sentinel({ pid: 4, testFile: '/r/tests/a.test.cjs' }),
      sentinel({ pid: 5, testFile: '/r/tests/a.test.cjs' }),
    ));
    // A direct-require sentinel names no test file the runner can count: only preload ones do.
    assert.deepEqual(readStateWriteLedger(file), {
      entries: [entry()], installs: 5, preloadInstalls: 4,
      preloadTestFiles: ['/r/tests/a.test.cjs', '/r/tests/b.test.cjs'], tornLines: 0,
    });
  });

  test('a run with fewer preload sentinels than spawned chunks fails and names the shim and NODE_OPTIONS (#5120 audit, review)', () => {
    const where = { chunksRun: 2, shimPath: '/tmp/ev/raw-state-write-preload.cjs', nodeOptions: '--require "/tmp/ev/raw-state-write-preload.cjs" --max-old-space-size=4096' };
    const never = formatStateWriteReport({ entries: [], installs: 0, preloadInstalls: 0, tornLines: 0 }, where);
    assert.equal(never.failed, true);
    assert.equal(never.lines[0], `${ZERO} the check loaded in 0 processes`);
    assert.equal(never.lines[1], 'run-tests: raw STATE.md write check: 2 chunks were spawned but only 0 processes recorded the preload, so the counts above are not evidence; the shim was /tmp/ev/raw-state-write-preload.cjs and each chunk received NODE_OPTIONS --require "/tmp/ev/raw-state-write-preload.cjs" --max-old-space-size=4096');
    // Every spawned chunk is itself a node process that loads the shim, so one chunk's
    // sentinel cannot vouch for another: 1 of 2 fails too.
    const one = formatStateWriteReport({ entries: [], installs: 1, preloadInstalls: 1, tornLines: 0 }, where);
    assert.equal(one.failed, true);
    assert.match(one.lines[1], /^run-tests: raw STATE\.md write check: 2 chunks were spawned but only 1 process recorded the preload/);
    // Sentinels at or above the chunk count pass.
    const loaded = formatStateWriteReport({ entries: [], installs: 2, preloadInstalls: 2, tornLines: 0 }, where);
    assert.equal(loaded.failed, false);
    assert.equal(loaded.lines.length, 1);
    assert.equal(formatStateWriteReport({ entries: [], installs: 5, preloadInstalls: 5, tornLines: 0 }, where).failed, false);
    // No chunk ran (nothing to load into): no sentinel is owed.
    assert.equal(formatStateWriteReport({ entries: [], installs: 0, preloadInstalls: 0, tornLines: 0 }, { chunksRun: 0 }).failed, false);
    // A sentinel from a direct require of the guard (NEW-1) is counted and shown, never compared.
    const direct = formatStateWriteReport({ entries: [], installs: 2, preloadInstalls: 1, tornLines: 0 }, where);
    assert.equal(direct.failed, true);
    assert.equal(direct.lines[0], `${ZERO} the check loaded in 1 process (and in 1 more by a direct require)`);
    assert.match(direct.lines[1], /only 1 process recorded the preload \(1 more installed it by a direct require, which does not vouch for a chunk\)/);
  });

  test('the NODE_OPTIONS evidence is printed whole up to 120 characters and cut after (#5120 review Minor 2)', () => {
    const where = { chunksRun: 1, shimPath: '/s.cjs' };
    const shown = (n) => formatStateWriteReport({ entries: [], installs: 0, preloadInstalls: 0, tornLines: 0 }, { ...where, nodeOptions: 'x'.repeat(n) }).lines[1];
    assert.match(shown(119), / NODE_OPTIONS x{119}$/);
    assert.match(shown(120), / NODE_OPTIONS x{120}$/);
    assert.match(shown(121), / NODE_OPTIONS x{120}\.\.\. \(121 chars\)$/);
    assert.match(shown(500), / NODE_OPTIONS x{120}\.\.\. \(500 chars\)$/);
  });

  test('a test file the runner ran that no preload sentinel names fails the run: its child ran unguarded (#5120 review Minor 6)', () => {
    // One chunk-level sentinel per chunk satisfies the chunk count; the per-file comparison is
    // what catches a test-file child that lost the shim.
    const read = { entries: [], installs: 2, preloadInstalls: 2, preloadTestFiles: [path.resolve('tests/a.test.cjs')], tornLines: 0 };
    const where = { chunksRun: 1, shimPath: '/s.cjs', nodeOptions: '--require "/s.cjs"' };
    // Relative and absolute spellings of one file compare equal (the runner passes what it was given).
    const ok = formatStateWriteReport(read, { ...where, testFilesRun: ['tests/a.test.cjs', path.resolve('tests/a.test.cjs')] });
    assert.equal(ok.failed, false, ok.lines.join('\n'));
    const missing = formatStateWriteReport(read, { ...where, testFilesRun: ['tests/a.test.cjs', 'tests/b.test.cjs'] });
    assert.equal(missing.failed, true);
    assert.equal(missing.lines[1], `run-tests: raw STATE.md write check: 1 test file left no preload sentinel (unguarded, or never started), so the counts above do not cover it: ${path.resolve('tests/b.test.cjs')}; the shim was /s.cjs and each chunk received NODE_OPTIONS --require "/s.cjs"`);
    // A long list is bounded to ten names.
    const many = Array.from({ length: 12 }, (_, i) => `tests/m${i}.test.cjs`);
    const bounded = formatStateWriteReport(read, { ...where, testFilesRun: many });
    assert.match(bounded.lines[1], /^run-tests: raw STATE\.md write check: 12 test files left no preload sentinel .*m9\.test\.cjs, and 2 more; the shim/);
  });

  const BOUNDARY_READ = { entries: [], installs: 1, preloadInstalls: 1, preloadTestFiles: [], tornLines: 0 };
  const BOUNDARY_WHERE = { chunksRun: 1, shimPath: '/s.cjs', nodeOptions: '--require "/s.cjs"' };
  const boundaryNames = (n) => Array.from({ length: n }, (_, i) => `tests/b${i}.test.cjs`);

  test('exactly nine unguarded test files are all named and no "and ... more" suffix is added (#5120 pre-push review R2-m4)', () => {
    const files = boundaryNames(9);
    const r = formatStateWriteReport(BOUNDARY_READ, { ...BOUNDARY_WHERE, testFilesRun: files });
    assert.equal(r.failed, true);
    const names = files.map((f) => path.resolve(f)).join(', ');
    assert.equal(r.lines[1], `run-tests: raw STATE.md write check: 9 test files left no preload sentinel (unguarded, or never started), so the counts above do not cover them: ${names}; the shim was /s.cjs and each chunk received NODE_OPTIONS --require "/s.cjs"`);
    assert.doesNotMatch(r.lines[1], /and \d+ more/);
  });

  test('exactly ten unguarded test files are all named and no "and ... more" suffix is added (#5120 pre-push review Mi7)', () => {
    const files = boundaryNames(10);
    const r = formatStateWriteReport(BOUNDARY_READ, { ...BOUNDARY_WHERE, testFilesRun: files });
    assert.equal(r.failed, true);
    const names = files.map((f) => path.resolve(f)).join(', ');
    assert.equal(r.lines[1], `run-tests: raw STATE.md write check: 10 test files left no preload sentinel (unguarded, or never started), so the counts above do not cover them: ${names}; the shim was /s.cjs and each chunk received NODE_OPTIONS --require "/s.cjs"`);
    assert.doesNotMatch(r.lines[1], /and \d+ more/);
  });

  test('eleven unguarded test files name the first ten and then ", and 1 more" (#5120 pre-push review Mi7)', () => {
    const files = boundaryNames(11);
    const r = formatStateWriteReport(BOUNDARY_READ, { ...BOUNDARY_WHERE, testFilesRun: files });
    assert.equal(r.failed, true);
    const names = files.slice(0, 10).map((f) => path.resolve(f)).join(', ');
    assert.equal(r.lines[1], `run-tests: raw STATE.md write check: 11 test files left no preload sentinel (unguarded, or never started), so the counts above do not cover them: ${names}, and 1 more; the shim was /s.cjs and each chunk received NODE_OPTIONS --require "/s.cjs"`);
    assert.ok(!r.lines[1].includes(path.resolve('tests/b10.test.cjs')), 'the eleventh name is counted, not printed');
  });

  test('a sentinel naming a file through its real path vouches for the same file listed through a symlinked directory (#5120 pre-push review Q1)', (t) => {
    if (process.platform === 'win32') {
      t.skip('symlink creation needs privileges on win32, so the row cannot build its fixture there');
      return;
    }
    const dir = createTempDir('rswg-symlink-');
    t.after(() => cleanup(dir));
    const real = path.join(dir, 'real');
    fs.mkdirSync(real);
    fs.writeFileSync(path.join(real, 'a.test.cjs'), '');
    const link = path.join(dir, 'link');
    fs.symlinkSync(real, link, 'dir');
    const read = { ...BOUNDARY_READ, preloadTestFiles: [fs.realpathSync(path.join(real, 'a.test.cjs'))] };
    const r = formatStateWriteReport(read, { ...BOUNDARY_WHERE, testFilesRun: [path.join(link, 'a.test.cjs')] });
    assert.equal(r.failed, false, r.lines.join('\n'));
    assert.doesNotMatch(r.lines.join('\n'), /left no preload sentinel/);
  });

  test('a missing test file listed twice, once relative and once absolute, is reported once (#5120 pre-push review Q1)', () => {
    const rel = 'tests/never-ran.test.cjs';
    const r = formatStateWriteReport(BOUNDARY_READ, { ...BOUNDARY_WHERE, testFilesRun: [rel, path.resolve(rel)] });
    assert.equal(r.failed, true);
    assert.match(r.lines[1], /^run-tests: raw STATE\.md write check: 1 test file left no preload sentinel /);
    assert.equal(r.lines[1].split(path.resolve(rel)).length - 1, 1, 'the file is named once');
  });
  describe('sameFileKey', () => {
    test('on win32 two spellings of one path that differ only in case, drive letter included, give the same key (#5120 pre-push review Q)', () => {
      assert.equal(sameFileKey('C:\\Repo\\Tests\\A.test.cjs', 'win32'), sameFileKey('c:\\repo\\tests\\a.test.cjs', 'win32'));
    });

    test('on linux two names that differ only in case give different keys (#5120 pre-push review Q)', () => {
      assert.notEqual(sameFileKey('/Repo/Tests/A.test.cjs', 'linux'), sameFileKey('/repo/tests/a.test.cjs', 'linux'));
    });

    test('a symlinked path and its target give the same key (#5120 pre-push review Q)', (t) => {
      if (process.platform === 'win32') {
        t.skip('symlink creation needs privileges on win32, so the row cannot build its fixture there');
        return;
      }
      const dir = createTempDir('rswg-key-');
      t.after(() => cleanup(dir));
      const target = path.join(dir, 'a.test.cjs');
      fs.writeFileSync(target, '');
      const link = path.join(dir, 'link.cjs');
      fs.symlinkSync(target, link, 'file');
      assert.equal(sameFileKey(link), sameFileKey(target));
      assert.equal(sameFileKey(link, 'linux'), sameFileKey(target, 'linux'));
    });
  });
});
