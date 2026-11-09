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
const { spawnSync } = require('node:child_process');
const { createTempDir, cleanup } = require('./helpers.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { runNode } = require('./helpers/process-seam.cjs');

const RUNNER = path.join(__dirname, '..', 'scripts', 'run-tests.cjs');
// The runner enforces its own per-chunk timeout; this outer bound sits above it
// plus node --test start-up, as tests/run-tests-harness.test.cjs does.
const RUNNER_TIMEOUT_MS = 120000;

const GUARD_PATH = path.join(__dirname, '..', 'scripts', 'raw-state-write-guard.cjs');
const {
  classifyStateWrite,
  nodeOptionsWithRequire,
  readStateWriteLedger,
  formatStateWriteReport,
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

/** Run `script` in a child that loads the guard the way the runner does. */
function runGuarded(dir, script, extraEnv = {}) {
  const ledger = path.join(dir, 'ledger.ndjson');
  const env = { ...process.env, ...extraEnv, GSD_STATE_WRITE_LEDGER: ledger };
  env.NODE_OPTIONS = nodeOptionsWithRequire(undefined, GUARD_PATH);
  delete env.GSD_STATE_WRITE_TEST_FILE;
  const r = spawnSync(process.execPath, [script], { cwd: dir, env, encoding: 'utf8', timeout: PROBE_TIMEOUT_MS });
  assert.equal(r.status, 0, `child failed: ${r.stderr}`);
  return readStateWriteLedger(ledger);
}

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
  await new Promise((res, rej) => fs.writeFile(target, 'g', (e) => (e ? rej(e) : res())));
  fs.writeFileSync(new URL('file://' + target.replace(/\\\\/g, '/').replace(/^([A-Za-z]):/, '/$1:')), 'h');
};
`);
    const main = writeModule(dir, 'tests/main.cjs', `require(${JSON.stringify(path.join(dir, 'gsd-core/bin/lib/writer.cjs'))})(${JSON.stringify(target)});`);
    const entries = runGuarded(dir, main);
    assert.deepEqual(
      entries.map((e) => e.fn),
      ['writeFileSync', 'writeFileSync', 'appendFileSync', 'renameSync', 'copyFileSync', 'cpSync', 'promises.writeFile', 'writeFile', 'writeFileSync'],
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
    const entries = runGuarded(dir, main, { NODE_TEST_CONTEXT: 'child-v8' });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].violation, true);
    assert.equal(entries[0].testFile, main, 'the violation names the test file whose subprocess wrote');
  });

  test('without a ledger the preload is inert: no wrapper is installed', (t) => {
    const dir = createTempDir('rswg-inert-');
    t.after(() => cleanup(dir));
    const main = writeModule(dir, 'tests/main.cjs', `const fs = require('node:fs'); const before = fs.writeFileSync;
require(${JSON.stringify(GUARD_PATH)});
process.stdout.write(String(fs.writeFileSync === before && !fs.writeFileSync.name.includes('guard')));`);
    const env = { ...process.env };
    delete env.GSD_STATE_WRITE_LEDGER;
    delete env.NODE_OPTIONS;
    const r = spawnSync(process.execPath, [main], { cwd: dir, env, encoding: 'utf8', timeout: PROBE_TIMEOUT_MS });
    assert.equal(r.stdout, 'true');
  });
});

describe('nodeOptionsWithRequire', () => {
  test('appends a quoted --require and keeps existing options', () => {
    assert.equal(nodeOptionsWithRequire('--max-old-space-size=4096', '/a/b.cjs'), '--max-old-space-size=4096 --require "/a/b.cjs"');
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
    const env = { ...process.env, NODE_OPTIONS: nodeOptionsWithRequire(undefined, preload) };
    const r = spawnSync(process.execPath, [main], { env, encoding: 'utf8', timeout: PROBE_TIMEOUT_MS });
    assert.equal(r.stdout, 'yes', r.stderr);
  });
});

describe('formatStateWriteReport (ADR-3408 Decision 5: the zero is never reported alone)', () => {
  test('a clean run reports the zero beside the seam-write count and the unlocked seam-write count', () => {
    const entries = [
      { violation: false, seam: true, lockHeld: true },
      { violation: false, seam: true, lockHeld: false },
    ];
    const r = formatStateWriteReport(entries);
    assert.equal(r.failed, false);
    assert.equal(r.lines[0], 'run-tests: raw STATE.md writes in product code: 0 (seam writes onto STATE.md: 2, of which without the STATE.md lock: 1)');
  });

  test('a violation fails the run and names the caller, destination and test file', () => {
    const entries = [{ violation: true, seam: false, lockHeld: false, fn: 'writeFileSync', destination: '/p/STATE.md', callerFile: '/r/gsd-core/bin/lib/x.cjs', callerLine: 7, testFile: '/r/tests/y.test.cjs' }];
    const r = formatStateWriteReport(entries);
    assert.equal(r.failed, true);
    assert.equal(r.lines[0], 'run-tests: raw STATE.md writes in product code: 1 (seam writes onto STATE.md: 0, of which without the STATE.md lock: 0)');
    assert.equal(r.lines[1], '  writeFileSync /p/STATE.md from /r/gsd-core/bin/lib/x.cjs:7 (test: /r/tests/y.test.cjs)');
  });

  test('an unreadable ledger is unreadable evidence: it fails the run, never reads as zero (#5170)', () => {
    assert.equal(readStateWriteLedger(path.join(__dirname, 'no-such-ledger.ndjson')), null);
    const r = formatStateWriteReport(null);
    assert.equal(r.failed, true);
    assert.equal(r.lines[0], 'run-tests: raw STATE.md write check: ledger unreadable, so the check did not run');
  });

  test('a torn last ledger line is skipped', (t) => {
    const dir = createTempDir('rswg-ledger-');
    t.after(() => cleanup(dir));
    const file = path.join(dir, 'l.ndjson');
    fs.writeFileSync(file, '{"violation":true}\n{"violati');
    assert.deepEqual(readStateWriteLedger(file), [{ violation: true }]);
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
    const env = { ...process.env, GSD_TEST_DIR: dir };
    delete env.NODE_TEST_CONTEXT;
    delete env.RUN_TESTS_SHARD_RESERVE;
    return runNode([RUNNER], { cwd: path.join(__dirname, '..'), env, timeoutMs: RUNNER_TIMEOUT_MS });
  }

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
  });
});
