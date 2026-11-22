'use strict';

/**
 * #5120 (epic #4629, ADR-4629 guard roster "No raw STATE.md write outside the
 * seam"): the rows of the test-time value check that need a real process
 * (TESTING-STANDARDS.md "In-process CLI tests: the rules", rule 2).
 *
 * Why these rows spawn: the guard is a NODE_OPTIONS --require preload, and a preload only acts
 * in a fresh node process: nothing in-process can load it, wrap that process's fs, or show what
 * a child that inherited it does. So the "preload in a real child process" rows run a script
 * under the preload and read its ledger, and the "scripts/run-tests.cjs runs the check" rows run
 * the runner itself (scripts/run-tests.cjs), the thing that installs the preload for the suite,
 * end to end. The pure rows (classification, report formatting) are in
 * raw-state-write-guard.test.cjs.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTempDir, cleanup } = require('./helpers.cjs');
const { PROBE_TIMEOUT_MS, RUN_TESTS_HARNESS_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { runNode } = require('./helpers/process-seam.cjs');
const { isolatedEnv } = require('./helpers/isolated-env.cjs');
const { splitLines } = require('../gsd-core/bin/lib/text-lines.cjs');

const RUNNER = path.join(__dirname, '..', 'scripts', 'run-tests.cjs');
const ISOLATED_ENV_HELPER = path.join(__dirname, 'helpers', 'isolated-env.cjs');
const BUILT_LIB = path.join(__dirname, '..', 'gsd-core', 'bin', 'lib');

const GUARD_PATH = path.join(__dirname, '..', 'scripts', 'raw-state-write-guard.cjs');
const {
  nodeOptionsWithRequire,
  readStateWriteLedger,
  formatStateWriteReport,
  preloadShimSource,
} = require(GUARD_PATH);

/**
 * Lay out a fake install: `<dir>/gsd-core/bin/lib/<name>` holds `body`. A
 * frame in this tree is product code to the guard, exactly as the compiled
 * `gsd-core/bin/lib/*.cjs` (or an installed copy of it) is.
 */
function writeModule(dir, rel, body) {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return file;
}

/**
 * Run `script` in a child that loads the guard the way the runner does. The child's
 * env is built with isolatedEnv (CONTRIBUTING: never a spread of the parent's env); it
 * strips every GSD_* variable, so the ledger path is opted back in through `override`,
 * the same opt-in the runner's preload shim makes for the suite.
 */
function runGuardedLedger(dir, script, extraEnv = {}) {
  const ledger = path.join(dir, 'ledger.ndjson');
  const env = isolatedEnv({
    home: dir,
    override: { ...extraEnv, GSD_STATE_WRITE_LEDGER: ledger, NODE_OPTIONS: nodeOptionsWithRequire(undefined, GUARD_PATH) },
  });
  const r = runNode([script], { cwd: dir, env, timeoutMs: PROBE_TIMEOUT_MS });
  assert.equal(r.exitCode, 0, `child failed: ${r.stderr}`);
  return readStateWriteLedger(ledger);
}
const runGuarded = (dir, script, extraEnv) => runGuardedLedger(dir, script, extraEnv).entries;

describe('the preload in a real child process (#5120; real processes: the guard only acts in a fresh node process)', () => {
  test('a raw product write onto STATE.md is a violation, for every covered fs entry point', (t) => {
    const dir = createTempDir('rswg-raw-');
    t.after(() => cleanup(dir));
    const target = path.join(dir, '.planning', 'STATE.md');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    writeModule(dir, 'gsd-core/bin/lib/writer.cjs', `'use strict';
const fs = require('node:fs');
const { writeFileSync } = require('fs');
module.exports = async (target) => {
  fs.writeFileSync(target, 'a');
  writeFileSync(target, 'b');
  fs.appendFileSync(target, 'c');
  fs.writeFileSync(target + '.tmp', 'd'); fs.renameSync(target + '.tmp', target);
  fs.writeFileSync(target + '.src', 'e'); fs.copyFileSync(target + '.src', target);
  fs.cpSync(target + '.src', target);
  await fs.promises.writeFile(target, 'f');
  await fs.promises.cp(target + '.src', target);
  await new Promise((res, rej) => fs.writeFile(target, 'g', (e) => (e ? rej(e) : res())));
  fs.writeFileSync(new URL('file://' + target.replace(/\\\\/g, '/').replace(/^([A-Za-z]):/, '/$1:')), 'h');
};
`);
    const main = writeModule(dir, 'tests/main.cjs', `require(${JSON.stringify(path.join(dir, 'gsd-core/bin/lib/writer.cjs'))})(${JSON.stringify(target)});`);
    const entries = runGuarded(dir, main);
    assert.deepEqual(
      entries.map((e) => e.fn),
      // fs.promises.cp, awaited here, is recorded once, as the fs.promises.copyFile it calls.
      ['writeFileSync', 'writeFileSync', 'appendFileSync', 'renameSync', 'copyFileSync', 'cpSync', 'promises.writeFile', 'promises.copyFile', 'writeFile', 'writeFileSync'],
    );
    assert.ok(entries.every((e) => e.violation === true && e.lockHeld === false), JSON.stringify(entries));
    assert.ok(entries.every((e) => path.basename(e.callerFile) === 'writer.cjs'), 'attributed to the product frame, not the preload or node:fs');
  });

  test('a seam write is attributed to the code that called the seam; under the lock it passes, and test code calling the seam is not recorded', (t) => {
    const dir = createTempDir('rswg-neg-');
    t.after(() => cleanup(dir));
    const target = path.join(dir, '.planning', 'STATE.md');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // The seam's own shapes, inside a function named platformWriteSync: tmp write
    // + rename (through a helper, as atomicRenameWithRetry does), and the fallback.
    writeModule(dir, 'gsd-core/bin/lib/shell-command-projection.cjs', `'use strict';
const fs = require('node:fs');
function renameHelper(from, to) { fs.renameSync(from, to); }
function platformWriteSync(target) {
  fs.writeFileSync(target + '.tmp.1', 'x'); renameHelper(target + '.tmp.1', target);
  fs.writeFileSync(target, 'fallback');
}
module.exports = { platformWriteSync };
`);
    // A product caller holding the STATE.md lock the way withStateLock does (the lock file names its pid).
    writeModule(dir, 'gsd-core/bin/lib/caller.cjs', `'use strict';
const fs = require('node:fs');
const { platformWriteSync } = require('./shell-command-projection.cjs');
module.exports = (target) => {
  fs.writeFileSync(target + '.lock', String(process.pid));
  try { platformWriteSync(target); } finally { fs.unlinkSync(target + '.lock'); }
};
`);
    writeModule(dir, 'gsd-core/bin/lib/other.cjs', `'use strict';
const fs = require('node:fs');
module.exports = (dir) => { fs.writeFileSync(dir + '/STATE.md.bak', 'x'); fs.writeFileSync(dir + '/PROJECT.md', 'x'); };
`);
    const main = writeModule(dir, 'tests/main.cjs', `'use strict';
const fs = require('node:fs');
require(${JSON.stringify(path.join(dir, 'gsd-core/bin/lib/caller.cjs'))})(${JSON.stringify(target)});
require(${JSON.stringify(path.join(dir, 'gsd-core/bin/lib/other.cjs'))})(${JSON.stringify(path.dirname(target))});
fs.writeFileSync(${JSON.stringify(target)}, 'fixture written by a test');
require(${JSON.stringify(path.join(dir, 'gsd-core/bin/lib/shell-command-projection.cjs'))}).platformWriteSync(${JSON.stringify(target)});
`);
    const entries = runGuarded(dir, main);
    assert.equal(entries.filter((e) => e.violation).length, 0, JSON.stringify(entries));
    assert.deepEqual(
      entries.map((e) => [e.fn, e.seam, e.lockHeld, path.basename(e.callerFile), e.callerLine]),
      [['renameSync', true, true, 'caller.cjs', 6], ['writeFileSync', true, true, 'caller.cjs', 6]],
      'seam writes are recorded against the caller of the seam; the test\'s own seam call is test code',
    );
  });

  test('a seam write onto STATE.md without the STATE.md lock is a violation naming the code that called the seam (#5120 review Major 1)', (t) => {
    const dir = createTempDir('rswg-unlocked-');
    t.after(() => cleanup(dir));
    const target = path.join(dir, 'STATE.md');
    writeModule(dir, 'gsd-core/bin/lib/shell-command-projection.cjs', `'use strict';
const fs = require('node:fs');
function platformWriteSync(target) { fs.writeFileSync(target + '.tmp.1', 'x'); fs.renameSync(target + '.tmp.1', target); }
module.exports = { platformWriteSync };
`);
    writeModule(dir, 'gsd-core/bin/lib/writer.cjs', `'use strict';
const fs = require('node:fs');
const { platformWriteSync } = require('./shell-command-projection.cjs');
module.exports = (target, pid) => {
  fs.writeFileSync(target + '.lock', String(pid));
  try { platformWriteSync(target); } finally { fs.unlinkSync(target + '.lock'); }
  platformWriteSync(target);
};
`);
    const main = writeModule(dir, 'tests/main.cjs', `require(${JSON.stringify(path.join(dir, 'gsd-core/bin/lib/writer.cjs'))})(${JSON.stringify(target)}, process.pid + 1);`);
    const entries = runGuarded(dir, main);
    // A lock body naming another pid is not this process's lock, and no lock file is no lock.
    assert.deepEqual(
      entries.map((e) => [e.fn, e.seam, e.lockHeld, e.violation, e.reason, path.basename(e.callerFile), e.callerLine]),
      [['renameSync', true, false, true, 'unlocked', 'writer.cjs', 6], ['renameSync', true, false, true, 'unlocked', 'writer.cjs', 7]],
      JSON.stringify(entries),
    );
    const report = formatStateWriteReport({ entries, tornLines: 0 });
    assert.equal(report.failed, true);
    assert.equal(report.lines[1], `  seam write without the STATE.md lock: renameSync ${target} from ${path.join(dir, 'gsd-core/bin/lib/writer.cjs')}:6 (test: unknown)`);
  });

  test('a FIFO at the STATE.md lock path is not a lock this process holds, and reading it never blocks the observed write (#5120 pre-push review N3)', (t) => {
    if (process.platform === 'win32') { t.skip('no mkfifo on win32'); return; }
    const dir = createTempDir('rswg-fifo-');
    t.after(() => cleanup(dir));
    const target = path.join(dir, 'STATE.md');
    // mkfifo runs through the process seam: a node child that runs it.
    const made = runNode(['-e', "require('child_process').execFileSync('mkfifo', [process.argv[1]])", path.join(dir, 'STATE.md.lock')], { cwd: dir, timeoutMs: PROBE_TIMEOUT_MS });
    // On POSIX a mkfifo failure fails the row (repo precedent: a fixture that cannot be built is an error, not a skip).
    if (made.exitCode !== 0) throw new Error(`mkfifo failed (exit ${made.exitCode}): ${made.stderr}`);
    assert.ok(fs.lstatSync(`${target}.lock`).isFIFO(), 'precondition: the lock path is a FIFO');
    writeModule(dir, 'gsd-core/bin/lib/shell-command-projection.cjs', `'use strict';
const fs = require('node:fs');
function platformWriteSync(target) { fs.writeFileSync(target + '.tmp.1', 'x'); fs.renameSync(target + '.tmp.1', target); }
module.exports = { platformWriteSync };
`);
    writeModule(dir, 'gsd-core/bin/lib/writer.cjs', `'use strict';
const { platformWriteSync } = require('./shell-command-projection.cjs');
module.exports = (target) => { platformWriteSync(target); };
`);
    const main = writeModule(dir, 'tests/main.cjs', `require(${JSON.stringify(path.join(dir, 'gsd-core/bin/lib/writer.cjs'))})(${JSON.stringify(target)});`);
    const entries = runGuarded(dir, main);
    assert.deepEqual(
      entries.map((e) => [e.fn, e.seam, e.lockHeld, e.violation, e.reason]),
      [['renameSync', true, false, true, 'unlocked']],
      JSON.stringify(entries),
    );
  });

  test('a rename of a STATE.md onto a STATE.md is a relocation: it passes only with the lock on both ends (#5120 review Major 3)', (t) => {
    const dir = createTempDir('rswg-reloc-');
    t.after(() => cleanup(dir));
    writeModule(dir, 'gsd-core/bin/lib/shell-command-projection.cjs', `'use strict';
const fs = require('node:fs');
function retryRenameSync(from, to) { fs.renameSync(from, to); }
module.exports = { retryRenameSync };
`);
    writeModule(dir, 'gsd-core/bin/lib/mover.cjs', `'use strict';
const fs = require('node:fs');
const { retryRenameSync } = require('./shell-command-projection.cjs');
const lock = (p) => fs.writeFileSync(p + '.lock', String(process.pid));
const unlock = (p) => fs.unlinkSync(p + '.lock');
module.exports = (a, b) => {
  retryRenameSync(a, b);
  lock(b); retryRenameSync(b, a); unlock(b);
  lock(a); lock(b); retryRenameSync(a, b); unlock(a); unlock(b);
  lock(a); retryRenameSync(b, a); unlock(a);
};
`);
    const a = path.join(dir, 'one', 'STATE.md');
    const b = path.join(dir, 'two', 'STATE.md');
    fs.mkdirSync(path.dirname(a));
    fs.mkdirSync(path.dirname(b));
    fs.writeFileSync(a, 'state');
    const main = writeModule(dir, 'tests/main.cjs', `require(${JSON.stringify(path.join(dir, 'gsd-core/bin/lib/mover.cjs'))})(${JSON.stringify(a)}, ${JSON.stringify(b)});`);
    const entries = runGuarded(dir, main);
    assert.deepEqual(
      entries.map((e) => [e.relocation, e.sourceLockHeld, e.lockHeld, e.violation, e.reason, e.callerLine]),
      [
        [true, false, false, true, 'unlocked', 7],
        [true, true, false, true, 'unlocked', 8],
        [true, true, true, false, null, 9],
        [true, false, true, true, 'unlocked', 10],
      ],
      JSON.stringify(entries),
    );
    const report = formatStateWriteReport({ entries, tornLines: 0 });
    assert.equal(report.failed, true);
    assert.match(report.lines[0], /seam writes and relocations onto STATE\.md: 4 \(4 relocations\), of which without the STATE\.md lock: 3;/);
    assert.equal(report.lines[1], `  relocation without the STATE.md lock on the source and the destination: renameSync ${a} -> ${b} from ${path.join(dir, 'gsd-core/bin/lib/mover.cjs')}:7 (test: unknown)`);
    assert.equal(report.lines[2], `  relocation without the STATE.md lock on the destination: renameSync ${b} -> ${a} from ${path.join(dir, 'gsd-core/bin/lib/mover.cjs')}:8 (test: unknown)`);
    assert.equal(report.lines[3], `  relocation without the STATE.md lock on the source: renameSync ${b} -> ${a} from ${path.join(dir, 'gsd-core/bin/lib/mover.cjs')}:10 (test: unknown)`);
  });

  test('the real filesystem stateIO adapter writes STATE.md through the seam, under the STATE.md lock (#5120)', (t) => {
    const dir = createTempDir('rswg-state-io-');
    t.after(() => cleanup(dir));
    const target = path.join(dir, '.planning', 'STATE.md');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // The built adapter (gsd-core/bin/lib/state-io.cjs), the module MCP gsd_write_state reaches.
    const stateIo = path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'state-io.cjs');
    const main = writeModule(dir, 'tests/main.cjs', `const { createStateIO } = require(${JSON.stringify(stateIo)});
createStateIO({ io: 'filesystem' }).write(${JSON.stringify(target)}, '# State\\n');`);
    const entries = runGuarded(dir, main);
    assert.deepEqual(
      entries.map((e) => ({ fn: e.fn, violation: e.violation, seam: e.seam, lockHeld: e.lockHeld })),
      [{ fn: 'renameSync', violation: false, seam: true, lockHeld: true }],
      JSON.stringify(entries),
    );
  });

  test('the real workstream migrate, create and complete move and write STATE.md under the STATE.md lock (#5120 review Major 1, Major 3)', (t) => {
    const dir = createTempDir('rswg-workstream-');
    t.after(() => cleanup(dir));
    const planning = path.join(dir, '.planning');
    fs.mkdirSync(planning, { recursive: true });
    fs.writeFileSync(path.join(planning, 'STATE.md'), '# Project State\n');
    fs.writeFileSync(path.join(planning, 'ROADMAP.md'), '# Roadmap\n');
    // The built module (gsd-core/bin/lib/workstream.cjs), the one gsd-tools `workstream` reaches.
    const workstream = path.join(BUILT_LIB, 'workstream.cjs');
    const main = writeModule(dir, 'tests/main.cjs', `'use strict';
const ws = require(${JSON.stringify(workstream)});
const dir = ${JSON.stringify(dir)};
ws.migrateToWorkstreams(dir, 'alpha');
ws.cmdWorkstreamCreate(dir, 'beta', {}, true);
ws.cmdWorkstreamComplete(dir, 'alpha', {}, true);
`);
    const entries = runGuarded(dir, main);
    assert.equal(entries.length, 3, JSON.stringify(entries, null, 1));
    assert.equal(entries.filter((e) => e.violation).length, 0, JSON.stringify(entries, null, 1));
    const rel = (p) => path.relative(dir, p).split(path.sep).join('/');
    assert.deepEqual(
      entries.map((e) => [e.relocation, e.seam, rel(e.destination), path.basename(e.callerFile)]),
      [
        [true, false, '.planning/workstreams/alpha/STATE.md', 'workstream.cjs'],
        [false, true, '.planning/workstreams/beta/STATE.md', 'workstream.cjs'],
        [true, false, `.planning/milestones/${path.basename(path.dirname(entries[2].destination))}/STATE.md`, 'workstream.cjs'],
      ],
      JSON.stringify(entries, null, 1),
    );
    assert.ok(entries.every((e) => e.lockHeld === true && (e.relocation ? e.sourceLockHeld === true : true)), JSON.stringify(entries, null, 1));
    assert.ok(path.basename(path.dirname(entries[2].destination)).startsWith('ws-alpha-'), 'the archive move');
    // No lock file is left behind in any directory the STATE.md moved through.
    const leftover = [];
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith('.lock')) leftover.push(rel(p)); } };
    walk(planning);
    assert.deepEqual(leftover, []);
  });

  test('the seam module\'s byte-exact restore (platformRestoreFileSync, #5831) onto STATE.md under the lock is a seam write, never a violation', (t) => {
    const dir = createTempDir('rswg-restore-');
    t.after(() => cleanup(dir));
    const target = path.join(dir, '.planning', 'STATE.md');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'before');
    // The real built seam module: the restore primitive publishes through the same
    // tmp-and-rename path platformWriteSync uses (readModifyWriteStateMd's write-failure
    // rollback and the roadmap-upgrade rollback both restore STATE.md through it).
    writeModule(dir, 'gsd-core/bin/lib/restorer.cjs', `'use strict';
const { platformRestoreFileSync } = require(${JSON.stringify(path.join(BUILT_LIB, 'shell-command-projection.cjs'))});
const fs = require('node:fs');
module.exports = (target) => {
  fs.writeFileSync(target + '.lock', String(process.pid));
  try { platformRestoreFileSync(target, Buffer.from('restored\\n')); } finally { fs.unlinkSync(target + '.lock'); }
};
`);
    const main = writeModule(dir, 'tests/main.cjs', `require(${JSON.stringify(path.join(dir, 'gsd-core/bin/lib/restorer.cjs'))})(${JSON.stringify(target)});`);
    const entries = runGuarded(dir, main);
    assert.deepEqual(entries.map((e) => [e.fn, e.seam, e.violation]), [['renameSync', true, false]], JSON.stringify(entries));
    assert.equal(fs.readFileSync(target, 'utf8'), 'restored\n', 'the restore landed byte-exactly');
  });

  test('a rename onto STATE.md through the seam module\'s retryRenameSync is a violation (#5120 review)', (t) => {
    const dir = createTempDir('rswg-rename-');
    t.after(() => cleanup(dir));
    const target = path.join(dir, 'STATE.md');
    writeModule(dir, 'gsd-core/bin/lib/shell-command-projection.cjs', `'use strict';
const fs = require('node:fs');
function retryRenameSync(from, to) { fs.renameSync(from, to); }
module.exports = { retryRenameSync };
`);
    writeModule(dir, 'gsd-core/bin/lib/writer.cjs', `'use strict';
const fs = require('node:fs');
const { retryRenameSync } = require('./shell-command-projection.cjs');
module.exports = (target) => { fs.writeFileSync(target + '.tmp', 'raw'); retryRenameSync(target + '.tmp', target); };
`);
    const main = writeModule(dir, 'tests/main.cjs', `require(${JSON.stringify(path.join(dir, 'gsd-core/bin/lib/writer.cjs'))})(${JSON.stringify(target)});`);
    const entries = runGuarded(dir, main);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].fn, 'renameSync');
    assert.equal(entries[0].violation, true, 'raw bytes renamed onto STATE.md outside platformWriteSync');
  });

  test('a subprocess the test spawns inherits the guard and the test-file attribution', (t) => {
    const dir = createTempDir('rswg-sub-');
    t.after(() => cleanup(dir));
    const target = path.join(dir, 'STATE.md');
    const writer = writeModule(dir, 'gsd-core/bin/gsd-tools.cjs', `require('node:fs').writeFileSync(${JSON.stringify(target)}, 'x');`);
    const main = writeModule(dir, 'tests/parent.test.cjs', `'use strict';
const r = require('node:child_process').spawnSync(process.execPath, [${JSON.stringify(writer)}], { stdio: 'inherit', timeout: 30000 });
process.exitCode = r.status;`);
    const read = runGuardedLedger(dir, main, { NODE_TEST_CONTEXT: 'child-v8' });
    const entries = read.entries;
    assert.equal(entries.length, 1);
    assert.equal(entries[0].violation, true);
    assert.equal(entries[0].testFile, main, 'the violation names the test file whose subprocess wrote');
    // One install sentinel per process that loaded the preload: the parent and its child
    // (#5120 audit: a guard that never loaded must not read as zero violations).
    assert.equal(read.installs, 2, JSON.stringify(read));
    // Loaded by --require of the guard file itself, not through the runner's shim: not a preload.
    assert.equal(read.preloadInstalls, 0, JSON.stringify(read));
  });

  test('only a sentinel written through the runner shim vouches for a chunk; a direct require of the guard installs but cannot mask a chunk whose preload never loaded (#5120 re-review NEW-1)', (t) => {
    const dir = createTempDir('rswg-preload-');
    t.after(() => cleanup(dir));
    const main = writeModule(dir, 'tests/main.cjs', `process.stdout.write('ok');`);
    // The real path: the shim the runner writes, in NODE_OPTIONS, nothing else in the env.
    const viaShim = path.join(dir, 'via-shim.ndjson');
    const shim = writeModule(dir, 'ev/raw-state-write-preload.cjs', preloadShimSource(viaShim));
    let r = runNode([main], { cwd: dir, env: isolatedEnv({ home: dir, override: { NODE_OPTIONS: nodeOptionsWithRequire(undefined, shim) } }), timeoutMs: PROBE_TIMEOUT_MS });
    assert.equal(r.stdout, 'ok', r.stderr);
    const preloaded = readStateWriteLedger(viaShim);
    assert.deepEqual([preloaded.installs, preloaded.preloadInstalls], [1, 1], JSON.stringify(preloaded));
    assert.equal(formatStateWriteReport(preloaded, { chunksRun: 1 }).failed, false);
    // The masking case: the chunk's NODE_OPTIONS is empty (its preload never loaded) and a
    // test file requires the guard directly with the ledger variable the runner also passes.
    const direct = path.join(dir, 'direct.ndjson');
    const requirer = writeModule(dir, 'tests/requirer.cjs', `require(${JSON.stringify(GUARD_PATH)}); process.stdout.write('ok');`);
    r = runNode([requirer], { cwd: dir, env: isolatedEnv({ home: dir, override: { NODE_OPTIONS: '', GSD_STATE_WRITE_LEDGER: direct } }), timeoutMs: PROBE_TIMEOUT_MS });
    assert.equal(r.stdout, 'ok', r.stderr);
    const masked = readStateWriteLedger(direct);
    assert.deepEqual([masked.installs, masked.preloadInstalls], [1, 0], JSON.stringify(masked));
    const report = formatStateWriteReport(masked, { chunksRun: 1 });
    assert.equal(report.failed, true, 'a direct-require sentinel must not vouch for the chunk');
    assert.match(report.lines[1], /only 0 processes recorded the preload \(1 more installed it by a direct require, which does not vouch for a chunk\)/);
  });

  test('without a ledger the preload is inert: no wrapper is installed', (t) => {
    const dir = createTempDir('rswg-inert-');
    t.after(() => cleanup(dir));
    const main = writeModule(dir, 'tests/main.cjs', `const fs = require('node:fs'); const before = fs.writeFileSync;
require(${JSON.stringify(GUARD_PATH)});
process.stdout.write(String(fs.writeFileSync === before && !fs.writeFileSync.name.includes('guard')));`);
    // isolatedEnv strips GSD_STATE_WRITE_LEDGER; the parent's NODE_OPTIONS (the runner's
    // shim, when this file runs under run-tests) is cleared so only the explicit require loads.
    const env = isolatedEnv({ home: dir, override: { NODE_OPTIONS: '' } });
    const r = runNode([main], { cwd: dir, env, timeoutMs: PROBE_TIMEOUT_MS });
    assert.equal(r.stdout, 'true', r.stderr);
  });

  test('loading the shim leaves os.tmpdir() to the child: a child that presents itself as win32 reads its TEMP/TMP, not the TMPDIR it inherited (#5120, #5848)', (t) => {
    // node:os picks its win32 or POSIX tmpdir branch once, when it first loads. A preload that
    // loads it (reading fs.promises does, through internal/fs/promises) fixes the POSIX branch
    // before the child's own code runs, so a child that spoofs process.platform, as the #5848
    // install probe does, reads TMPDIR (the runner's run root) instead of the TEMP/TMP it was
    // handed. TMPDIR differs from TEMP/TMP so the two branches give different answers. On a real
    // win32 host the spoof is a no-op and the row is green either way; it discriminates on POSIX.
    const dir = createTempDir('rswg-tmpdir-');
    t.after(() => cleanup(dir));
    const given = path.join(dir, 'given-temp');
    const inherited = path.join(dir, 'inherited-tmpdir');
    fs.mkdirSync(given);
    fs.mkdirSync(inherited);
    const main = writeModule(dir, 'tests/main.cjs', `Object.defineProperty(process, 'platform', { value: 'win32' });
process.stdout.write(require('node:os').tmpdir());`);
    const ledger = path.join(dir, 'ledger.ndjson');
    const shim = writeModule(dir, 'ev/raw-state-write-preload.cjs', preloadShimSource(ledger));
    const env = isolatedEnv({
      home: dir,
      override: { NODE_OPTIONS: nodeOptionsWithRequire(undefined, shim), TEMP: given, TMP: given, TMPDIR: inherited },
    });
    const r = runNode([main], { cwd: dir, env, timeoutMs: PROBE_TIMEOUT_MS });
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(readStateWriteLedger(ledger).preloadInstalls, 1, 'the shim loaded in the child, so the row tests it');
    assert.equal(r.stdout, given, 'os.tmpdir() under the shim must be the TEMP/TMP the child was given');
  });

  // One row per spelling, each in a fresh child where nothing reads fs.promises or requires the
  // other spelling first: both return the one shared object, so a row that used both would stay
  // green with either spelling dropped from the require hook (#5120 review Minor 3).
  for (const spec of ['fs/promises', 'node:fs/promises']) {
    test(`a product write onto STATE.md through require('${spec}') alone, never through fs.promises, is still a violation (#5120)`, (t) => {
      const dir = createTempDir('rswg-fsp-');
      t.after(() => cleanup(dir));
      const target = path.join(dir, '.planning', 'STATE.md');
      fs.mkdirSync(path.dirname(target), { recursive: true });
      writeModule(dir, 'gsd-core/bin/lib/writer.cjs', `'use strict';
const fsp = require(${JSON.stringify(spec)});
module.exports = async (target) => { await fsp.writeFile(target, 'a'); await fsp.appendFile(target, 'b'); };
`);
      const main = writeModule(dir, 'tests/main.cjs', `require(${JSON.stringify(path.join(dir, 'gsd-core/bin/lib/writer.cjs'))})(${JSON.stringify(target)});`);
      const entries = runGuarded(dir, main);
      assert.deepEqual(entries.map((e) => [e.fn, e.violation]), [['promises.writeFile', true], ['promises.appendFile', true]], JSON.stringify(entries));
    });

    test(`process.getBuiltinModule('${spec}') as the first reach wraps the promise API, so a cp through it first leaves a later fs.promises.cp seen (#5120)`, (t) => {
      const dir = createTempDir('rswg-gbm-');
      t.after(() => cleanup(dir));
      const target = path.join(dir, '.planning', 'STATE.md');
      fs.mkdirSync(path.dirname(target), { recursive: true });
      // The cp onto a non-STATE.md file loads node's cp module, which takes copyFile from the
      // promises object once; unwrapped at that moment, every later fs.promises.cp is unseen.
      writeModule(dir, 'gsd-core/bin/lib/writer.cjs', `'use strict';
const fs = require('node:fs');
const path = require('node:path');
module.exports = async (target) => {
  const src = path.join(path.dirname(target), 'src.txt');
  fs.writeFileSync(src, 'x');
  const p = process.getBuiltinModule(${JSON.stringify(spec)});
  await p.cp(src, path.join(path.dirname(target), 'other.txt'));
  await p.writeFile(target, 'a');
  await fs.promises.cp(src, target);
};
`);
      const main = writeModule(dir, 'tests/main.cjs', `require(${JSON.stringify(path.join(dir, 'gsd-core/bin/lib/writer.cjs'))})(${JSON.stringify(target)});`);
      const entries = runGuarded(dir, main);
      assert.deepEqual(entries.map((e) => [e.fn, e.violation]), [['promises.writeFile', true], ['promises.copyFile', true]], JSON.stringify(entries));
    });
  }

  test('known limit, pinned as it stands: an ES module import of fs/promises is not a reach that wraps the promise API (#5120 review Minor 1, Minor 2)', (t) => {
    // The guard's header states this limit. If a change makes either child below record, update
    // that header, the limits paragraph in TESTING-SUITES.md and this row together. Each child
    // asserts the bytes landed, so an empty ledger is an unseen real write, not a dead child.
    const dir = createTempDir('rswg-esm-');
    t.after(() => cleanup(dir));
    // 1. Test code runs a cp through the import first; a later product fs.promises.cp onto STATE.md
    //    copies through the unwrapped copyFile node's cp module took when it loaded.
    const cpDir = path.join(dir, 'cp');
    const cpTarget = path.join(cpDir, '.planning', 'STATE.md');
    fs.mkdirSync(path.dirname(cpTarget), { recursive: true });
    writeModule(cpDir, 'gsd-core/bin/lib/writer.cjs', `'use strict';
const fs = require('node:fs');
module.exports = async (src, target) => { await fs.promises.cp(src, target); };
`);
    const cpMain = writeModule(cpDir, 'tests/main.cjs', `'use strict';
const fs = require('node:fs');
const path = require('node:path');
(async () => {
  const src = path.join(${JSON.stringify(cpDir)}, 'src.txt');
  fs.writeFileSync(src, 'copied');
  const m = await import('node:fs/promises');
  await m.cp(src, path.join(${JSON.stringify(cpDir)}, 'other.txt'));
  await require(${JSON.stringify(path.join(cpDir, 'gsd-core/bin/lib/writer.cjs'))})(src, ${JSON.stringify(cpTarget)});
})().catch((e) => { console.error(e); process.exitCode = 1; });
`);
    assert.deepEqual(runGuarded(cpDir, cpMain), []);
    assert.equal(fs.readFileSync(cpTarget, 'utf8'), 'copied', 'the unseen cp landed');
    // 2. A named binding taken from the import before any reach stays unwrapped after a later
    //    fs.promises read; the module's default object, read after that, is the wrapped one.
    const namedDir = path.join(dir, 'named');
    const early = path.join(namedDir, 'a', 'STATE.md');
    const late = path.join(namedDir, 'b', 'STATE.md');
    fs.mkdirSync(path.dirname(early), { recursive: true });
    fs.mkdirSync(path.dirname(late), { recursive: true });
    writeModule(namedDir, 'gsd-core/bin/lib/writer.cjs', `'use strict';
module.exports = async (early, late) => {
  const m = await import('fs/promises');
  const { writeFile } = m;
  void require('node:fs').promises;
  await writeFile(early, 'named');
  await m.default.writeFile(late, 'default');
};
`);
    const namedMain = writeModule(namedDir, 'tests/main.cjs', `require(${JSON.stringify(path.join(namedDir, 'gsd-core/bin/lib/writer.cjs'))})(${JSON.stringify(early)}, ${JSON.stringify(late)});`);
    const named = runGuarded(namedDir, namedMain);
    assert.deepEqual(named.map((e) => [e.fn, e.destination]), [['promises.writeFile', late]], JSON.stringify(named));
    assert.equal(fs.readFileSync(early, 'utf8'), 'named', 'the unseen named-binding write landed');
  });

  test('known limits, pinned as they stand: these example shapes land their bytes on STATE.md and are not recorded (#5120 pre-push review R2-n3, R3-n2)', async (t) => {
    // TESTING-SUITES.md states these limits. If a change makes a shape below record, update its
    // limits list, the limits predicate in CONTEXT.md and this row together. Each child asserts the bytes landed, so an empty ledger is an unseen real write, not
    // a dead child. Every body is product code (under gsd-core/bin/lib) and uses node alone.
    const shapes = [
      {
        name: 'writeFileSync on a descriptor from openSync',
        file: '.planning/STATE.md', bytes: 'by descriptor',
        body: `const fs = require('node:fs'); const path = require('node:path');
module.exports = async (root) => {
  const target = path.join(root, '.planning', 'STATE.md');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const fd = fs.openSync(target, 'w');
  try { fs.writeFileSync(fd, 'by descriptor'); } finally { fs.closeSync(fd); }
};`,
      },
      {
        name: 'fs.linkSync from another file onto STATE.md',
        file: '.planning/STATE.md', bytes: 'linked', linkSupportMarker: 'LINK-UNSUPPORTED',
        body: `const fs = require('node:fs'); const path = require('node:path');
module.exports = async (root) => {
  const target = path.join(root, '.planning', 'STATE.md');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(path.join(root, 'other.txt'), 'linked');
  try { fs.linkSync(path.join(root, 'other.txt'), target); } catch (e) {
    if (['EPERM', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV'].includes(e.code)) { fs.writeFileSync(path.join(root, 'LINK-UNSUPPORTED'), e.code); return; }
    throw e;
  }
};`,
      },
      {
        name: 'renameSync of a directory that holds a STATE.md',
        file: 'moved/STATE.md', bytes: 'moved',
        // The fixture STATE.md is laid down by test code (main.cjs), which is never recorded.
        seed: `fs.mkdirSync(path.join(root, 'ws'), { recursive: true }); fs.writeFileSync(path.join(root, 'ws', 'STATE.md'), 'moved');`,
        body: `const fs = require('node:fs'); const path = require('node:path');
module.exports = async (root) => {
  fs.renameSync(path.join(root, 'ws'), path.join(root, 'moved'));
};`,
      },
      {
        name: 'cpSync of a directory that holds a STATE.md onto another directory',
        file: 'copy/STATE.md', bytes: 'copied',
        seed: `fs.mkdirSync(path.join(root, 'ws'), { recursive: true }); fs.writeFileSync(path.join(root, 'ws', 'STATE.md'), 'copied');`,
        body: `const fs = require('node:fs'); const path = require('node:path');
module.exports = async (root) => {
  fs.cpSync(path.join(root, 'ws'), path.join(root, 'copy'), { recursive: true });
};`,
      },
      {
        name: 'a write inside a cpSync filter callback',
        file: '.planning/STATE.md', bytes: 'in a filter',
        body: `const fs = require('node:fs'); const path = require('node:path');
module.exports = async (root) => {
  const target = path.join(root, '.planning', 'STATE.md');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(path.join(root, 'src.txt'), 'x');
  fs.cpSync(path.join(root, 'src.txt'), path.join(root, 'dst.txt'), { filter: () => { fs.writeFileSync(target, 'in a filter'); return true; } });
};`,
      },
      {
        name: 'a FileHandle write through fs.promises.open',
        file: '.planning/STATE.md', bytes: 'by handle',
        body: `const fs = require('node:fs'); const path = require('node:path');
module.exports = async (root) => {
  const target = path.join(root, '.planning', 'STATE.md');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const handle = await fs.promises.open(target, 'w');
  try { await handle.writeFile('by handle'); } finally { await handle.close(); }
};`,
      },
      {
        // Pre-push review R3-m6: the internal copyFile runs after cp's own awaits, when no product
        // frame is on the stack, because nothing awaits the cp call itself.
        name: 'fs.promises.cp onto STATE.md chained with .then, not awaited',
        file: '.planning/STATE.md', bytes: 'by promises.cp',
        body: `const fs = require('node:fs'); const path = require('node:path');
module.exports = (root) => new Promise((resolve, reject) => {
  const target = path.join(root, '.planning', 'STATE.md');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(path.join(root, 'src.md'), 'by promises.cp');
  fs.promises.cp(path.join(root, 'src.md'), target).then(resolve, reject);
});`,
      },
      {
        // Pre-push review R3-n3: node writes through a URL-like object; the guard reads only a URL instance.
        name: 'writeFileSync with a URL-like object that is not a URL instance',
        file: '.planning/STATE.md', bytes: 'by url-like',
        body: `const fs = require('node:fs'); const path = require('node:path'); const { pathToFileURL } = require('node:url');
module.exports = async (root) => {
  const target = path.join(root, '.planning', 'STATE.md');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const url = pathToFileURL(target);
  fs.writeFileSync({ href: url.href, protocol: url.protocol, pathname: url.pathname, hostname: url.hostname, origin: url.origin }, 'by url-like');
};`,
      },
    ];
    for (const shape of shapes) {
      await t.test(shape.name, (st) => {
        const dir = createTempDir('rswg-limit-');
        st.after(() => cleanup(dir));
        const mod = writeModule(dir, 'gsd-core/bin/lib/writer.cjs', `'use strict';\n${shape.body}\n`);
        const main = writeModule(dir, 'tests/main.cjs', `'use strict';
const fs = require('node:fs'); const path = require('node:path');
const root = ${JSON.stringify(dir)};
${shape.seed || ''}
require(${JSON.stringify(mod)})(root).catch((e) => { console.error(e); process.exitCode = 1; });`);
        const entries = runGuarded(dir, main);
        // A link fixture that cannot be built fails the row, as the mkfifo row does (pre-push review R3-n2).
        if (shape.linkSupportMarker && fs.existsSync(path.join(dir, shape.linkSupportMarker))) {
          throw new Error(`the hard-link fixture could not be built: ${fs.readFileSync(path.join(dir, shape.linkSupportMarker), 'utf8')}`);
        }
        assert.deepEqual(entries, [], `${shape.name} is unseen: ${JSON.stringify(entries)}`);
        assert.equal(fs.readFileSync(path.join(dir, shape.file), 'utf8'), shape.bytes, `${shape.name}: the unseen write landed`);
      });
    }
  });
});

describe('nodeOptionsWithRequire in a real child process (real process: node parses NODE_OPTIONS itself)', () => {
  test('a path with spaces and backslashes reaches node intact (Windows paths)', (t) => {
    // Node's NODE_OPTIONS parser treats a backslash inside quotes as an escape,
    // so an unescaped `D:\a\x` would load `D:ax`. A literal backslash is a legal
    // POSIX file-name byte, so this pins the escaping on every platform.
    const dir = createTempDir('rswg-quote-');
    t.after(() => cleanup(dir));
    const odd = path.join(dir, process.platform === 'win32' ? 'a b' : 'a\\b c');
    const preload = writeModule(odd, 'p.cjs', `process.env.RSWG_LOADED = 'yes';`);
    const main = writeModule(dir, 'main.cjs', `process.stdout.write(String(process.env.RSWG_LOADED));`);
    const env = isolatedEnv({ home: dir, override: { NODE_OPTIONS: nodeOptionsWithRequire(undefined, preload) } });
    const r = runNode([main], { env, timeoutMs: PROBE_TIMEOUT_MS });
    assert.equal(r.stdout, 'yes', r.stderr);
  });
});
describe('scripts/run-tests.cjs runs the check (#5120; real processes: the runner is run end to end)', () => {
  function seedRun(dir, testBody) {
    writeModule(dir, 'gsd-core/bin/lib/writer.cjs', `'use strict';
const fs = require('node:fs');
module.exports = (target) => fs.writeFileSync(target, 'raw');
`);
    writeModule(dir, 'a.test.cjs', testBody);
  }
  function runRunner(dir, extra = {}) {
    // isolatedEnv strips NODE_TEST_CONTEXT, every RUN_TESTS_* and every GSD_* variable; the
    // runner's own input directory is opted back in.
    const env = isolatedEnv({ home: dir, override: { GSD_TEST_DIR: dir, ...extra } });
    return runNode([RUNNER], { cwd: path.join(__dirname, '..'), env, timeoutMs: RUN_TESTS_HARNESS_TIMEOUT_MS });
  }

  test('the runner puts its shim ahead of a preload already in NODE_OPTIONS, so the check installs first in every process that received it (#5120 review Nit 1, Nit 2)', (t) => {
    // The stated limits hold only when the shim is the first preload: a preload ordered before it
    // could keep an unwrapped fs.promises. This preload, handed to the runner in NODE_OPTIONS,
    // records whether the check had installed by the time it ran, in each process it ran in.
    const dir = createTempDir('rswg-runner-order-');
    t.after(() => cleanup(dir));
    const record = path.join(dir, 'order.ndjson');
    const early = writeModule(dir, 'ev/early-preload.cjs', `require('node:fs').appendFileSync(${JSON.stringify(record)}, JSON.stringify({
  installed: globalThis[Symbol.for('gsd.rawStateWriteGuard.installed')] === true,
  nodeOptions: process.env.NODE_OPTIONS || '',
}) + '\\n');`);
    seedRun(dir, `'use strict';
const { test } = require('node:test');
test('passes', () => {});
`);
    const r = runRunner(dir, { NODE_OPTIONS: nodeOptionsWithRequire(undefined, early) });
    assert.equal(r.exitCode, 0, r.stderr);
    // The runner process itself received only this preload; every process the runner gave its
    // shim to must have run the shim first.
    const shimmed = splitLines(fs.readFileSync(record, 'utf8')).filter(Boolean).map((l) => JSON.parse(l))
      .filter((rec) => rec.nodeOptions.includes('raw-state-write-preload.cjs'));
    assert.ok(shimmed.length >= 1, `a process that received the shim ran the early preload: ${fs.readFileSync(record, 'utf8')}`);
    assert.ok(shimmed.every((rec) => rec.installed), JSON.stringify(shimmed));
    assert.ok(shimmed.every((rec) => rec.nodeOptions.startsWith('--require "') && rec.nodeOptions.indexOf('raw-state-write-preload.cjs') < rec.nodeOptions.indexOf('early-preload.cjs')), JSON.stringify(shimmed));
  });

  test('a product write inside a child built with isolatedEnv is still recorded: the ledger path rides in the preload shim (#5120 review)', (t) => {
    const dir = createTempDir('rswg-runner-isolated-');
    t.after(() => cleanup(dir));
    const home = createTempDir('rswg-runner-isolated-home-');
    t.after(() => cleanup(home));
    seedRun(dir, `'use strict';
const { test } = require('node:test');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { isolatedEnv } = require(${JSON.stringify(ISOLATED_ENV_HELPER)});
test('passes', () => {
  const writer = ${JSON.stringify(path.join(dir, 'gsd-core/bin/lib/writer.cjs'))};
  const target = path.join(${JSON.stringify(dir)}, 'STATE.md');
  const r = spawnSync(process.execPath, ['-e', 'require(process.argv[1])(process.argv[2])', writer, target], { env: isolatedEnv({ home: ${JSON.stringify(home)} }), encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
});
`);
    const r = runRunner(dir);
    assert.equal(typeof r.exitCode, 'number', 'the runner exited on its own');
    assert.notEqual(r.exitCode, 0, 'the run fails although its only test passed');
    assert.match(r.stderr, /run-tests: raw STATE\.md writes in product code: 1; seam writes and relocations onto STATE\.md: 0 \(0 relocations\), of which without the STATE\.md lock: 0; unreadable ledger lines: 0;/);
    // The attribution variable is stripped by isolatedEnv, so the test file reads unknown.
    assert.match(r.stderr, / {2}raw write: writeFileSync \S+STATE\.md from \S+writer\.cjs:3 \(test: unknown\)/);
  });

  test('a product module raw-writing STATE.md under a passing test fails the run and is named', (t) => {
    const dir = createTempDir('rswg-runner-red-');
    t.after(() => cleanup(dir));
    seedRun(dir, `'use strict';
const { test } = require('node:test');
const path = require('node:path');
test('passes', () => { require(${JSON.stringify(path.join(dir, 'gsd-core/bin/lib/writer.cjs'))})(path.join(${JSON.stringify(dir)}, 'STATE.md')); });
`);
    const r = runRunner(dir);
    assert.equal(typeof r.exitCode, 'number', 'the runner exited on its own');
    assert.notEqual(r.exitCode, 0, 'the run fails although its only test passed');
    assert.match(r.stderr, /run-tests: raw STATE\.md writes in product code: 1; seam writes and relocations onto STATE\.md: 0 \(0 relocations\), of which without the STATE\.md lock: 0; unreadable ledger lines: 0;/);
    assert.match(r.stderr, / {2}raw write: writeFileSync \S+STATE\.md from \S+writer\.cjs:3 \(test: \S+a\.test\.cjs\)/);
  });

  test('a test writing a STATE.md fixture itself passes the run and still reports the zero', (t) => {
    const dir = createTempDir('rswg-runner-green-');
    t.after(() => cleanup(dir));
    seedRun(dir, `'use strict';
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
test('passes', () => { fs.writeFileSync(path.join(${JSON.stringify(dir)}, 'STATE.md'), 'fixture'); });
`);
    const r = runRunner(dir);
    assert.equal(r.exitCode, 0, r.stderr);
    assert.match(r.stderr, /run-tests: raw STATE\.md writes in product code: 0; /);
    // The install sentinels survived the runner end to end: the preload loaded in the chunk
    // process and in the test file's child, whose sentinel names a.test.cjs, so no "left no
    // preload sentinel" line is printed (#5120 audit, review Minor 6).
    assert.match(r.stderr, /unreadable ledger lines: 0; the check loaded in [2-9]\d* processes\b/);
    assert.doesNotMatch(r.stderr, /left no preload sentinel/);
  });

  test('a chunk killed on its timeout leaves a test file that never started, and the runner prints it as having no preload sentinel (#5120 pre-push review Mi5)', (t) => {
    // The wiring under test is the runner passing the test files it spawned to formatStateWriteReport
    // (testFilesRun). Two fixture files both park a promise for HANG_PARK_MS, far past the 2000 ms
    // chunk bound (the pattern of tests/run-tests-harness.test.cjs: parked, not a busy loop, and
    // self-terminating if a kill orphans it). With TEST_CONCURRENCY 1 the first file hangs until the
    // chunk is killed and the second never starts, so exactly one of the two leaves no preload
    // sentinel. RUN_TESTS_NO_FORCE_EXIT keeps the kill on the timeout path.
    const HANG_PARK_MS = 10_000;
    const HANGS_BODY = `'use strict';
const { test } = require('node:test');
test('hangs', () => new Promise((resolve) => { setTimeout(resolve, ${HANG_PARK_MS}); }));
`;
    const dir = createTempDir('rswg-runner-hang-');
    t.after(() => cleanup(dir));
    const fixtures = ['hang-a.test.cjs', 'hang-b.test.cjs'].map((name) => writeModule(dir, name, HANGS_BODY));
    const r = runRunner(dir, {
      RUN_TESTS_CHUNK_TIMEOUT_MS: '2000',
      RUN_TESTS_NO_FORCE_EXIT: '1',
      TEST_CONCURRENCY: '1',
    });
    assert.equal(typeof r.exitCode, 'number', 'the runner exited on its own');
    assert.notEqual(r.exitCode, 0, `the run fails: ${r.stderr}`);
    // Whether the second file starts before the 2000 ms chunk bound can vary on a slow machine, so one
    // or two files may be printed; either way the line must be there and name only these fixtures.
    const line = splitLines(r.stderr).find((l) => /^run-tests: raw STATE\.md write check: [12] test files? left no preload sentinel/.test(l));
    assert.ok(line, `the runner printed the unguarded-file line: ${r.stderr}`);
    const count = Number(/check: (\d) test file/.exec(line)[1]);
    const listed = line.slice(line.indexOf('cover ')).split(';')[0].replace(/^cover (?:it|them): /, '').split(', ');
    assert.equal(listed.length, count, `the line names as many files as it counts: ${line}`);
    for (const f of listed) {
      assert.ok(fixtures.some((fx) => path.resolve(fx) === path.resolve(f)), `${f} is one of the two fixtures: ${line}`);
    }
  });
});
