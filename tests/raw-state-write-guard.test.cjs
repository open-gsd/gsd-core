'use strict';

/**
 * #5120 (epic #4629, ADR-4629 guard roster "No raw STATE.md write outside the
 * seam"): the test-time value check that scripts/run-tests.cjs installs for the
 * whole suite. These tests drive the real preload in real child processes, the
 * way the runner installs it (NODE_OPTIONS --require), and read its ledger.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTempDir, cleanup } = require('./helpers.cjs');
const { PROBE_TIMEOUT_MS, RUN_TESTS_HARNESS_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { runNode } = require('./helpers/process-seam.cjs');
const { isolatedEnv } = require('./helpers/isolated-env.cjs');

const RUNNER = path.join(__dirname, '..', 'scripts', 'run-tests.cjs');
const ISOLATED_ENV_HELPER = path.join(__dirname, 'helpers', 'isolated-env.cjs');
const BUILT_LIB = path.join(__dirname, '..', 'gsd-core', 'bin', 'lib');

const GUARD_PATH = path.join(__dirname, '..', 'scripts', 'raw-state-write-guard.cjs');
const {
  classifyStateWrite,
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

describe('classifyStateWrite: the approved rule (#5120)', () => {
  const lib = (name) => path.join('/x', 'gsd-core', 'bin', 'lib', name);

  test('a product write onto STATE.md that platformWriteSync did not make is a violation', () => {
    const c = classifyStateWrite({ destination: '/p/.planning/STATE.md', callerFile: lib('roadmap-upgrade.cjs'), viaSeam: false });
    assert.deepEqual(c, { recorded: true, violation: true, seam: false });
    // The seam module's other exports (retryRenameSync) are not the seam.
    const r = classifyStateWrite({ destination: '/p/.planning/STATE.md', callerFile: lib('shell-command-projection.cjs'), viaSeam: false });
    assert.deepEqual(r, { recorded: true, violation: true, seam: false });
  });

  test('moving or copying an existing STATE.md is not a write of one (workstream migrate / archive)', () => {
    const notRecorded = { recorded: false, violation: false, seam: false };
    const c = classifyStateWrite({ destination: '/p/.planning/workstreams/w/STATE.md', source: '/p/.planning/STATE.md', callerFile: lib('workstream.cjs'), viaSeam: false });
    assert.deepEqual(c, notRecorded);
    // A rename from any other file onto STATE.md authors its bytes: still a violation.
    const t = classifyStateWrite({ destination: '/p/STATE.md', source: '/p/STATE.md.tmp', callerFile: lib('workstream.cjs'), viaSeam: false });
    assert.deepEqual(t, { recorded: true, violation: true, seam: false });
  });

  test('a write platformWriteSync makes is recorded, never a violation', () => {
    const c = classifyStateWrite({ destination: '/p/.planning/STATE.md', callerFile: lib('shell-command-projection.cjs'), viaSeam: true });
    assert.deepEqual(c, { recorded: true, violation: false, seam: true });
  });

  test('test code, scripts and non-STATE.md basenames are not recorded', () => {
    const notRecorded = { recorded: false, violation: false, seam: false };
    assert.deepEqual(classifyStateWrite({ destination: '/p/STATE.md', callerFile: '/repo/tests/x.test.cjs', viaSeam: false }), notRecorded);
    assert.deepEqual(classifyStateWrite({ destination: '/p/STATE.md', callerFile: '/repo/scripts/run-tests.cjs', viaSeam: false }), notRecorded);
    assert.deepEqual(classifyStateWrite({ destination: '/p/STATE.md', callerFile: null, viaSeam: false }), notRecorded);
    // The repo-root launchers (bin/install.js) are not payload, even in a checkout named gsd-core.
    assert.deepEqual(classifyStateWrite({ destination: '/p/STATE.md', callerFile: '/home/u/gsd-core/bin/install.js', viaSeam: false }), notRecorded);
    for (const name of ['STATE.md.bak', 'STATE.md.lock', 'STATE.md.tmp.123', 'PROJECT.md', 'state.md', 'XSTATE.md']) {
      assert.deepEqual(classifyStateWrite({ destination: `/p/${name}`, callerFile: lib('a.cjs'), viaSeam: false }), notRecorded, name);
    }
  });

  test('Windows separators classify the same as POSIX ones', () => {
    const c = classifyStateWrite({ destination: 'C:\\p\\.planning\\STATE.md', callerFile: 'C:\\repo\\gsd-core\\bin\\lib\\phase.cjs', viaSeam: false });
    assert.deepEqual(c, { recorded: true, violation: true, seam: false });
    const s = classifyStateWrite({ destination: 'C:\\p\\STATE.md', callerFile: 'C:\\repo\\gsd-core\\bin\\lib\\shell-command-projection.cjs', viaSeam: true });
    assert.deepEqual(s, { recorded: true, violation: false, seam: true });
  });
});

describe('the preload in a real child process (#5120)', () => {
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
      // fs.promises.cp is recorded once, as the fs.promises.copyFile it calls.
      ['writeFileSync', 'writeFileSync', 'appendFileSync', 'renameSync', 'copyFileSync', 'cpSync', 'promises.writeFile', 'promises.copyFile', 'writeFile', 'writeFileSync'],
    );
    assert.ok(entries.every((e) => e.violation === true && e.lockHeld === false), JSON.stringify(entries));
    assert.ok(entries.every((e) => path.basename(e.callerFile) === 'writer.cjs'), 'attributed to the product frame, not the preload or node:fs');
  });

  test('the seam module, test code and other basenames produce no violation', (t) => {
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
module.exports = (target) => platformWriteSync(target);
`);
    writeModule(dir, 'gsd-core/bin/lib/other.cjs', `'use strict';
const fs = require('node:fs');
module.exports = (dir) => { fs.writeFileSync(dir + '/STATE.md.bak', 'x'); fs.writeFileSync(dir + '/PROJECT.md', 'x'); };
`);
    const main = writeModule(dir, 'tests/main.cjs', `'use strict';
const fs = require('node:fs');
require(${JSON.stringify(path.join(dir, 'gsd-core/bin/lib/shell-command-projection.cjs'))})(${JSON.stringify(target)});
require(${JSON.stringify(path.join(dir, 'gsd-core/bin/lib/other.cjs'))})(${JSON.stringify(path.dirname(target))});
fs.writeFileSync(${JSON.stringify(target)}, 'fixture written by a test');
`);
    const entries = runGuarded(dir, main);
    assert.equal(entries.filter((e) => e.violation).length, 0, JSON.stringify(entries));
    assert.deepEqual(entries.map((e) => [e.fn, e.seam]), [['renameSync', true], ['writeFileSync', true]], 'seam writes are recorded for the paired report');
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

  test('the seam module\'s byte-exact restore (platformRestoreFileSync, #5831) onto STATE.md is a seam write, never a violation', (t) => {
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
module.exports = (target) => platformRestoreFileSync(target, Buffer.from('restored\\n'));
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

  test('a write under the STATE.md lock this process holds is recorded as locked', (t) => {
    const dir = createTempDir('rswg-lock-');
    t.after(() => cleanup(dir));
    const target = path.join(dir, 'STATE.md');
    writeModule(dir, 'gsd-core/bin/lib/shell-command-projection.cjs', `'use strict';
const fs = require('node:fs');
module.exports = (target, pid) => { fs.writeFileSync(target + '.lock', String(pid)); fs.writeFileSync(target, 'x'); fs.unlinkSync(target + '.lock'); };
`);
    const main = writeModule(dir, 'tests/main.cjs', `const w = require(${JSON.stringify(path.join(dir, 'gsd-core/bin/lib/shell-command-projection.cjs'))});
w(${JSON.stringify(target)}, process.pid); w(${JSON.stringify(target)}, process.pid + 1);`);
    const entries = runGuarded(dir, main);
    assert.deepEqual(entries.map((e) => e.lockHeld), [true, false], 'a lock body naming another pid is not held by this process');
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

describe('formatStateWriteReport (ADR-3408 Decision 5: the zero is never reported alone)', () => {
  test('a clean run reports the zero beside the seam-write count and the unlocked seam-write count', () => {
    const entries = [
      { violation: false, seam: true, lockHeld: true },
      { violation: false, seam: true, lockHeld: false },
    ];
    const r = formatStateWriteReport({ entries, tornLines: 0 });
    assert.equal(r.failed, false);
    assert.equal(r.lines[0], 'run-tests: raw STATE.md writes in product code: 0 (seam writes onto STATE.md: 2, of which without the STATE.md lock: 1); the check loaded in 0 processes');
  });

  test('a violation fails the run and names the caller, destination and test file', () => {
    const entries = [{ violation: true, seam: false, lockHeld: false, fn: 'writeFileSync', destination: '/p/STATE.md', callerFile: '/r/gsd-core/bin/lib/x.cjs', callerLine: 7, testFile: '/r/tests/y.test.cjs' }];
    const r = formatStateWriteReport({ entries, tornLines: 0 });
    assert.equal(r.failed, true);
    assert.equal(r.lines[0], 'run-tests: raw STATE.md writes in product code: 1 (seam writes onto STATE.md: 0, of which without the STATE.md lock: 0); the check loaded in 0 processes');
    assert.equal(r.lines[1], '  writeFileSync /p/STATE.md from /r/gsd-core/bin/lib/x.cjs:7 (test: /r/tests/y.test.cjs)');
  });

  test('an unreadable ledger is unreadable evidence: it fails the run, never reads as zero (#5170)', () => {
    const read = readStateWriteLedger(path.join(__dirname, 'no-such-ledger.ndjson'));
    assert.deepEqual(read, { entries: null, installs: 0, preloadInstalls: 0, tornLines: 0 });
    const r = formatStateWriteReport(read);
    assert.equal(r.failed, true);
    assert.equal(r.lines[0], 'run-tests: raw STATE.md write check: ledger unreadable, so the check did not run');
  });

  test('a torn ledger line is counted and printed beside the zero, never dropped silently (#5120 review)', (t) => {
    const dir = createTempDir('rswg-ledger-');
    t.after(() => cleanup(dir));
    const file = path.join(dir, 'l.ndjson');
    fs.writeFileSync(file, '{"seam":true,"lockHeld":true}\n{"violati');
    const read = readStateWriteLedger(file);
    assert.deepEqual(read, { entries: [{ seam: true, lockHeld: true }], installs: 0, preloadInstalls: 0, tornLines: 1 });
    const r = formatStateWriteReport(read);
    assert.equal(r.failed, false, 'a torn line is not a violation');
    assert.equal(r.lines[0], 'run-tests: raw STATE.md writes in product code: 0 (seam writes onto STATE.md: 1, of which without the STATE.md lock: 0, unreadable ledger lines: 1); the check loaded in 0 processes');
  });

  test('an install sentinel is counted beside the writes, never as one of them (#5120 audit)', (t) => {
    const dir = createTempDir('rswg-sentinel-');
    t.after(() => cleanup(dir));
    const file = path.join(dir, 'l.ndjson');
    fs.writeFileSync(file, '{"installed":true,"preload":true,"pid":1}\n{"seam":true,"lockHeld":true}\n{"installed":true,"preload":false,"pid":2}\n');
    assert.deepEqual(readStateWriteLedger(file), { entries: [{ seam: true, lockHeld: true }], installs: 2, preloadInstalls: 1, tornLines: 0 });
  });

  test('a run with fewer install sentinels than spawned chunks fails and names the shim and NODE_OPTIONS: a chunk whose preload never loaded cannot read as zero violations (#5120 audit, review)', () => {
    const where = { chunksRun: 2, shimPath: '/tmp/ev/raw-state-write-preload.cjs', nodeOptions: '--require "/tmp/ev/raw-state-write-preload.cjs" --max-old-space-size=4096' };
    const never = formatStateWriteReport({ entries: [], installs: 0, preloadInstalls: 0, tornLines: 0 }, where);
    assert.equal(never.failed, true);
    assert.equal(never.lines[0], 'run-tests: raw STATE.md writes in product code: 0 (seam writes onto STATE.md: 0, of which without the STATE.md lock: 0); the check loaded in 0 processes');
    assert.equal(never.lines[1], 'run-tests: raw STATE.md write check: 2 chunks were spawned but only 0 processes recorded the preload, so the zero above is not evidence; the shim was /tmp/ev/raw-state-write-preload.cjs and each chunk received NODE_OPTIONS --require "/tmp/ev/raw-state-write-preload.cjs" --max-old-space-size=4096');
    // Every spawned chunk is itself a node process that loads the shim, so one chunk's
    // sentinel cannot vouch for another: 1 of 2 fails too.
    const one = formatStateWriteReport({ entries: [], installs: 1, preloadInstalls: 1, tornLines: 0 }, where);
    assert.equal(one.failed, true);
    assert.match(one.lines[1], /^run-tests: raw STATE\.md write check: 2 chunks were spawned but only 1 process recorded the preload/);
    // The NODE_OPTIONS evidence is bounded so a long value cannot flood the line.
    const long = formatStateWriteReport({ entries: [], installs: 0, preloadInstalls: 0, tornLines: 0 }, { ...where, nodeOptions: 'x'.repeat(500) });
    assert.match(long.lines[1], /NODE_OPTIONS x{120}\.\.\. \(500 chars\)$/);
    // Sentinels at or above the chunk count (test-file children add theirs) pass.
    const loaded = formatStateWriteReport({ entries: [], installs: 2, preloadInstalls: 2, tornLines: 0 }, where);
    assert.equal(loaded.failed, false);
    assert.equal(loaded.lines.length, 1);
    assert.equal(formatStateWriteReport({ entries: [], installs: 5, preloadInstalls: 5, tornLines: 0 }, where).failed, false);
    // No chunk ran (nothing to load into): no sentinel is owed.
    assert.equal(formatStateWriteReport({ entries: [], installs: 0, preloadInstalls: 0, tornLines: 0 }, { chunksRun: 0 }).failed, false);
    // A sentinel from a direct require of the guard (NEW-1) is counted and shown, never compared.
    const direct = formatStateWriteReport({ entries: [], installs: 2, preloadInstalls: 1, tornLines: 0 }, where);
    assert.equal(direct.failed, true);
    assert.equal(direct.lines[0], 'run-tests: raw STATE.md writes in product code: 0 (seam writes onto STATE.md: 0, of which without the STATE.md lock: 0); the check loaded in 1 processes (and in 1 more by a direct require)');
    assert.match(direct.lines[1], /only 1 process recorded the preload \(1 more installed it by a direct require, which does not vouch for a chunk\)/);
  });

  test('a ledger line that parses to null is an unreadable line, not an entry (#5120 review)', (t) => {
    const dir = createTempDir('rswg-null-');
    t.after(() => cleanup(dir));
    const file = path.join(dir, 'l.ndjson');
    fs.writeFileSync(file, 'null\n{"seam":true,"lockHeld":true}\n"x"\n');
    const read = readStateWriteLedger(file);
    assert.deepEqual(read, { entries: [{ seam: true, lockHeld: true }], installs: 0, preloadInstalls: 0, tornLines: 2 });
    assert.equal(formatStateWriteReport(read, { chunksRun: 0 }).failed, false);
  });
});

describe('scripts/run-tests.cjs runs the check (#5120)', () => {
  function seedRun(dir, testBody) {
    writeModule(dir, 'gsd-core/bin/lib/writer.cjs', `'use strict';
const fs = require('node:fs');
module.exports = (target) => fs.writeFileSync(target, 'raw');
`);
    writeModule(dir, 'a.test.cjs', testBody);
  }
  function runRunner(dir) {
    // isolatedEnv strips NODE_TEST_CONTEXT, every RUN_TESTS_* and every GSD_* variable; the
    // runner's own input directory is opted back in.
    const env = isolatedEnv({ home: dir, override: { GSD_TEST_DIR: dir } });
    return runNode([RUNNER], { cwd: path.join(__dirname, '..'), env, timeoutMs: RUN_TESTS_HARNESS_TIMEOUT_MS });
  }

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
    assert.match(r.stderr, /run-tests: raw STATE\.md writes in product code: 1 \(seam writes onto STATE\.md: 0, of which without the STATE\.md lock: 0\)/);
    // The attribution variable is stripped by isolatedEnv, so the test file reads unknown.
    assert.match(r.stderr, /writeFileSync \S+STATE\.md from \S+writer\.cjs:3 \(test: unknown\)/);
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
    assert.match(r.stderr, /run-tests: raw STATE\.md writes in product code: 1 \(seam writes onto STATE\.md: 0, of which without the STATE\.md lock: 0\)/);
    assert.match(r.stderr, /writeFileSync \S+STATE\.md from \S+writer\.cjs:3 \(test: \S+a\.test\.cjs\)/);
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
    assert.match(r.stderr, /run-tests: raw STATE\.md writes in product code: 0 \(/);
    // The install sentinel survived the runner end to end: the preload loaded in the chunk
    // process at least (#5120 audit: an empty ledger alone is not evidence the check ran).
    assert.match(r.stderr, /lock: 0\); the check loaded in [1-9]\d* processes/);
  });
});
