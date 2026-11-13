'use strict';

/**
 * Platform-sensitive tests split out of tests/config-loader-bounded-read.test.cjs (#5074, #5759).
 *
 * scripts/gen-platform-conformance-tier.cjs selects whole files for the real-OS
 * (Windows/macOS) conformance tier. The rows below carry the platform signal, so they live
 * here; tests/config-loader-bounded-read.test.cjs stays signal-free and runs on Linux only.
 * Add a new platform-sensitive row HERE, not in the base file.
 *
 * Rows and why each lives here:
 * - every "FIFO" row — creates a real named pipe with `mkfifo`; there is no FIFO on
 *   Windows (process-platform, raw-child-process). These rows sit in describes skipped on win32.
 * - the exclusive-create and planted-symlink rows — `fs.symlinkSync` needs privileges on
 *   Windows and the temp-file hardening they pin is POSIX link semantics (process-platform).
 * - the control-character path row — a directory name containing ESC is a legal POSIX name
 *   and an illegal Windows one (process-platform).
 * - "config.json is a directory" — runs on every OS. It lives outside the win32-skipped
 *   describes: the loader reports the file unusable on Windows as well, with whatever errno
 *   that OS gives, and POSIX additionally pins EISDIR (process-platform).
 *
 * A config FIFO with no writer blocks open(2) forever, so each hang row spawns the
 * command under a kill timer and asserts that the child EXITED ON ITS OWN. There is no
 * elapsed-time assertion: a hang surfaces as outcome `timed_out`, not as a slow pass.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cleanup, TOOLS_PATH, installSpawnEnv } = require('./helpers.cjs');
const { runNode, runHook, OUTCOME, assertSeamExit } = require('./helpers/process-seam.cjs');
const { gitOrThrow } = require('./helpers/git-fixture.cjs');
const { PROBE_TIMEOUT_MS, INSTALL_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

const LIB_DIR = path.join(__dirname, '..', 'gsd-core', 'bin', 'lib');
const CONFIG_LOADER_PATH = path.join(LIB_DIR, 'config-loader.cjs');
const PLANNING_WORKSPACE_PATH = path.join(LIB_DIR, 'planning-workspace.cjs');
const RUNTIME_SLASH_PATH = path.join(LIB_DIR, 'runtime-slash.cjs');
const SHELL_PROJECTION_PATH = path.join(LIB_DIR, 'shell-command-projection.cjs');
const LOAD_RESOLVED_SCRIPT =
  'process.stdout.write(JSON.stringify(require(process.argv[1]).loadConfigResolved(process.argv[2])))';
const SKIP_WIN32 = process.platform === 'win32' ? 'no FIFOs or control-character names on Windows' : false;

function makeFifo(fifoPath) {
  // Throws when mkfifo fails, so on POSIX a row never passes without a real FIFO.
  assertSeamExit(assert, runHook(fifoPath, [], { interpreter: 'mkfifo', timeoutMs: PROBE_TIMEOUT_MS }), 0, 'mkfifo');
}

/**
 * Start a FIFO reader child, wait until it has opened the pipe ("ready" on its stderr), then run
 * a platformWriteSync writer of `total` bytes against it. Resolves with the writer's stdout (its
 * "done" or the error code it caught) and the reader's stdout. Both children are bounded by a
 * kill timer; nothing asserts on elapsed time.
 */
function withFifoReader(fifo, readerScript, extraOpts, total, cwd, killReader = false) {
  const { spawn } = require('node:child_process');
  return new Promise((resolve, reject) => {
    const reader = spawn(process.execPath, ['-e', readerScript, fifo], { stdio: ['ignore', 'pipe', 'pipe'] });
    let readerOut = '';
    let started = false;
    // Registered at spawn: a reader that exits first (EPIPE case) must not be missed.
    const readerClosed = new Promise((done) => { reader.on('close', done); });
    let writerChild = null;
    const kill = setTimeout(() => {
      reader.kill('SIGKILL');
      if (writerChild) {
        writerChild.once('close', () => reject(new Error('FIFO writer did not finish')));
        writerChild.kill('SIGKILL');
      } else {
        reject(new Error('FIFO reader never became ready'));
      }
    }, PROBE_TIMEOUT_MS * 3);
    reader.stdout.on('data', (d) => { readerOut += d; });
    reader.stderr.on('data', () => {
      if (started) return;
      started = true;
      const writerScript = [
        'try {',
        '  require(process.argv[1]).platformWriteSync(process.argv[2], "x".repeat(' + total + '),',
        '    { allowSpecialTarget: true, verbatim: true' + extraOpts + ' });',
        '  process.stdout.write("done");',
        '} catch (e) { process.stdout.write(e.code || String(e)); }',
      ].join('\n');
      const w = spawn(process.execPath, ['-e', writerScript, SHELL_PROJECTION_PATH, fifo], {
        cwd, env: installSpawnEnv({}), stdio: ['ignore', 'pipe', 'ignore'],
      });
      writerChild = w;
      let writer = '';
      w.stdout.on('data', (d) => { writer += d; });
      w.on('close', () => {
        // A reader that exits on EOF is awaited so its byte count arrives; a stalled one is killed.
        if (killReader) reader.kill('SIGKILL');
        readerClosed.then(() => { clearTimeout(kill); resolve({ writer, readerOut }); });
      });
    });
  });
}

function loadResolvedInChild(cwd) {
  return runNode(['-e', LOAD_RESOLVED_SCRIPT, CONFIG_LOADER_PATH, cwd], {
    cwd,
    env: installSpawnEnv({ GSD_WORKSTREAM: '' }),
    timeoutMs: PROBE_TIMEOUT_MS,
  });
}

function assertExited(r) {
  assert.strictEqual(r.outcome, OUTCOME.EXITED, `child must exit on its own, not be killed: ${r.summary}`);
}

function assertExitedByItself(r) {
  assertExited(r);
  assert.strictEqual(r.exitCode, 0, r.summary);
}

describe('#5759 a FIFO or directory config.json must not hang configuration loading', {
  skip: SKIP_WIN32,
}, () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-5759-fifo-'));
    fs.mkdirSync(path.join(tmpDir, '.planning', 'workstreams', 'ws1'), { recursive: true });
  });
  afterEach(() => { cleanup(tmpDir); });

  const rootConfig = () => path.join(tmpDir, '.planning', 'config.json');
  const wsConfig = () => path.join(tmpDir, '.planning', 'workstreams', 'ws1', 'config.json');

  /** Spawn resolve-model under a kill timer; the caller asserts the child exited by itself. */
  function resolveModel(argv, envOverrides = {}) {
    return runNode([TOOLS_PATH, 'resolve-model', 'gsd-executor', ...argv], {
      cwd: tmpDir,
      env: installSpawnEnv({ GSD_RUNTIME: 'claude', GSD_WORKSTREAM: '', ...envOverrides }),
      timeoutMs: PROBE_TIMEOUT_MS,
    });
  }

  test('workstream config.json is a FIFO: resolve-model --ws exits 0 and reports the file unusable', () => {
    makeFifo(wsConfig());

    const r = resolveModel(['--ws', 'ws1']);

    assertExitedByItself(r);
    assert.ok('model' in JSON.parse(r.stdout), 'a model result is printed');
    assert.ok(r.stderr.includes(wsConfig()) && r.stderr.includes('ENXIO'), 'the unusable FIFO is reported with its errno');
  });

  test('workstream config.json is a FIFO: GSD_WORKSTREAM selects it and resolve-model still exits 0', () => {
    makeFifo(wsConfig());

    const r = resolveModel([], { GSD_WORKSTREAM: 'ws1' });

    assertExitedByItself(r);
    assert.ok('model' in JSON.parse(r.stdout), 'a model result is printed');
    assert.ok(r.stderr.includes(wsConfig()) && r.stderr.includes('ENXIO'), 'the unusable FIFO is reported with its errno');
  });

  test('root .planning/config.json is a FIFO: resolve-model exits 0 with defaults', () => {
    makeFifo(rootConfig());

    const r = resolveModel([]);

    assertExitedByItself(r);
    assert.ok('model' in JSON.parse(r.stdout), 'a model result is printed');
    assert.ok(r.stderr.includes(rootConfig()) && r.stderr.includes('ENXIO'), 'the unusable FIFO is reported with its errno');
  });

  test('resolve_model_ids "omit" at the root with a FIFO workstream config: returns, and the omit still applies', () => {
    fs.writeFileSync(rootConfig(), JSON.stringify({ resolve_model_ids: 'omit' }));
    makeFifo(wsConfig());

    const r = resolveModel(['--ws', 'ws1']);

    assertExitedByItself(r);
    // The FIFO workstream layer is "does not set the key", so the omit check falls through
    // to the root layer, which sets it — without blocking on the pipe.
    assert.strictEqual(JSON.parse(r.stdout).model, '');
  });

  test('loadConfigResolved on a FIFO root config reports config_unreadable and degraded, never not_configured', () => {
    makeFifo(rootConfig());

    const r = loadResolvedInChild(tmpDir);

    assertExitedByItself(r);
    const resolution = JSON.parse(r.stdout);
    assert.strictEqual(resolution.reason, 'config_unreadable');
    assert.strictEqual(resolution.degraded, true);
  });
});

// Every other reader of a project or workstream config.json. Each command below reads the
// file through its own reader (not the loader), so a FIFO there hung the command before
// each reader was routed through the bounded read.
describe('#5759 a FIFO config.json must not hang any command that reads it', { skip: SKIP_WIN32 }, () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-5759-readers-'));
    fs.mkdirSync(path.join(tmpDir, '.planning', 'workstreams', 'ws1'), { recursive: true });
  });
  afterEach(() => { cleanup(tmpDir); });

  const rootConfig = () => path.join(tmpDir, '.planning', 'config.json');
  const wsConfig = () => path.join(tmpDir, '.planning', 'workstreams', 'ws1', 'config.json');

  const CLI_ROWS = [
    ['worktreesOptedOut', ['query', 'dispatch-isolation', '--raw']],
    ['cmdConfigGet', ['query', 'config-get', 'workflow.use_worktrees']],
    ['readConfigJsonBoolean / readConfigJsonValue (init.progress)', ['query', 'init.progress']],
    ['readConfigJsonValue (init.review)', ['query', 'init.review', '1']],
    ['resolvePhaseIdConvention (state.planned-phase)', ['query', 'state.planned-phase', '--phase', '1']],
    ['install-time effort config read (effort sync)', ['effort', 'sync']],
    ['drift-guard config read (drift-guard authority)', ['drift-guard', 'authority']],
    ['capReadStrict (capability install)', ['capability', 'install', './no-such-capability', '--scope', 'project']],
  ];

  for (const [where, fifoPath, workstream] of [
    ['root', () => rootConfig(), ''],
    ['workstream', () => wsConfig(), 'ws1'],
  ]) {
    for (const [label, argv] of CLI_ROWS) {
      test(`${where} config.json is a FIFO: ${label} returns instead of blocking`, () => {
        makeFifo(fifoPath());

        const r = runNode([TOOLS_PATH, ...argv], {
          cwd: tmpDir,
          env: installSpawnEnv({ GSD_RUNTIME: 'claude', GSD_WORKSTREAM: workstream }),
          timeoutMs: PROBE_TIMEOUT_MS,
        });

        assertExited(r);
      });
    }
  }

  const SCOPED_READERS_SCRIPT = [
    'const pw = require(process.argv[1]);',
    'const rs = require(process.argv[2]);',
    'const cwd = process.argv[3];',
    'process.stdout.write(JSON.stringify({',
    '  optedOut: pw.worktreesOptedOut(cwd),',
    '  convention: pw.resolvePhaseIdConvention(cwd),',
    '  runtime: rs.resolveRuntime(cwd),',
    '}));',
  ].join('\n');

  function scopedReaders(workstream) {
    return runNode(['-e', SCOPED_READERS_SCRIPT, PLANNING_WORKSPACE_PATH, RUNTIME_SLASH_PATH, tmpDir], {
      cwd: tmpDir,
      env: installSpawnEnv({ GSD_RUNTIME: '', GSD_WORKSTREAM: workstream }),
      timeoutMs: PROBE_TIMEOUT_MS,
    });
  }

  test('root config.json is a FIFO: worktreesOptedOut, resolvePhaseIdConvention and resolveRuntime degrade', () => {
    makeFifo(rootConfig());

    const r = scopedReaders('');

    assertExitedByItself(r);
    const out = JSON.parse(r.stdout);
    assert.strictEqual(out.optedOut, false, 'an unreadable config never opts out of worktrees');
    assert.strictEqual(out.convention, null);
    assert.strictEqual(typeof out.runtime, 'string');
  });

  test('workstream config.json is a FIFO: the readers fall back to the usable root config', () => {
    fs.writeFileSync(rootConfig(), JSON.stringify({
      workflow: { use_worktrees: false },
      phase_id_convention: 'milestone-prefixed',
    }));
    makeFifo(wsConfig());

    const r = scopedReaders('ws1');

    assertExitedByItself(r);
    const out = JSON.parse(r.stdout);
    assert.strictEqual(out.optedOut, true, 'the root config still opts out under the workstream gate');
    assert.strictEqual(out.convention, 'milestone-prefixed');
  });
});

describe('#5759 platformWriteSync never blocks on or follows a planted temp file or FIFO target', { skip: SKIP_WIN32 }, () => {
  let tmpDir;

  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-5759-write-')); });
  afterEach(() => { cleanup(tmpDir); });

  // The predictable pre-fix temp name is `<target>.tmp.<pid>`, so the child plants its own
  // pid-keyed entry before writing. A random-suffixed exclusive temp never meets it.
  const PLANTED_TMP_SCRIPT = [
    'const fs = require("node:fs");',
    'const { execFileSync } = require("node:child_process");',
    'const { platformWriteSync } = require(process.argv[1]);',
    'const target = process.argv[2];',
    'const planted = target + ".tmp." + process.pid;',
    'if (process.argv[3] === "fifo") execFileSync("mkfifo", [planted]);',
    'else fs.symlinkSync(process.argv[4], planted);',
    'platformWriteSync(target, "hello\\n");',
    'process.stdout.write(JSON.stringify({',
    '  content: fs.readFileSync(target, "utf8"),',
    '  plantedStillThere: fs.lstatSync(planted).isFIFO() || fs.lstatSync(planted).isSymbolicLink(),',
    '}));',
  ].join('\n');

  for (const ext of ['.json', '.md']) {
    test(`a FIFO planted at the predictable temp name does not hang a ${ext} write`, () => {
      const target = path.join(tmpDir, `out${ext}`);

      const r = runNode(['-e', PLANTED_TMP_SCRIPT, SHELL_PROJECTION_PATH, target, 'fifo'], {
        cwd: tmpDir,
        env: installSpawnEnv({}),
        timeoutMs: PROBE_TIMEOUT_MS,
      });

      assertExitedByItself(r);
      const out = JSON.parse(r.stdout);
      assert.ok(out.content.includes('hello'));
      assert.strictEqual(out.plantedStillThere, true, 'the planted entry is left alone, not opened or replaced');
    });

    test(`a symlink planted at the predictable temp name is not followed by a ${ext} write`, () => {
      const target = path.join(tmpDir, `out${ext}`);
      const victim = path.join(tmpDir, 'victim.txt');
      fs.writeFileSync(victim, 'ORIGINAL');

      const r = runNode(['-e', PLANTED_TMP_SCRIPT, SHELL_PROJECTION_PATH, target, 'symlink', victim], {
        cwd: tmpDir,
        env: installSpawnEnv({}),
        timeoutMs: PROBE_TIMEOUT_MS,
      });

      assertExitedByItself(r);
      assert.strictEqual(fs.readFileSync(victim, 'utf8'), 'ORIGINAL', 'the symlink target must not be written through');
      assert.ok(JSON.parse(r.stdout).content.includes('hello'));
    });
  }

  // When no temp file can be created the write falls back to the target path itself; that
  // direct write must refuse a non-regular target (and never block on a FIFO).
  const DIRECT_FALLBACK_SCRIPT = [
    'const fs = require("node:fs");',
    'const realOpen = fs.openSync;',
    'fs.openSync = (p, ...rest) => {',
    '  if (String(p).includes(".tmp.")) { const e = new Error("EACCES: no temp"); e.code = "EACCES"; throw e; }',
    '  return realOpen(p, ...rest);',
    '};',
    'const origWrite = fs.writeFileSync;',
    'fs.writeFileSync = (p, ...rest) => {',
    '  if (typeof p === "string" && String(p).includes(".tmp.")) { const e = new Error("EACCES: no temp"); e.code = "EACCES"; throw e; }',
    '  return origWrite(p, ...rest);',
    '};',
    'const { platformWriteSync } = require(process.argv[1]);',
    'try { platformWriteSync(process.argv[2], "hello\\n"); process.stdout.write(JSON.stringify({ code: "ok" })); }',
    'catch (e) { process.stdout.write(JSON.stringify({ code: e.code })); }',
  ].join('\n');

  for (const ext of ['.json', '.md']) {
    test(`direct fallback: a ${ext} target that is a FIFO is refused with ENXIO, not written or blocked on`, () => {
      const target = path.join(tmpDir, `out${ext}`);
      makeFifo(target);

      const r = runNode(['-e', DIRECT_FALLBACK_SCRIPT, SHELL_PROJECTION_PATH, target], {
        cwd: tmpDir,
        env: installSpawnEnv({}),
        timeoutMs: PROBE_TIMEOUT_MS,
      });

      assertExitedByItself(r);
      assert.strictEqual(JSON.parse(r.stdout).code, 'ENXIO');
    });
  }

  test('direct fallback: a dangling symlink target is refused with ENXIO, nothing is created through it', () => {
    const target = path.join(tmpDir, 'dangling.json');
    const missing = path.join(tmpDir, 'not-created.txt');
    fs.symlinkSync(missing, target);

    const r = runNode(['-e', DIRECT_FALLBACK_SCRIPT, SHELL_PROJECTION_PATH, target], {
      cwd: tmpDir,
      env: installSpawnEnv({}),
      timeoutMs: PROBE_TIMEOUT_MS,
    });

    assertExitedByItself(r);
    assert.strictEqual(JSON.parse(r.stdout).code, 'ENXIO');
    assert.strictEqual(fs.existsSync(missing), false, 'the link target must not be created');
    assert.ok(fs.lstatSync(target).isSymbolicLink(), 'the symlink itself is left in place');
  });

  // A write that fails after the file was truncated must leave the whole OLD content, not the
  // new prefix followed by the old tail.
  const PARTIAL_WRITE_SCRIPT = [
    'const fs = require("node:fs");',
    'const realOpen = fs.openSync;',
    'fs.openSync = (p, ...rest) => {',
    '  if (String(p).includes(".tmp.")) { const e = new Error("EACCES: no temp"); e.code = "EACCES"; throw e; }',
    '  return realOpen(p, ...rest);',
    '};',
    'const realWrite = fs.writeFileSync;',
    'fs.writeFileSync = (fd, data, ...rest) => {',
    '  if (typeof fd === "number") { fs.writeSync(fd, "NEW"); const e = new Error("ENOSPC: injected"); e.code = "ENOSPC"; throw e; }',
    '  return realWrite(fd, data, ...rest);',
    '};',
    'const { platformWriteSync } = require(process.argv[1]);',
    'try { platformWriteSync(process.argv[2], "NEW CONTENT THAT IS LONG\\n"); process.stdout.write(JSON.stringify({ code: "ok" })); }',
    'catch (e) { process.stdout.write(JSON.stringify({ code: e.code })); }',
  ].join('\n');

  test('direct fallback: a partial write leaves the whole old content, never new prefix plus old tail', () => {
    const target = path.join(tmpDir, 'partial.json');
    fs.writeFileSync(target, 'OLD CONTENT, LONGER THAN THE NEW PREFIX\n');

    const r = runNode(['-e', PARTIAL_WRITE_SCRIPT, SHELL_PROJECTION_PATH, target], {
      cwd: tmpDir,
      env: installSpawnEnv({}),
      timeoutMs: PROBE_TIMEOUT_MS,
    });

    assertExitedByItself(r);
    assert.strictEqual(JSON.parse(r.stdout).code, 'ENOSPC');
    assert.strictEqual(fs.readFileSync(target, 'utf8'), 'OLD CONTENT, LONGER THAN THE NEW PREFIX\n');
  });

  test('direct fallback: a target too large to capture for restore is refused with EFBIG before it is truncated', () => {
    const target = path.join(tmpDir, 'large.json');
    const original = 'x'.repeat(2 * 1024 * 1024 + 1);
    fs.writeFileSync(target, original);

    const r = runNode(['-e', DIRECT_FALLBACK_SCRIPT, SHELL_PROJECTION_PATH, target], {
      cwd: tmpDir,
      env: installSpawnEnv({}),
      timeoutMs: PROBE_TIMEOUT_MS,
    });

    assertExitedByItself(r);
    assert.strictEqual(JSON.parse(r.stdout).code, 'EFBIG');
    assert.strictEqual(fs.readFileSync(target, 'utf8'), original, 'the target is untouched');
  });

  test('an existing target keeps its permission bits across the atomic write', () => {
    const target = path.join(tmpDir, 'private.json');
    fs.writeFileSync(target, '{"old":true}');
    fs.chmodSync(target, 0o600);
    const plainWrite = [
      'const { platformWriteSync } = require(process.argv[1]);',
      'platformWriteSync(process.argv[2], "{\\"new\\":true}\\n");',
      'process.stdout.write("done");',
    ].join('\n');

    const r = runNode(['-e', plainWrite, SHELL_PROJECTION_PATH, target], {
      cwd: tmpDir,
      env: installSpawnEnv({}),
      timeoutMs: PROBE_TIMEOUT_MS,
    });

    assertExitedByItself(r);
    assert.ok(fs.readFileSync(target, 'utf8').includes('"new"'));
    if (process.platform !== 'win32') assert.strictEqual(fs.statSync(target).mode & 0o777, 0o600);
  });

  test('the temp file is never more permissive than an existing 0600 target, even at its first write', () => {
    const target = path.join(tmpDir, 'private2.json');
    fs.writeFileSync(target, '{"old":true}');
    fs.chmodSync(target, 0o600);
    const script = [
      'const fs = require("node:fs");',
      'let firstMode = null;',
      'const realWrite = fs.writeFileSync;',
      'fs.writeFileSync = (fd, ...rest) => {',
      '  if (typeof fd === "number" && firstMode === null) firstMode = fs.fstatSync(fd).mode & 0o777;',
      '  return realWrite(fd, ...rest);',
      '};',
      'require(process.argv[1]).platformWriteSync(process.argv[2], "{\\"new\\":true}\\n");',
      'process.stdout.write(JSON.stringify({ firstMode }));',
    ].join('\n');

    const r = runNode(['-e', script, SHELL_PROJECTION_PATH, target], {
      cwd: tmpDir,
      env: installSpawnEnv({}),
      timeoutMs: PROBE_TIMEOUT_MS,
    });

    assertExitedByItself(r);
    const { firstMode } = JSON.parse(r.stdout);
    if (process.platform !== 'win32') assert.strictEqual(firstMode & 0o077, 0, `temp mode at first write: ${firstMode.toString(8)}`);
  });

  test('direct fallback: a failed restore is flagged on the thrown error (restoreFailed)', () => {
    const target = path.join(tmpDir, 'restore.json');
    fs.writeFileSync(target, 'OLD CONTENT\n');
    const script = [
      'const fs = require("node:fs");',
      'const realOpen = fs.openSync;',
      'fs.openSync = (p, ...rest) => {',
      '  if (String(p).includes(".tmp.")) { const e = new Error("EACCES: no temp"); e.code = "EACCES"; throw e; }',
      '  return realOpen(p, ...rest);',
      '};',
      'const realWrite = fs.writeFileSync;',
      'fs.writeFileSync = (fd, ...rest) => {',
      '  if (typeof fd === "number") { const e = new Error("ENOSPC: injected"); e.code = "ENOSPC"; throw e; }',
      '  return realWrite(fd, ...rest);',
      '};',
      'fs.writeSync = () => { const e = new Error("EIO: restore"); e.code = "EIO"; throw e; };',
      'try { require(process.argv[1]).platformWriteSync(process.argv[2], "NEW\\n"); process.stdout.write("{}"); }',
      'catch (e) { process.stdout.write(JSON.stringify({ code: e.code, restoreFailed: e.restoreFailed === true })); }',
    ].join('\n');

    const r = runNode(['-e', script, SHELL_PROJECTION_PATH, target], {
      cwd: tmpDir,
      env: installSpawnEnv({}),
      timeoutMs: PROBE_TIMEOUT_MS,
    });

    assertExitedByItself(r);
    assert.deepStrictEqual(JSON.parse(r.stdout), { code: 'ENOSPC', restoreFailed: true });
  });

  test('direct fallback: a write-only (0200) target is refused before truncation, content intact', (t) => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) { t.skip('root bypasses mode bits'); return; }
    const target = path.join(tmpDir, 'writeonly.json');
    fs.writeFileSync(target, 'KEEP\n');
    fs.chmodSync(target, 0o200);

    const r = runNode(['-e', DIRECT_FALLBACK_SCRIPT, SHELL_PROJECTION_PATH, target], {
      cwd: tmpDir,
      env: installSpawnEnv({}),
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    fs.chmodSync(target, 0o600);

    assertExitedByItself(r);
    assert.strictEqual(JSON.parse(r.stdout).code, 'EACCES');
    assert.strictEqual(fs.readFileSync(target, 'utf8'), 'KEEP\n');
  });

  const SPECIAL_WRITE_SCRIPT = [
    'const { platformWriteSync } = require(process.argv[1]);',
    'const opts = process.argv[3] === "allow" ? { allowSpecialTarget: true } : {};',
    'try { platformWriteSync(process.argv[2], "hello\\n", opts); process.stdout.write(JSON.stringify({ code: "ok" })); }',
    'catch (e) { process.stdout.write(JSON.stringify({ code: e.code })); }',
  ].join('\n');

  test('a user-chosen character device (allowSpecialTarget) is written in place', () => {
    const r = runNode(['-e', SPECIAL_WRITE_SCRIPT, SHELL_PROJECTION_PATH, '/dev/null', 'allow'], {
      cwd: tmpDir,
      env: installSpawnEnv({}),
      timeoutMs: PROBE_TIMEOUT_MS,
    });

    assertExitedByItself(r);
    assert.strictEqual(JSON.parse(r.stdout).code, 'ok');
  });

  test('a user-chosen /dev/stdout (allowSpecialTarget) reaches the captured stdout', () => {
    const script = [
      'require(process.argv[1]).platformWriteSync("/dev/stdout", "via-dev-stdout\\n", { allowSpecialTarget: true });',
    ].join('\n');
    const r = runNode(['-e', script, SHELL_PROJECTION_PATH], {
      cwd: tmpDir,
      env: installSpawnEnv({}),
      timeoutMs: PROBE_TIMEOUT_MS,
    });

    assertExitedByItself(r);
    assert.ok(r.stdout.includes('via-dev-stdout'), r.stdout);
  });

  test('/dev/fd/1 (an inherited pipe or socket descriptor) is written through the descriptor', () => {
    const script = 'require(process.argv[1]).platformWriteSync("/dev/fd/1", "via-fd-1\\n", { allowSpecialTarget: true });';
    const r = runNode(['-e', script, SHELL_PROJECTION_PATH], {
      cwd: tmpDir,
      env: installSpawnEnv({}),
      timeoutMs: PROBE_TIMEOUT_MS,
    });

    assertExitedByItself(r);
    assert.ok(r.stdout.includes('via-fd-1'), r.stdout);
  });

  test('/dev/fd/5 (a descriptor beyond stdio) is not written through the descriptor alias', () => {
    const fifo = path.join(tmpDir, 'fd5.fifo');
    makeFifo(fifo);
    const script = [
      'const fs = require("node:fs");',
      'const keep = fs.openSync(process.argv[2], fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);',
      'const fd = fs.openSync(process.argv[2], fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);',
      'const plain = fs.openSync(process.argv[3], fs.constants.O_RDWR);',
      'const out = { fd, plainFd: plain };',
      'for (const [label, opts] of [["flag", { allowSpecialTarget: true, verbatim: true }], ["noflag", { verbatim: true }]]) {',
      '  for (const [kind, n] of [["fifo", fd], ["plain", plain]]) {',
      '    try { require(process.argv[1]).platformWriteSync("/dev/fd/" + n, "x", opts); out[label + kind] = "ok"; }',
      '    catch (e) { out[label + kind] = e.code; }',
      '  }',
      '}',
      'const buf = Buffer.alloc(16); let got = 0;',
      'try { got = fs.readSync(keep, buf, 0, 16, null); } catch (e) { got = e.code === "EAGAIN" ? 0 : -1; }',
      'out.fifoBytes = got;',
      'process.stdout.write(JSON.stringify(out));',
    ].join('\n');
    const plainFile = path.join(tmpDir, 'fd-plain.txt');
    fs.writeFileSync(plainFile, 'UNCHANGED');
    const r = runNode(['-e', script, SHELL_PROJECTION_PATH, fifo, plainFile], {
      cwd: tmpDir,
      env: installSpawnEnv({}),
      timeoutMs: PROBE_TIMEOUT_MS,
    });

    assertExitedByItself(r);
    const out = JSON.parse(r.stdout);
    assert.ok(out.fd > 2 && out.plainFd > 2, 'the test descriptors are beyond stdio');
    for (const key of ['flagfifo', 'flagplain', 'noflagfifo', 'noflagplain']) {
      assert.strictEqual(out[key], 'ENXIO', key);
    }
    assert.strictEqual(out.fifoBytes, 0, 'the FIFO reader observed no bytes');
    assert.strictEqual(fs.readFileSync(plainFile, 'utf8'), 'UNCHANGED');
  });

  test('a symlink to /dev/fd/<high fd> and a non-canonical /dev/fd/01 are refused with ENXIO', () => {
    const fifo = path.join(tmpDir, 'link.fifo');
    makeFifo(fifo);
    const link = path.join(tmpDir, 'to-fd');
    const script = [
      'const fs = require("node:fs");',
      'const keep = fs.openSync(process.argv[2], fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);',
      'const fd = fs.openSync(process.argv[2], fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);',
      'const hop2 = process.argv[3] + "-hop2";',
      'fs.symlinkSync("/dev/fd/" + fd, hop2);',
      'fs.symlinkSync(hop2, process.argv[3]);',
      'const out = {};',
      'for (const [label, target] of [["link", process.argv[3]], ["leading0", "/dev/fd/01"]]) {',
      '  for (const opts of [{ allowSpecialTarget: true, verbatim: true }, { verbatim: true }]) {',
      '    try { require(process.argv[1]).platformWriteSync(target, "x", opts); out[label + Object.keys(opts).length] = "ok"; }',
      '    catch (e) { out[label + Object.keys(opts).length] = e.code; }',
      '  }',
      '}',
      'let got = 0; try { got = fs.readSync(keep, Buffer.alloc(8), 0, 8, null); } catch (e) { got = e.code === "EAGAIN" ? 0 : -1; }',
      'out.fifoBytes = got;',
      'process.stdout.write(JSON.stringify(out));',
    ].join('\n');

    const r = runNode(['-e', script, SHELL_PROJECTION_PATH, fifo, link], {
      cwd: tmpDir,
      env: installSpawnEnv({}),
      timeoutMs: PROBE_TIMEOUT_MS,
    });

    assertExitedByItself(r);
    const out = JSON.parse(r.stdout);
    for (const key of ['link2', 'link1', 'leading02', 'leading01']) assert.strictEqual(out[key], 'ENXIO', key);
    assert.strictEqual(out.fifoBytes, 0, 'the FIFO reader observed no bytes');
  });

  test('a file symlink through a directory symlink to /dev/fd is refused with ENXIO', () => {
    const fifo = path.join(tmpDir, 'dir.fifo');
    makeFifo(fifo);
    const script = [
      'const fs = require("node:fs"); const path = require("node:path");',
      'const keep = fs.openSync(process.argv[2], fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);',
      'const fd = fs.openSync(process.argv[2], fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);',
      'const dir = path.join(process.argv[3], "fddir"); fs.symlinkSync("/dev/fd", dir);',
      'const link = path.join(process.argv[3], "link.md"); fs.symlinkSync(path.join(dir, String(fd)), link);',
      'const out = {};',
      'for (const opts of [{ allowSpecialTarget: true }, {}]) {',
      '  try { require(process.argv[1]).platformWriteSync(link, "x", opts); out["r" + Object.keys(opts).length] = "ok"; }',
      '  catch (e) { out["r" + Object.keys(opts).length] = e.code; }',
      '}',
      'let got = 0; try { got = fs.readSync(keep, Buffer.alloc(8), 0, 8, null); } catch (e) { got = e.code === "EAGAIN" ? 0 : -1; }',
      'out.fifoBytes = got;',
      'process.stdout.write(JSON.stringify(out));',
    ].join('\n');

    const r = runNode(['-e', script, SHELL_PROJECTION_PATH, fifo, tmpDir], {
      cwd: tmpDir,
      env: installSpawnEnv({}),
      timeoutMs: PROBE_TIMEOUT_MS,
    });

    assertExitedByItself(r);
    assert.deepStrictEqual(JSON.parse(r.stdout), { r1: 'ENXIO', r0: 'ENXIO', fifoBytes: 0 });
  });

  test('a direct write to <directory symlink to /dev/fd>/<high fd> is refused with ENXIO', () => {
    const fifo = path.join(tmpDir, 'direct.fifo');
    makeFifo(fifo);
    const script = [
      'const fs = require("node:fs"); const path = require("node:path");',
      'const keep = fs.openSync(process.argv[2], fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);',
      'const fd = fs.openSync(process.argv[2], fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);',
      'const dir = path.join(process.argv[3], "fddir2"); fs.symlinkSync("/dev/fd", dir);',
      'const out = {};',
      'for (const opts of [{ allowSpecialTarget: true }, {}]) {',
      '  try { require(process.argv[1]).platformWriteSync(path.join(dir, String(fd)), "x", opts); out["r" + Object.keys(opts).length] = "ok"; }',
      '  catch (e) { out["r" + Object.keys(opts).length] = e.code; }',
      '}',
      'let got = 0; try { got = fs.readSync(keep, Buffer.alloc(8), 0, 8, null); } catch (e) { got = e.code === "EAGAIN" ? 0 : -1; }',
      'out.fifoBytes = got;',
      'process.stdout.write(JSON.stringify(out));',
    ].join('\n');

    const r = runNode(['-e', script, SHELL_PROJECTION_PATH, fifo, tmpDir], {
      cwd: tmpDir,
      env: installSpawnEnv({}),
      timeoutMs: PROBE_TIMEOUT_MS,
    });

    assertExitedByItself(r);
    assert.deepStrictEqual(JSON.parse(r.stdout), { r1: 'ENXIO', r0: 'ENXIO', fifoBytes: 0 });
  });

  test('a descriptor alias reached through `..` after a directory symlink is refused with ENXIO, flag or no flag', () => {
    const fifo = path.join(tmpDir, 'dotdot.fifo');
    makeFifo(fifo);
    // `<tmp>/b -> /dev/fd`: the kernel resolves `<tmp>/b/../fd/N` to /dev/fd/N, a lexical
    // path.resolve to `<tmp>/fd/N`. Three spellings: direct, relative link target, absolute link target.
    const script = [
      'const fs = require("node:fs"); const path = require("node:path");',
      'const keep = fs.openSync(process.argv[2], fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);',
      'const fd = fs.openSync(process.argv[2], fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);',
      'const tmp = process.argv[3]; fs.symlinkSync("/dev/fd", tmp + "/b");',
      'fs.symlinkSync("b/../fd/" + fd, tmp + "/rel"); fs.symlinkSync(tmp + "/b/../fd/" + fd, tmp + "/abs");',
      'const targets = { direct: tmp + "/b/../fd/" + fd, rel: tmp + "/rel", abs: tmp + "/abs" };',
      'const out = {};',
      'for (const name of Object.keys(targets)) for (const opts of [{ allowSpecialTarget: true }, {}]) {',
      '  const key = name + (opts.allowSpecialTarget ? "Flag" : "Plain");',
      '  try { require(process.argv[1]).platformWriteSync(targets[name], "x", opts); out[key] = "ok"; }',
      '  catch (e) { out[key] = e.code; }',
      '}',
      'let got = 0; try { got = fs.readSync(keep, Buffer.alloc(8), 0, 8, null); } catch (e) { got = e.code === "EAGAIN" ? 0 : -1; }',
      'out.fifoBytes = got;',
      'process.stdout.write(JSON.stringify(out));',
    ].join('\n');

    const r = runNode(['-e', script, SHELL_PROJECTION_PATH, fifo, tmpDir], {
      cwd: tmpDir,
      env: installSpawnEnv({}),
      timeoutMs: PROBE_TIMEOUT_MS,
    });

    assertExitedByItself(r);
    assert.deepStrictEqual(JSON.parse(r.stdout), {
      directFlag: 'ENXIO', directPlain: 'ENXIO',
      relFlag: 'ENXIO', relPlain: 'ENXIO',
      absFlag: 'ENXIO', absPlain: 'ENXIO',
      fifoBytes: 0,
    });
  });

  test('a read-only directory holding a relative link to /dev/fd/N, reached through a symlink chain, is refused and the victim is untouched', {
    skip: typeof process.getuid === 'function' && process.getuid() === 0 ? 'root ignores the mode-555 directory' : false,
  }, () => {
    // Z (mode 555) holds `l -> <enough ..>/dev/fd/V`; `A/b/c/d -> Z`. The temp create in Z fails
    // EACCES, so the write falls to the direct path, which must not open the victim through l.
    const victim = path.join(tmpDir, 'victim.txt');
    fs.writeFileSync(victim, 'ORIGINAL');
    const script = [
      'const fs = require("node:fs"); const path = require("node:path");',
      'const tmp = fs.realpathSync(process.argv[3]);',
      'const keep = fs.openSync(process.argv[2], fs.constants.O_RDWR);',
      'const Z = tmp + "/Z"; fs.mkdirSync(Z); fs.mkdirSync(tmp + "/A/b/c", { recursive: true });',
      'fs.symlinkSync(path.relative(Z, "/dev/fd/" + keep), Z + "/l");',
      'fs.symlinkSync(Z, tmp + "/A/b/c/d"); fs.chmodSync(Z, 0o555);',
      'const out = {};',
      'for (const opts of [{ allowSpecialTarget: true }, {}]) {',
      '  const key = opts.allowSpecialTarget ? "flag" : "plain";',
      '  try { require(process.argv[1]).platformWriteSync(tmp + "/A/b/c/d/l", "PWNED", opts); out[key] = "ok"; }',
      '  catch (e) { out[key] = e.code; }',
      '}',
      'fs.chmodSync(Z, 0o755);',
      'process.stdout.write(JSON.stringify(out));',
    ].join('\n');

    const r = runNode(['-e', script, SHELL_PROJECTION_PATH, victim, tmpDir], {
      cwd: tmpDir,
      env: installSpawnEnv({}),
      timeoutMs: PROBE_TIMEOUT_MS,
    });

    assertExitedByItself(r);
    assert.deepStrictEqual(JSON.parse(r.stdout), { flag: 'ENXIO', plain: 'ENXIO' });
    assert.strictEqual(fs.readFileSync(victim, 'utf8'), 'ORIGINAL');
  });

  test('profile-output --output /dev/null (a user-chosen device) is written', () => {
    fs.writeFileSync(path.join(tmpDir, 'analysis.json'), JSON.stringify({ data_source: 'x', dimensions: {} }));
    const script = [
      'const m = require(process.argv[1]);',
      'try { m.cmdGenerateClaudeProfile(process.cwd(), { output: "/dev/null", analysis: "analysis.json" }, true); process.stdout.write("\\nOK"); }',
      'catch (e) { process.stdout.write("\\nERR " + e.message); }',
    ].join('\n');
    const r = runNode(['-e', script, path.join(LIB_DIR, 'profile-output.cjs')], {
      cwd: tmpDir,
      env: installSpawnEnv({}),
      timeoutMs: PROBE_TIMEOUT_MS,
    });

    assertExitedByItself(r);
    assert.ok(r.stdout.endsWith('OK'), r.stdout);
  });

  test('a FIFO with a slowly draining reader receives every byte of a write larger than the pipe buffer', () => {
    const fifo = path.join(tmpDir, 'big.fifo');
    makeFifo(fifo);
    const total = 256 * 1024;
    const reader = [
      'const fs = require("node:fs");',
      // Non-blocking open first (no writer needed), announce, then the blocking descriptor we read from.
      'const nb = fs.openSync(process.argv[1], fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);',
      'process.stderr.write("ready");',
      'const fd = fs.openSync(process.argv[1], fs.constants.O_RDONLY);',
      'fs.closeSync(nb);',
      'const buf = Buffer.alloc(4096); let n = 0, r;',
      'const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);',
      'while ((r = fs.readSync(fd, buf, 0, buf.length, null)) > 0) { n += r; if (n % 65536 < 4096) sleep(5); }',
      'process.stdout.write(String(n));',
    ].join('\n');

    return withFifoReader(fifo, reader, `, specialTargetWait: {}`, total, tmpDir).then(({ writer, readerOut }) => {
      assert.strictEqual(writer, 'done');
      assert.strictEqual(Number(readerOut), total);
    });
  });

  test('a reader that closes mid-write surfaces a coded EPIPE error, not a hang', () => {
    const fifo = path.join(tmpDir, 'leave.fifo');
    makeFifo(fifo);
    const reader = [
      'const fs = require("node:fs");',
      // Non-blocking open first (no writer needed), announce, then the blocking descriptor we read from.
      'const nb = fs.openSync(process.argv[1], fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);',
      'process.stderr.write("ready");',
      'const fd = fs.openSync(process.argv[1], fs.constants.O_RDONLY);',
      'fs.closeSync(nb);',
      'fs.readSync(fd, Buffer.alloc(65536), 0, 65536, null);',
      'fs.closeSync(fd);',
      'process.exit(0);',
    ].join('\n');

    // The default (real) back-off and a huge bound: EPIPE must win over ETIMEDOUT.
    return withFifoReader(fifo, reader, ', specialTargetWait: { maxWaitMs: 1e12 }', 256 * 1024, tmpDir)
      .then(({ writer }) => { assert.strictEqual(writer, 'EPIPE'); });
  });

  test('a reader that never drains the pipe ends in a coded ETIMEDOUT once the bound is spent', () => {
    const fifo = path.join(tmpDir, 'stall.fifo');
    makeFifo(fifo);
    const reader = [
      'const fs = require("node:fs");',
      'fs.openSync(process.argv[1], fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);',
      'process.stderr.write("ready");',
      'setTimeout(() => {}, 60000);',
    ].join('\n');

    return withFifoReader(fifo, reader, ', specialTargetWait: { sleep: () => {}, maxWaitMs: 10 }', 256 * 1024, tmpDir, true)
      .then(({ writer }) => { assert.strictEqual(writer, 'ETIMEDOUT'); });
  });

  test('a regular file reached through /dev/../ takes the atomic path (no special handling)', () => {
    const target = path.join(tmpDir, 'plain.json');
    const viaDev = `/dev/../${path.relative('/', target)}`;
    const r = runNode(['-e', SPECIAL_WRITE_SCRIPT, SHELL_PROJECTION_PATH, viaDev, 'allow'], {
      cwd: tmpDir,
      env: installSpawnEnv({}),
      timeoutMs: PROBE_TIMEOUT_MS,
    });

    assertExitedByItself(r);
    assert.strictEqual(JSON.parse(r.stdout).code, 'ok');
    assert.ok(fs.readFileSync(target, 'utf8').includes('hello'));
    assert.deepStrictEqual(fs.readdirSync(tmpDir).filter((n) => n.includes('.tmp.')), []);
  });

  test('a socket is written in place only as a descriptor alias (/dev/stdout), refused otherwise', () => {
    const script = [
      'const fs = require("node:fs");',
      'const real = fs.statSync;',
      'const sock = { isBlockDevice: () => false, isSocket: () => true, isCharacterDevice: () => false, isFIFO: () => false, isFile: () => false };',
      'fs.statSync = (p, ...rest) => (String(p).endsWith("fake-sock") || String(p) === "/dev/stdout" ? sock : real(p, ...rest));',
      'const out = {}; const fdWrites = [];',
      'const realWriteSync = fs.writeSync; const realOpen = fs.openSync;',
      'fs.writeSync = (fd, ...rest) => { fdWrites.push(fd); return rest[0].length; };',
      'fs.openSync = (p, ...rest) => { out.reopened = true; return realOpen(p, ...rest); };',
      'for (const target of ["/dev/stdout", process.argv[2]]) {',
      '  try { require(process.argv[1]).platformWriteSync(target, "z", { allowSpecialTarget: true, verbatim: true }); out[target.slice(-9)] = "ok"; }',
      '  catch (e) { out[target.slice(-9)] = e.code; }',
      '}',
      'out.fdWrites = fdWrites; fs.writeSync = realWriteSync;',
      'process.stderr.write(JSON.stringify(out));',
    ].join('\n');
    const r = runNode(['-e', script, SHELL_PROJECTION_PATH, path.join(tmpDir, 'fake-sock')], {
      cwd: tmpDir,
      env: installSpawnEnv({}),
      timeoutMs: PROBE_TIMEOUT_MS,
    });

    assertExitedByItself(r);
    const out = JSON.parse(r.stderr);
    assert.strictEqual(out['fake-sock'], 'ENXIO');
    assert.deepStrictEqual(out.fdWrites, [1], 'the alias is written through descriptor 1, never reopened by path');
    assert.strictEqual(out.reopened, undefined);
    assert.strictEqual(out['/dev/stdout'.slice(-9)], 'ok');
  });

  test('a block device or socket target is refused with ENXIO even with allowSpecialTarget', () => {
    const script = [
      'const fs = require("node:fs");',
      'const real = fs.statSync;',
      'fs.statSync = (p, ...rest) => (String(p).endsWith("fake-block") ? { isBlockDevice: () => true, isSocket: () => false, isCharacterDevice: () => false, isFIFO: () => false, isFile: () => false } : real(p, ...rest));',
      'try { require(process.argv[1]).platformWriteSync(process.argv[2], "x", { allowSpecialTarget: true }); process.stdout.write("ok"); }',
      'catch (e) { process.stdout.write(e.code); }',
    ].join('\n');
    const r = runNode(['-e', script, SHELL_PROJECTION_PATH, path.join(tmpDir, 'fake-block')], {
      cwd: tmpDir,
      env: installSpawnEnv({}),
      timeoutMs: PROBE_TIMEOUT_MS,
    });

    assertExitedByItself(r);
    assert.strictEqual(r.stdout, 'ENXIO');
  });

  test('without allowSpecialTarget a character device target is still refused with ENXIO', (t) => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) { t.skip('root can create the temp file in /dev'); return; }
    const r = runNode(['-e', SPECIAL_WRITE_SCRIPT, SHELL_PROJECTION_PATH, '/dev/null', 'deny'], {
      cwd: tmpDir,
      env: installSpawnEnv({}),
      timeoutMs: PROBE_TIMEOUT_MS,
    });

    assertExitedByItself(r);
    assert.strictEqual(JSON.parse(r.stdout).code, 'ENXIO');
  });

  test('a FIFO with no reader is refused with ENXIO even with allowSpecialTarget', () => {
    const fifo = path.join(tmpDir, 'out.fifo');
    makeFifo(fifo);
    const r = runNode(['-e', SPECIAL_WRITE_SCRIPT, SHELL_PROJECTION_PATH, fifo, 'allow'], {
      cwd: tmpDir,
      env: installSpawnEnv({}),
      timeoutMs: PROBE_TIMEOUT_MS,
    });

    assertExitedByItself(r);
    assert.strictEqual(JSON.parse(r.stdout).code, 'ENXIO');
  });

  test('a name needing the second suffix shrink (2 random bytes) is still written atomically', () => {
    const name = `${'n'.repeat(240)}.json`;
    const target = path.join(tmpDir, name);
    const plainWrite = [
      'const { platformWriteSync } = require(process.argv[1]);',
      'platformWriteSync(process.argv[2], "hello\\n");',
      'process.stdout.write("done");',
    ].join('\n');

    const r = runNode(['-e', plainWrite, SHELL_PROJECTION_PATH, target], {
      cwd: tmpDir,
      env: installSpawnEnv({}),
      timeoutMs: PROBE_TIMEOUT_MS,
    });

    assertExitedByItself(r);
    assert.deepStrictEqual(fs.readdirSync(tmpDir), [name]);
    assert.ok(fs.readFileSync(target, 'utf8').includes('hello'));
  });

  test('a target name too long for the default temp suffix is still written atomically (shorter suffix)', () => {
    const name = `${'n'.repeat(236)}.json`;
    const target = path.join(tmpDir, name);

    const plainWrite = [
      'const { platformWriteSync } = require(process.argv[1]);',
      'platformWriteSync(process.argv[2], "hello\\n");',
      'process.stdout.write("done");',
    ].join('\n');
    const r = runNode(['-e', plainWrite, SHELL_PROJECTION_PATH, target], {
      cwd: tmpDir,
      env: installSpawnEnv({}),
      timeoutMs: PROBE_TIMEOUT_MS,
    });

    assertExitedByItself(r);
    assert.ok(fs.readFileSync(target, 'utf8').includes('hello'));
    assert.deepStrictEqual(fs.readdirSync(tmpDir), [name], 'no temp file is left beside the target');
  });

  test('direct fallback: a device target is refused with ENXIO', () => {
    const r = runNode(['-e', DIRECT_FALLBACK_SCRIPT, SHELL_PROJECTION_PATH, '/dev/null'], {
      cwd: tmpDir,
      env: installSpawnEnv({}),
      timeoutMs: PROBE_TIMEOUT_MS,
    });

    assertExitedByItself(r);
    assert.strictEqual(JSON.parse(r.stdout).code, 'ENXIO');
  });
});

describe('#5759 openExclusiveTempSync creates the temp file exclusively and never follows a link', {
  skip: SKIP_WIN32,
}, () => {
  const { openExclusiveTempSync } = require(SHELL_PROJECTION_PATH);
  let tmpDir;

  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-5759-excl-')); });
  afterEach(() => { cleanup(tmpDir); });

  test('a symlink already at the first candidate name is skipped: the next suffix is used, the link target untouched', () => {
    const base = path.join(tmpDir, 'target.json');
    const victim = path.join(tmpDir, 'victim.txt');
    fs.writeFileSync(victim, 'ORIGINAL');
    fs.symlinkSync(victim, `${base}.tmp.taken`);
    const suffixes = ['taken', 'free'];

    const { fd, tmpPath } = openExclusiveTempSync(base, () => suffixes.shift());
    try {
      fs.writeSync(fd, 'payload');
    } finally {
      fs.closeSync(fd);
    }

    assert.strictEqual(tmpPath, `${base}.tmp.free`);
    assert.strictEqual(fs.readFileSync(tmpPath, 'utf8'), 'payload');
    assert.strictEqual(fs.readFileSync(victim, 'utf8'), 'ORIGINAL', 'the symlink target must never be written');
    assert.ok(fs.lstatSync(`${base}.tmp.taken`).isSymbolicLink(), 'the planted link is left in place');
  });

  test('a dangling symlink at the candidate name is not created through', () => {
    const base = path.join(tmpDir, 'target.json');
    const missing = path.join(tmpDir, 'not-created.txt');
    fs.symlinkSync(missing, `${base}.tmp.taken`);
    const suffixes = ['taken', 'free'];

    const { fd } = openExclusiveTempSync(base, () => suffixes.shift());
    fs.closeSync(fd);

    assert.strictEqual(fs.existsSync(missing), false, 'a dangling link must not be followed to create its target');
  });

  test('five consecutive collisions throw EEXIST and the generator was asked exactly five times', () => {
    const base = path.join(tmpDir, 'target.json');
    fs.writeFileSync(`${base}.tmp.taken`, 'occupied');
    let asked = 0;

    assert.throws(
      () => openExclusiveTempSync(base, () => { asked += 1; return 'taken'; }),
      (err) => err.code === 'EEXIST',
    );
    assert.strictEqual(asked, 5);
    assert.strictEqual(fs.readFileSync(`${base}.tmp.taken`, 'utf8'), 'occupied', 'the occupant is not truncated');
  });

  test('the default suffix is unpredictable: two calls yield two distinct names', () => {
    const base = path.join(tmpDir, 'target.json');
    const a = openExclusiveTempSync(base);
    const b = openExclusiveTempSync(base);
    fs.closeSync(a.fd);
    fs.closeSync(b.fd);

    assert.notStrictEqual(a.tmpPath, b.tmpPath);
    assert.ok(a.tmpPath.startsWith(`${base}.tmp.`));
  });

  test('a creation mode of 0600 yields a temp with no group or other bit at creation, whatever the umask', () => {
    const base = path.join(tmpDir, 'target.json');
    const previous = process.umask(0);
    let made;
    try {
      made = openExclusiveTempSync(base, undefined, 0o600);
    } finally {
      process.umask(previous);
    }
    try {
      if (process.platform !== 'win32') assert.strictEqual(fs.fstatSync(made.fd).mode & 0o777, 0o600);
    } finally {
      fs.closeSync(made.fd);
    }
  });

  test('the default creation mode is 0666 narrowed by the umask', () => {
    const base = path.join(tmpDir, 'target.json');
    const previous = process.umask(0o022);
    let made;
    try {
      made = openExclusiveTempSync(base);
    } finally {
      process.umask(previous);
    }
    try {
      if (process.platform !== 'win32') assert.strictEqual(fs.fstatSync(made.fd).mode & 0o777, 0o644);
    } finally {
      fs.closeSync(made.fd);
    }
  });

  test('platformWriteSync keeps a 0600 target 0600 and gives a new file 0666 narrowed by the umask', () => {
    const { platformWriteSync } = require(SHELL_PROJECTION_PATH);
    const priv = path.join(tmpDir, 'private.json');
    fs.writeFileSync(priv, '{}', { mode: 0o600 });
    fs.chmodSync(priv, 0o600);
    const fresh = path.join(tmpDir, 'fresh.json');
    const previous = process.umask(0o022);
    try {
      platformWriteSync(priv, '{"a":1}\n');
      platformWriteSync(fresh, '{"a":1}\n');
    } finally {
      process.umask(previous);
    }
    if (process.platform !== 'win32') {
      assert.strictEqual(fs.statSync(priv).mode & 0o777, 0o600);
      assert.strictEqual(fs.statSync(fresh).mode & 0o777, 0o644);
    }
  });
});

describe('#5759 printablePath escapes invisible and bidirectional formatting characters', () => {
  const { printablePath } = require(path.join(LIB_DIR, 'config-file-read.cjs'));
  const escaped = (cp) => `\\u${cp.toString(16).padStart(4, '0')}`;
  // [first, last, below, above] of each escaped range. `below` / `above` are the nearest code points
  // outside the range that printablePath leaves alone: the numeric neighbours of three ranges are
  // themselves escaped (U+2029 / U+202a abut each other, U+206a is a Cf character), so they are not used.
  const RANGES = [
    [0x200b, 0x200f, 0x200a, 0x2010],
    [0x2028, 0x2029, 0x2027, 0x202f],
    [0x202a, 0x202e, 0x2027, 0x202f],
    [0x2066, 0x2069, 0x205f, 0x2070],
  ];

  for (const [lo, hi, below, above] of RANGES) {
    test(`U+${lo.toString(16)}..U+${hi.toString(16)} are escaped and the neighbours are not`, () => {
      assert.strictEqual(printablePath(`a${String.fromCodePoint(below)}b`), `a${String.fromCodePoint(below)}b`);
      assert.strictEqual(printablePath(`a${String.fromCodePoint(above)}b`), `a${String.fromCodePoint(above)}b`);
      for (let cp = lo; cp <= hi; cp++) {
        assert.strictEqual(printablePath(`a${String.fromCodePoint(cp)}b`), `a${escaped(cp)}b`, `U+${cp.toString(16)}`);
      }
    });
  }

  test('the existing C0, DEL and C1 escapes are unchanged at their edges', () => {
    const nbsp = String.fromCharCode(0xa0);
    assert.strictEqual(printablePath(`\u001f ~\u007f\u009f${nbsp}`), `\\x1f ~\\x7f\\x9f${nbsp}`);
  });
});

describe('#5759 the hook config reader opens with O_NOCTTY', () => {
  const { mock } = require('node:test');
  const { readConfigFileBounded } = require(path.join(__dirname, '..', 'hooks', 'lib', 'config-read.js'));
  let tmpDir;

  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-5759-noctty-')); });
  afterEach(() => { mock.restoreAll(); cleanup(tmpDir); });

  test('the open flags carry O_NOCTTY where the platform defines it', () => {
    const file = path.join(tmpDir, 'config.json');
    fs.writeFileSync(file, '{}');
    const seen = [];
    const realOpen = fs.openSync;
    mock.method(fs, 'openSync', (p, flags, ...rest) => { seen.push(flags); return realOpen(p, flags, ...rest); });

    assert.strictEqual(readConfigFileBounded(file), '{}');

    assert.strictEqual(seen.length, 1);
    const noctty = fs.constants.O_NOCTTY || 0;
    assert.strictEqual(seen[0] & noctty, noctty);
  });
});

describe('#5759 an unusable-config warning never writes a raw control character', { skip: SKIP_WIN32 }, () => {
  let tmpDir;

  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-5759-ctl-')); });
  afterEach(() => { cleanup(tmpDir); });

  test('a project directory whose name contains ESC is reported with an escaped, printable path', () => {
    const project = path.join(tmpDir, 'proj\u001b[31mred');
    fs.mkdirSync(path.join(project, '.planning', 'config.json'), { recursive: true });

    const r = loadResolvedInChild(project);

    assertExitedByItself(r);
    assert.strictEqual(JSON.parse(r.stdout).reason, 'config_unreadable');
    assert.ok(!r.stderr.includes('\u001b'), 'no raw ESC byte reaches the terminal');
    assert.ok(r.stderr.includes('proj\\x1b[31mred'), `the ESC is shown escaped: ${JSON.stringify(r.stderr)}`);
  });
});

// Library readers with no CLI entry of their own: a child requires the built module and calls the
// reader against a project whose config.json is a FIFO. The child must exit by itself.
describe('#5759 every other rerouted reader returns on a FIFO config.json', { skip: SKIP_WIN32 }, () => {
  let tmpDir;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-5759-lib-'));
    fs.mkdirSync(path.join(tmpDir, '.planning'), { recursive: true });
    makeFifo(path.join(tmpDir, '.planning', 'config.json'));
  });
  afterEach(() => { cleanup(tmpDir); });

  // [label, module, expression over `m` (the module) and `cwd`]. Errors are swallowed in the
  // child: only a hang matters here, the reader's own degraded result is pinned where noted.
  const LIB_ROWS = [
    ['gap-checker readGate', 'gap-checker', 'm.runGapAnalysis(cwd, "1")'],
    ['graphify resolveGraphLocation (graphifyQuery)', 'graphify', 'm.graphifyQuery(cwd, "x")'],
    ['graphify graphifyBuild', 'graphify', 'm.graphifyBuild(cwd)'],
    ['estimate-cli readSmartZoneBudget', 'estimate-cli', 'm.readSmartZoneBudget(cwd)'],
    ['cmdPhaseComplete auto-prune read', 'phase', 'm.cmdPhaseComplete(cwd, "1", false)'],
    ['health-diagnostic repair (addNyquistKey)', 'health-diagnostic',
      'm.applyRepairs(cwd, [{ code: "W005", remedy: { action: "addNyquistKey", risk: "safe" } }], true, false)'],
    ['roadmap-upgrade computeMigrationPlan', 'roadmap-upgrade', 'm.computeMigrationPlan(cwd, {})'],
    ['roadmap-upgrade computeBracketPlan', 'roadmap-upgrade', 'm.computeMigrationPlan(cwd, { convention: "bracket" })'],
    ['capability-activation resolveConfigKey', 'capability-activation',
      'm.resolveConfigKey("security_enforcement", { config: {}, cwd, registry: {} })'],
    ['capability-writer setCapabilityState', 'capability-writer', 'm.setCapabilityState(cwd, { id: "x", enabled: true })'],
    ['configuration migrateOnDisk', 'configuration', 'm.migrateOnDisk(cwd, undefined, require("node:path").join(cwd, ".planning", "config.json"))'],
    ['project-root findProjectRoot', 'project-root', 'm.findProjectRoot(require("node:path").join(cwd, "sub", "dir"))'],
    ['planning-snapshot buildConfigField', 'planning-snapshot', 'm.buildPlanningSnapshot(cwd)'],
    ['phase-locator phaseDirectoryOptions', 'phase-locator', 'm.phaseDirectoryOptions(cwd)'],
    ['stale-bake-guard _readRuntimeConfig (warnIfStaleBake)', 'stale-bake-guard', 'm.warnIfStaleBake(cwd)'],
    ['install-model-override-resolver readGsdEffectiveModelOverrides', 'install-model-override-resolver',
      'm.readGsdEffectiveModelOverrides(cwd)'],
  ];

  for (const [label, mod, expr] of LIB_ROWS) {
    test(`${label} returns instead of blocking`, () => {
      const script = [
        'const path = require("node:path");',
        'const m = require(path.join(process.argv[1], process.argv[2] + ".cjs"));',
        'const cwd = process.argv[3];',
        'try { void (' + expr + '); } catch (e) { /* only a hang matters */ }',
        'process.stdout.write("done");',
      ].join('\n');

      const r = runNode(['-e', script, LIB_DIR, mod, tmpDir], {
        cwd: tmpDir,
        env: installSpawnEnv({ GSD_RUNTIME: 'claude', GSD_WORKSTREAM: '' }),
        timeoutMs: PROBE_TIMEOUT_MS,
      });

      assertExited(r);
    });
  }

  test('roadmap-upgrade applyMigration throws and rolls back on a FIFO config instead of writing to it', () => {
    // A clean working tree is a precondition of applyMigration; the FIFO is excluded from status.
    const git = (...args) => gitOrThrow(['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], {
      cwd: tmpDir, timeoutMs: PROBE_TIMEOUT_MS,
    });
    git('init', '-q', '.');
    fs.appendFileSync(path.join(tmpDir, '.git', 'info', 'exclude'), '.planning/config.json\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'line a\n');
    git('add', '-A');
    git('commit', '-qm', 'init');
    const script = [
      'const path = require("node:path");',
      'const m = require(path.join(process.argv[1], "roadmap-upgrade.cjs"));',
      'const cwd = process.argv[2];',
      'const plan = { alreadyMigrated: false, phases: [], roadmapEdits: [{ file: "ROADMAP.md", from: "a", to: "b" }], crossRefEdits: [] };',
      'let message = "";',
      'try { m.applyMigration(cwd, plan, { dryRun: false }); } catch (e) { message = String(e.message); }',
      'process.stdout.write(JSON.stringify({ message }));',
    ].join('\n');

    const r = runNode(['-e', script, LIB_DIR, tmpDir], {
      cwd: tmpDir,
      env: installSpawnEnv({ GSD_RUNTIME: 'claude', GSD_WORKSTREAM: '' }),
      timeoutMs: PROBE_TIMEOUT_MS,
    });

    assertExitedByItself(r);
    assert.ok(JSON.parse(r.stdout).message.includes('ENXIO'), r.stdout);
  });

  test('isRealInstallFs is true by default and false while a fake adapter is injected', () => {
    const adapter = require(path.join(LIB_DIR, 'install-fs-adapter.cjs'));
    assert.strictEqual(adapter.isRealInstallFs(), true);
    adapter.withInstallFs({ existsSync: () => false }, () => {
      assert.strictEqual(adapter.isRealInstallFs(), false);
    });
    assert.strictEqual(adapter.isRealInstallFs(), true);
  });

  test('the installer warning for an unusable project config prints the path with control characters escaped', () => {
    const project = path.join(tmpDir, 'proj\u001b[31mred');
    fs.mkdirSync(path.join(project, '.planning'), { recursive: true });
    makeFifo(path.join(project, '.planning', 'config.json'));
    const script = [
      'const path = require("node:path");',
      'const m = require(path.join(process.argv[1], "install-effort-resolver.cjs"));',
      'm.readGsdEffectiveEffortConfig(process.argv[2]);',
      'process.stdout.write("done");',
    ].join('\n');

    const r = runNode(['-e', script, LIB_DIR, project], {
      cwd: tmpDir,
      env: installSpawnEnv({}),
      timeoutMs: PROBE_TIMEOUT_MS,
    });

    assertExitedByItself(r);
    assert.ok(!r.stderr.includes('\u001b'), 'no raw ESC byte reaches the terminal');
    assert.ok(r.stderr.includes('proj\\x1b[31mred'), JSON.stringify(r.stderr));
  });

  test('migrateOnDisk on a FIFO config reports nothing to migrate', () => {
    const script = [
      'const path = require("node:path");',
      'const m = require(path.join(process.argv[1], "configuration.cjs"));',
      'process.stdout.write(JSON.stringify(m.migrateOnDisk(process.argv[2], undefined, path.join(process.argv[2], ".planning", "config.json"))));',
    ].join('\n');

    const r = runNode(['-e', script, LIB_DIR, tmpDir], {
      cwd: tmpDir,
      env: installSpawnEnv({}),
      timeoutMs: PROBE_TIMEOUT_MS,
    });

    assertExitedByItself(r);
    assert.strictEqual(JSON.parse(r.stdout).migrated, false);
  });
});

// Hooks run inside the user's session on every tool call and are staged as standalone files.
describe('#5759 hooks, the opencode plugin and the installer do not block on a FIFO config.json', {
  skip: SKIP_WIN32,
}, () => {
  const HOOKS_DIR = path.join(__dirname, '..', 'hooks');
  let tmpDir;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-5759-hooks-'));
    fs.mkdirSync(path.join(tmpDir, '.planning'), { recursive: true });
    makeFifo(path.join(tmpDir, '.planning', 'config.json'));
  });
  afterEach(() => { cleanup(tmpDir); });

  const HOOK_ROWS = [
    ['gsd-config-reload.js', (p) => ({ event: 'change', file_path: path.join(p, '.planning', 'config.json'), cwd: p })],
    ['gsd-context-monitor.js', (p) => ({ session_id: 's', cwd: p })],
    ['gsd-workflow-guard.js', (p) => ({ tool_name: 'Write', tool_input: { file_path: path.join(p, 'a.txt') }, cwd: p })],
    ['gsd-agent-isolation-guard.js', (p) => ({
      tool_name: 'Agent', tool_input: { subagent_type: 'gsd-executor', prompt: 'x' }, cwd: p,
    })],
  ];

  for (const [hook, payload] of HOOK_ROWS) {
    test(`${hook} exits on its own with a FIFO project config.json`, () => {
      const r = runNode([path.join(HOOKS_DIR, hook)], {
        cwd: tmpDir,
        env: installSpawnEnv({ GSD_RUNTIME: '', GSD_WORKSTREAM: '' }),
        input: JSON.stringify(payload(tmpDir)),
        timeoutMs: PROBE_TIMEOUT_MS,
      });

      assertExited(r);
    });
  }

  test('the hooks reader returns text, null for absent, and throws ENXIO / EFBIG / EISDIR', () => {
    const { readConfigFileBounded, CONFIG_MAX_BYTES } = require(path.join(HOOKS_DIR, 'lib', 'config-read.js'));
    const file = path.join(tmpDir, 'plain.json');
    fs.writeFileSync(file, '{"a":1}');

    assert.strictEqual(readConfigFileBounded(file), '{"a":1}');
    assert.strictEqual(readConfigFileBounded(path.join(tmpDir, 'absent.json')), null);
    assert.throws(() => readConfigFileBounded(path.join(tmpDir, 'absent.json'), { required: true }), (e) => e.code === 'ENOENT');
    assert.throws(() => readConfigFileBounded(tmpDir), (e) => e.code === 'EISDIR');
    fs.writeFileSync(file, ' '.repeat(CONFIG_MAX_BYTES + 1));
    assert.throws(() => readConfigFileBounded(file), (e) => e.code === 'EFBIG');
  });

  test('the hooks reader and the built reader agree on the size cap', () => {
    const hooksCap = require(path.join(HOOKS_DIR, 'lib', 'config-read.js')).CONFIG_MAX_BYTES;
    assert.strictEqual(hooksCap, require(path.join(LIB_DIR, 'config-file-read.cjs')).CONFIG_MAX_BYTES);
  });

  test('the opencode plugin reader (readConfigBounded) is bounded: contextWarningsDisabled returns on a FIFO', () => {
    // The plugin exports only its factory; the config reads sit behind its tool.execute hooks,
    // so a child builds the plugin for the project and drives both hooks once.
    for (const plugin of ['.opencode', '.kilo']) {
      const pluginPath = path.join(__dirname, '..', plugin, 'plugins', 'gsd-core.js');
      const script = [
        '(async () => {',
        '  const m = require(process.argv[1]);',
        '  const hooks = await m.server({ directory: process.argv[2] });',
        '  const call = { tool: "bash", args: { command: "git commit -m x" }, sessionID: "s" };',
        '  for (const name of ["tool.execute.before", "tool.execute.after"]) {',
        '    try { await hooks[name](call, { args: call.args, output: "", metadata: {} }); } catch (e) { /* only a hang matters */ }',
        '  }',
        '  process.stdout.write("done");',
        '})();',
      ].join('\n');

      const r = runNode(['-e', script, pluginPath, tmpDir], {
        cwd: tmpDir,
        env: installSpawnEnv({ CI: '' }),
        timeoutMs: PROBE_TIMEOUT_MS,
      });

      assertExitedByItself(r);
      assert.strictEqual(r.stdout, 'done', `${plugin} plugin hooks completed`);
    }
  });

  test('bin/install.js completes a local install when an ancestor .planning/config.json is a FIFO', () => {
    const r = runNode([path.join(__dirname, '..', 'bin', 'install.js'), '--claude', '--local'], {
      cwd: tmpDir,
      env: installSpawnEnv({ GSD_WORKSTREAM: '' }),
      timeoutMs: INSTALL_TIMEOUT_MS,
    });

    assertExitedByItself(r);
  });
});

// The plugin copies carry their own inlined cap; the observable is whether the context-monitor
// hook is spawned. A config of exactly CONFIG_MAX_BYTES setting hooks.context_warnings:false is
// honored (no spawn); one byte more is unreadable, so the default (warnings on) spawns it.
describe('#5759 plugin copies honor the shared config size cap', () => {
  const { CONFIG_MAX_BYTES } = require(path.join(LIB_DIR, 'config-file-read.cjs'));
  let root;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-5759-plug-')); });
  afterEach(() => { cleanup(root); });

  const DRIVE_SCRIPT = [
    '(async () => {',
    '  const m = require(process.argv[1]);',
    '  const cwd = process.argv[2];',
    '  const hooks = await m.server({ directory: cwd });',
    '  await hooks.event({ event: { type: "session.created", properties: { info: { id: "s1", directory: cwd } }, sessionID: "s1" } });',
    '  const call = { tool: "bash", args: { command: "ls" }, sessionID: "s1" };',
    '  try { await hooks["tool.execute.after"](call, { args: call.args, output: "", metadata: {} }); } catch (e) { /* only the spawn matters */ }',
    '  process.stdout.write("done");',
    '})();',
  ].join('\n');

  for (const plugin of ['.opencode', '.kilo']) {
    for (const [label, delta, spawned] of [['exactly the cap', 0, false], ['one byte over the cap', 1, true]]) {
      test(`${plugin} plugin: a config of ${label} ${spawned ? 'is unreadable (context monitor still runs)' : 'is honored (context monitor skipped)'}`, () => {
        // The plugin locates hooks/ and gsd-core/ by walking up from its own file.
        fs.mkdirSync(path.join(root, 'plugins'), { recursive: true });
        fs.mkdirSync(path.join(root, 'hooks'), { recursive: true });
        fs.mkdirSync(path.join(root, 'gsd-core'), { recursive: true });
        const copy = path.join(root, 'plugins', 'gsd-core.js');
        fs.copyFileSync(path.join(__dirname, '..', plugin, 'plugins', 'gsd-core.js'), copy);
        const marker = path.join(root, 'marker');
        fs.writeFileSync(
          path.join(root, 'hooks', 'gsd-context-monitor.js'),
          'require("node:fs").writeFileSync(process.env.GSD_5759_MARKER, "ran"); process.stdin.resume(); process.stdin.on("end", () => process.exit(0));',
        );
        const project = path.join(root, 'proj');
        fs.mkdirSync(path.join(project, '.planning'), { recursive: true });
        const body = JSON.stringify({ hooks: { context_warnings: false } });
        fs.writeFileSync(path.join(project, '.planning', 'config.json'), body + ' '.repeat(CONFIG_MAX_BYTES + delta - body.length));

        const r = runNode(['-e', DRIVE_SCRIPT, copy, project], {
          cwd: root,
          env: installSpawnEnv({ GSD_5759_MARKER: marker, CI: '' }),
          timeoutMs: PROBE_TIMEOUT_MS,
        });

        assertExitedByItself(r);
        assert.strictEqual(fs.existsSync(marker), spawned);
      });
    }
  }
});

describe('#5759 review round: temp-file modes without touching the process umask', { skip: SKIP_WIN32 }, () => {
  const { mock } = require('node:test');
  const { platformWriteSync } = require(SHELL_PROJECTION_PATH);
  let tmpDir;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-5759-mode-')); });
  afterEach(() => { mock.restoreAll(); cleanup(tmpDir); });

  function spyOpens() {
    const calls = [];
    const realOpen = fs.openSync;
    mock.method(fs, 'openSync', (p, flags, mode) => {
      calls.push({ p: String(p), flags, mode });
      return realOpen(p, flags, mode);
    });
    return calls;
  }

  test('platformWriteSync never calls process.umask() with no argument (it would zero the umask, DEP0139)', () => {
    const umaskCalls = [];
    const realUmask = process.umask;
    mock.method(process, 'umask', (...args) => { umaskCalls.push(args.length); return realUmask.apply(process, args); });
    platformWriteSync(path.join(tmpDir, 'fresh.json'), '{}\n');
    assert.deepStrictEqual(umaskCalls, []);
  });

  test('the temp file of an existing 0600 target is created with mode 0600; a new file with 0666', () => {
    const priv = path.join(tmpDir, 'private.json');
    fs.writeFileSync(priv, '{}');
    fs.chmodSync(priv, 0o600);
    const fresh = path.join(tmpDir, 'fresh.json');
    const calls = spyOpens();

    platformWriteSync(priv, '{"a":1}\n');
    platformWriteSync(fresh, '{"a":1}\n');

    const tmpFor = (target) => calls.filter((c) => c.p.startsWith(`${target}.tmp.`));
    assert.strictEqual(tmpFor(priv).length, 1);
    assert.strictEqual(tmpFor(fresh).length, 1);
    if (process.platform !== 'win32') {
      assert.strictEqual(tmpFor(priv)[0].mode, 0o600);
      assert.strictEqual(tmpFor(fresh)[0].mode, 0o666);
      assert.strictEqual(fs.statSync(priv).mode & 0o777, 0o600);
    }
  });

  test('a new file ends at 0666 narrowed by a umask read in a child process', () => {
    const script = [
      'const fs = require("node:fs");',
      'process.umask(0o027);',
      'require(process.argv[1]).platformWriteSync(process.argv[2], "x\\n");',
      'process.stdout.write((fs.statSync(process.argv[2]).mode & 0o777).toString(8));',
    ].join('\n');
    const r = runNode(['-e', script, SHELL_PROJECTION_PATH, path.join(tmpDir, 'child.json')], {
      cwd: tmpDir,
      env: installSpawnEnv({}),
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    assertExitedByItself(r);
    assert.strictEqual(r.stdout, (0o666 & ~0o027).toString(8));
  });
});

describe('#5759 review round: another process\'s descriptors and unresolvable directories are refused', { skip: SKIP_WIN32 }, () => {
  const { mock } = require('node:test');
  const { platformWriteSync } = require(SHELL_PROJECTION_PATH);
  let tmpDir;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-5759-pid-')); });
  afterEach(() => { mock.restoreAll(); cleanup(tmpDir); });

  const code = (fn) => { try { fn(); return 'ok'; } catch (e) { return e.code; } };

  test('/proc/<other pid>/fd/0-2 and /proc/<other pid>/task/<tid>/fd/1 are refused with ENXIO, flag or no flag', () => {
    const other = process.pid + 1;
    for (const target of [`/proc/${other}/fd/0`, `/proc/${other}/fd/1`, `/proc/${other}/fd/2`, `/proc/${other}/task/${other}/fd/1`, '/proc/1/fd/1']) {
      for (const opts of [{ allowSpecialTarget: true, verbatim: true }, { verbatim: true }]) {
        assert.strictEqual(code(() => platformWriteSync(target, 'x', opts)), 'ENXIO', `${target} ${JSON.stringify(opts)}`);
      }
    }
  });

  test('this process\'s own pid and thread-self spellings beyond fd 2 are still refused', () => {
    for (const target of [`/proc/${process.pid}/fd/7`, '/proc/thread-self/fd/7', '/proc/self/fd/3']) {
      assert.strictEqual(code(() => platformWriteSync(target, 'x', { allowSpecialTarget: true, verbatim: true })), 'ENXIO', target);
    }
  });

  test('a relative symlink whose holding directory cannot be resolved is refused with ENXIO', () => {
    const target = path.join(tmpDir, 'target.txt');
    fs.writeFileSync(target, 'UNCHANGED');
    const link = path.join(tmpDir, 'link.txt');
    fs.symlinkSync('target.txt', link);
    mock.method(fs.realpathSync, 'native', () => { throw Object.assign(new Error('gone'), { code: 'ENOENT' }); });

    assert.strictEqual(code(() => platformWriteSync(link, 'x', { verbatim: true })), 'ENXIO');
    assert.strictEqual(fs.readFileSync(target, 'utf8'), 'UNCHANGED');
  });

  test('allowSpecialTarget on an existing target whose directory cannot be resolved is refused with ENXIO', () => {
    const target = path.join(tmpDir, 'plain.txt');
    fs.writeFileSync(target, 'UNCHANGED');
    mock.method(fs.realpathSync, 'native', () => { throw Object.assign(new Error('gone'), { code: 'ENOENT' }); });

    assert.strictEqual(code(() => platformWriteSync(target, 'x', { allowSpecialTarget: true, verbatim: true })), 'ENXIO');
    assert.strictEqual(fs.readFileSync(target, 'utf8'), 'UNCHANGED');
  });

  test('a link whose target merely spells /dev/fd/5 after a non-directory is classified physically, not refused lexically', () => {
    const link = path.join(tmpDir, 'odd.txt');
    fs.symlinkSync('/dev/null/../fd/5', link);

    // realpath(3) is platform-dependent here: Linux fails ENOTDIR on `/dev/null/..` (the spelling
    // is not an alias, so the write proceeds); macOS resolves it to /dev/fd, so the link IS the
    // descriptor alias /dev/fd/5 and must be refused. Classification follows the OS answer.
    let physicalDir = null;
    try { physicalDir = fs.realpathSync.native('/dev/null/../fd'); } catch { /* unresolvable: not an alias */ }
    const outcome = code(() => platformWriteSync(link, 'x', { verbatim: true }));
    if (physicalDir === '/dev/fd') {
      assert.strictEqual(outcome, 'ENXIO');
    } else {
      assert.notStrictEqual(outcome, 'ENXIO');
    }
  });

  test('a plain path to a file this process holds open is still written (no descriptor-alias false positive)', () => {
    const file = path.join(tmpDir, 'held.txt');
    fs.writeFileSync(file, 'old');
    const held = fs.openSync(file, fs.constants.O_RDWR);
    try {
      assert.ok(held > 2);
      platformWriteSync(file, 'new', { verbatim: true });
      assert.strictEqual(fs.readFileSync(file, 'utf8'), 'new');
    } finally {
      fs.closeSync(held);
    }
  });

  test('the same plain path is still written when the temp create fails and the DIRECT write runs', () => {
    const file = path.join(tmpDir, 'held-direct.txt');
    fs.writeFileSync(file, 'old');
    const held = fs.openSync(file, fs.constants.O_RDWR);
    let tempAttempts = 0;
    try {
      assert.ok(held > 2);
      platformWriteSync(file, 'new', {
        verbatim: true,
        writeSeams: {
          createTemp: () => { tempAttempts += 1; throw Object.assign(new Error('EACCES: denied'), { code: 'EACCES' }); },
        },
      });
      assert.strictEqual(tempAttempts, 1, 'the temp create was refused, so the direct path ran');
      assert.strictEqual(fs.readFileSync(file, 'utf8'), 'new');
    } finally {
      fs.closeSync(held);
    }
  });
});

describe('#5759 review round 15: the direct write is tied to the identity the path walk approved', { skip: SKIP_WIN32 }, () => {
  const { mock } = require('node:test');
  const { platformWriteSync } = require(SHELL_PROJECTION_PATH);
  let tmpDir;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-5759-walk-')); });
  afterEach(() => { mock.restoreAll(); cleanup(tmpDir); });

  const code = (fn) => { try { fn(); return 'ok'; } catch (e) { return e.code; } };
  const deniedTemp = () => { throw Object.assign(new Error('EACCES: denied'), { code: 'EACCES' }); };

  // After the path walk approved `<dir>/<N>`, an attacker owning the parent swaps it for a
  // symlink to /dev/fd. The temp create inside it fails, so the direct write runs and both its
  // probe and its write open reopen fd N's regular file: dev/ino agree with each other, but not
  // with what the walk approved.
  for (const [label, seedDecoy] of [['an absent target', false], ['a different regular file', true]]) {
    test(`a parent swapped for a symlink to /dev/fd after the walk saw ${label} is refused and the victim is untouched`, () => {
      const victim = path.join(tmpDir, 'victim.txt');
      fs.writeFileSync(victim, 'VICTIM');
      const held = fs.openSync(victim, fs.constants.O_RDWR);
      try {
        assert.ok(held > 2);
        const dir = path.join(tmpDir, 'd');
        fs.mkdirSync(dir);
        const target = path.join(dir, String(held));
        if (seedDecoy) fs.writeFileSync(target, 'DECOY');

        const result = code(() => platformWriteSync(target, 'PWNED', {
          verbatim: true,
          writeSeams: {
            afterPathWalk: () => { fs.renameSync(dir, `${dir}.moved`); fs.symlinkSync('/dev/fd', dir); },
            createTemp: deniedTemp,
          },
        }));

        assert.strictEqual(result, 'ENXIO');
        assert.strictEqual(fs.readFileSync(victim, 'utf8'), 'VICTIM');
        if (seedDecoy) assert.strictEqual(fs.readFileSync(`${dir}.moved/${held}`, 'utf8'), 'DECOY');
      } finally {
        fs.closeSync(held);
      }
    });
  }

  test('a target replaced by a different file after the walk approved it is refused, not truncated', () => {
    const target = path.join(tmpDir, 'swap.txt');
    const other = path.join(tmpDir, 'other.txt');
    fs.writeFileSync(target, 'APPROVED');
    fs.writeFileSync(other, 'OTHER');

    const result = code(() => platformWriteSync(target, 'PWNED', {
      verbatim: true,
      writeSeams: {
        afterPathWalk: () => { fs.renameSync(other, target); },
        createTemp: deniedTemp,
      },
    }));

    assert.strictEqual(result, 'ENXIO');
    assert.strictEqual(fs.readFileSync(target, 'utf8'), 'OTHER');
  });

  test('a target that appears after the walk saw none is refused, not truncated', () => {
    const target = path.join(tmpDir, 'appears.txt');

    const result = code(() => platformWriteSync(target, 'PWNED', {
      verbatim: true,
      writeSeams: {
        afterPathWalk: () => { fs.writeFileSync(target, 'APPEARED'); },
        createTemp: deniedTemp,
      },
    }));

    assert.strictEqual(result, 'ENXIO');
    assert.strictEqual(fs.readFileSync(target, 'utf8'), 'APPEARED');
  });

  for (const errCode of ['EACCES', 'ELOOP', 'ENAMETOOLONG']) {
    test(`a parent whose resolution fails with ${errCode} is refused with ENXIO and nothing is created`, () => {
      const target = path.join(tmpDir, 'new.txt');
      mock.method(fs.realpathSync, 'native', () => { throw Object.assign(new Error(errCode), { code: errCode }); });

      assert.strictEqual(code(() => platformWriteSync(target, 'x', { verbatim: true })), 'ENXIO');

      mock.restoreAll();
      assert.strictEqual(fs.existsSync(target), false);
    });
  }

  test('a parent that is a symlink loop is refused with ENXIO', () => {
    fs.symlinkSync('loop', path.join(tmpDir, 'loop'));

    assert.strictEqual(code(() => platformWriteSync(path.join(tmpDir, 'loop', 'x.txt'), 'x', { verbatim: true })), 'ENXIO');
  });

  test('a link whose holding directory fails to resolve with EACCES is refused with ENXIO', () => {
    const target = path.join(tmpDir, 'target.txt');
    fs.writeFileSync(target, 'UNCHANGED');
    const link = path.join(tmpDir, 'link.txt');
    fs.symlinkSync('target.txt', link);
    let calls = 0;
    const real = fs.realpathSync.native;
    mock.method(fs.realpathSync, 'native', (p, ...rest) => {
      calls += 1;
      if (calls >= 2) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      return real(p, ...rest);
    });

    assert.strictEqual(code(() => platformWriteSync(link, 'x', { verbatim: true })), 'ENXIO');
    mock.restoreAll();
    assert.strictEqual(fs.readFileSync(target, 'utf8'), 'UNCHANGED');
  });
});

describe('#5759 the walked parent is re-checked on every direct fallback, and a failed write unlinks only its own file', { skip: SKIP_WIN32 }, () => {
  const { mock } = require('node:test');
  const { platformWriteSync } = require(SHELL_PROJECTION_PATH);
  let tmpDir;
  let parent;
  let evil;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-5759-parent-'));
    parent = path.join(tmpDir, 'p');
    evil = path.join(tmpDir, 'evil');
    fs.mkdirSync(parent);
    fs.mkdirSync(evil);
  });
  afterEach(() => { mock.restoreAll(); cleanup(tmpDir); });

  const code = (fn) => { try { fn(); return 'ok'; } catch (e) { return e.code; } };
  const swapParent = () => { fs.renameSync(parent, `${parent}.moved`); fs.symlinkSync(evil, parent); };

  test('the temp create fails after the parent was swapped: the direct fallback is refused, nothing lands in the other directory', () => {
    const result = code(() => platformWriteSync(path.join(parent, 'cfg.json'), 'SECRET', {
      verbatim: true,
      writeSeams: {
        createTemp: () => { swapParent(); throw Object.assign(new Error('EACCES: denied'), { code: 'EACCES' }); },
      },
    }));

    assert.strictEqual(result, 'ENXIO');
    assert.deepStrictEqual(fs.readdirSync(evil), []);
    assert.deepStrictEqual(fs.readdirSync(`${parent}.moved`), []);
  });

  test('a non-retryable rename error after the parent was swapped: the direct fallback is refused, nothing lands in the other directory', () => {
    const realRename = fs.renameSync;
    let swapped = false;
    mock.method(fs, 'renameSync', (from, to) => {
      if (!swapped && path.basename(String(to)) === 'cfg.json') {
        swapped = true;
        swapParent();
        throw Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' });
      }
      return realRename(from, to);
    });

    const result = code(() => platformWriteSync(path.join(parent, 'cfg.json'), 'SECRET', { verbatim: true }));
    mock.restoreAll();

    assert.strictEqual(swapped, true);
    assert.strictEqual(result, 'ENXIO');
    assert.deepStrictEqual(fs.readdirSync(evil), []);
  });

  test('the parent swapped between the symlink check and the open of the direct write: refused before the create', () => {
    const result = code(() => platformWriteSync(path.join(parent, 'cfg.json'), 'SECRET', {
      verbatim: true,
      writeSeams: {
        createTemp: () => { throw Object.assign(new Error('EACCES: denied'), { code: 'EACCES' }); },
        afterDirectLstat: swapParent,
      },
    }));

    assert.strictEqual(result, 'ENXIO');
    assert.deepStrictEqual(fs.readdirSync(evil), []);
  });

  test('a write that fails after the parent was swapped leaves a same-named file in the other directory alone', () => {
    const attackerFile = path.join(evil, 'cfg.json');
    fs.writeFileSync(attackerFile, 'ATTACKER');
    const realWrite = fs.writeFileSync;
    let failed = false;
    mock.method(fs, 'writeFileSync', (target, ...rest) => {
      if (!failed && typeof target === 'number') {
        failed = true;
        swapParent();
        throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
      }
      return realWrite(target, ...rest);
    });

    const result = code(() => platformWriteSync(path.join(parent, 'cfg.json'), 'SECRET', {
      verbatim: true,
      writeSeams: { createTemp: () => { throw Object.assign(new Error('EACCES: denied'), { code: 'EACCES' }); } },
    }));
    mock.restoreAll();

    assert.strictEqual(failed, true);
    assert.strictEqual(result, 'ENOSPC');
    assert.strictEqual(fs.readFileSync(attackerFile, 'utf8'), 'ATTACKER');
  });

  test('a write that fails with the parent unchanged still removes the file it created', () => {
    const realWrite = fs.writeFileSync;
    let failed = false;
    mock.method(fs, 'writeFileSync', (target, ...rest) => {
      if (!failed && typeof target === 'number') {
        failed = true;
        throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
      }
      return realWrite(target, ...rest);
    });

    const result = code(() => platformWriteSync(path.join(parent, 'cfg.json'), 'SECRET', {
      verbatim: true,
      writeSeams: { createTemp: () => { throw Object.assign(new Error('EACCES: denied'), { code: 'EACCES' }); } },
    }));
    mock.restoreAll();

    assert.strictEqual(result, 'ENOSPC');
    assert.deepStrictEqual(fs.readdirSync(parent), []);
  });
});

// Runs on every platform, win32 included: the walk's {dev, ino} tie must not break a legitimate write.
describe('#5759 legitimate writes pass the walk identity tie on every platform', () => {
  const { platformWriteSync } = require(SHELL_PROJECTION_PATH);
  let tmpDir;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-5759-legit-')); });
  afterEach(() => { cleanup(tmpDir); });

  const deniedTemp = () => { throw Object.assign(new Error('EACCES: denied'), { code: 'EACCES' }); };

  test('an unchanged target is still written directly when the temp create fails', () => {
    const target = path.join(tmpDir, 'plain.txt');
    fs.writeFileSync(target, 'old');

    platformWriteSync(target, 'new', { verbatim: true, writeSeams: { createTemp: deniedTemp } });

    assert.strictEqual(fs.readFileSync(target, 'utf8'), 'new');
  });

  test('an absent target is created directly when the temp create fails', () => {
    const target = path.join(tmpDir, 'absent.txt');

    platformWriteSync(target, 'fresh', { verbatim: true, writeSeams: { createTemp: deniedTemp } });

    assert.strictEqual(fs.readFileSync(target, 'utf8'), 'fresh');
  });

  test('an existing target is replaced by the atomic path', () => {
    const target = path.join(tmpDir, 'atomic.txt');
    fs.writeFileSync(target, 'old');

    platformWriteSync(target, 'new', { verbatim: true });

    assert.strictEqual(fs.readFileSync(target, 'utf8'), 'new');
  });

  test('a parent directory that does not exist yet is still created and written', () => {
    const target = path.join(tmpDir, 'a', 'b', 'new.txt');

    platformWriteSync(target, 'fresh', { verbatim: true });

    assert.strictEqual(fs.readFileSync(target, 'utf8'), 'fresh');
  });
});

describe('#5759 a symlinked target is replaced on the atomic path and refused on the direct path', {
  skip: process.platform === 'win32' ? 'symlinks need privileges on Windows' : false,
}, () => {
  const { platformWriteSync } = require(SHELL_PROJECTION_PATH);
  let tmpDir;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-5759-link-')); });
  afterEach(() => { cleanup(tmpDir); });

  const deniedTemp = () => { throw Object.assign(new Error('EACCES: denied'), { code: 'EACCES' }); };
  const direct = { writeSeams: { createTemp: deniedTemp } };

  // Each fixture: [label, build() -> { entry, real, links }]
  const fixtures = [
    ['same-directory link', () => {
      const real = path.join(tmpDir, 'real.txt');
      const entry = path.join(tmpDir, 'link.txt');
      fs.writeFileSync(real, 'old');
      fs.symlinkSync('real.txt', entry);
      return { entry, real, links: { [entry]: 'real.txt' } };
    }],
    ['link to a file in another directory', () => {
      const otherDir = path.join(tmpDir, 'elsewhere');
      fs.mkdirSync(otherDir);
      const real = path.join(otherDir, 'real.txt');
      const entry = path.join(tmpDir, 'link.txt');
      fs.writeFileSync(real, 'old');
      fs.symlinkSync(real, entry);
      return { entry, real, links: { [entry]: real } };
    }],
    ['chained links', () => {
      const real = path.join(tmpDir, 'real.txt');
      const mid = path.join(tmpDir, 'mid.txt');
      const entry = path.join(tmpDir, 'top.txt');
      fs.writeFileSync(real, 'old');
      fs.symlinkSync('real.txt', mid);
      fs.symlinkSync('mid.txt', entry);
      return { entry, real, links: { [entry]: 'mid.txt', [mid]: 'real.txt' } };
    }],
  ];

  for (const [label, build] of fixtures) {
    test(`${label}: the atomic path replaces the link entry and leaves the real file untouched`, () => {
      const { entry, real, links } = build();

      platformWriteSync(entry, 'new', { verbatim: true });

      const st = fs.lstatSync(entry);
      assert.strictEqual(st.isSymbolicLink(), false, 'the link entry is replaced');
      assert.ok(st.isFile());
      assert.strictEqual(fs.readFileSync(entry, 'utf8'), 'new');
      assert.strictEqual(fs.readFileSync(real, 'utf8'), 'old', 'the file the link pointed at is never modified');
      for (const [other, dest] of Object.entries(links)) {
        if (other !== entry) assert.strictEqual(fs.readlinkSync(other), dest, 'intermediate links are untouched');
      }
    });

    test(`${label}: the forced direct path refuses, leaving the real file and the link untouched`, () => {
      const { entry, real, links } = build();

      let err;
      try { platformWriteSync(entry, 'PWNED', { verbatim: true, ...direct }); } catch (e) { err = e; }

      assert.ok(err, 'the write is refused');
      assert.strictEqual(err.code, 'ENXIO');
      assert.match(err.message, /symlinked target cannot be replaced atomically/);
      assert.strictEqual(fs.readFileSync(real, 'utf8'), 'old');
      assert.strictEqual(fs.readlinkSync(entry), links[entry]);
    });
  }
});

describe('#5759 review round: direct-path O_NOFOLLOW, multiply-linked targets, parent identity, walk refusals', {
  skip: process.platform === 'win32' ? 'symlinks and hard links need privileges on Windows' : false,
}, () => {
  const { mock } = require('node:test');
  const { platformWriteSync } = require(SHELL_PROJECTION_PATH);
  let tmpDir;
  beforeEach(() => { tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-5759-nofollow-'))); });
  afterEach(() => { mock.restoreAll(); cleanup(tmpDir); });

  const deniedTemp = () => { throw Object.assign(new Error('EACCES: denied'), { code: 'EACCES' }); };
  const attempt = (fn) => { try { fn(); return null; } catch (e) { return e; } };
  const at = (name) => path.join(tmpDir, name);

  test('a link swapped in right after the direct path lstat is not opened: ENXIO, the real file untouched', () => {
    const real = at('real.txt');
    const entry = at('entry.txt');
    fs.writeFileSync(entry, 'old');

    const err = attempt(() => platformWriteSync(entry, 'PWNED', {
      verbatim: true,
      writeSeams: {
        createTemp: deniedTemp,
        afterDirectLstat: () => { fs.renameSync(entry, real); fs.symlinkSync(real, entry); },
      },
    }));

    assert.ok(err, 'the write is refused');
    assert.strictEqual(err.code, 'ENXIO');
    assert.match(err.message, /symlinked target cannot be replaced atomically/);
    assert.strictEqual(fs.readFileSync(real, 'utf8'), 'old');
  });

  test('a parent swapped after the temp create is refused by the pre-rename check: ENXIO, nothing lands in the attacker directory', () => {
    const dir = at('d');
    const attacker = at('attacker');
    fs.mkdirSync(dir);
    fs.mkdirSync(attacker);
    fs.writeFileSync(path.join(dir, 'f'), 'old');

    const createThenSwap = (basePath, _suffix, mode) => {
      const tmpPath = `${basePath}.tmp.seam`;
      const fd = fs.openSync(tmpPath, 'wx', mode);
      fs.renameSync(dir, `${dir}.moved`);
      fs.symlinkSync(attacker, dir);
      return { fd, tmpPath };
    };
    const err = attempt(() => platformWriteSync(path.join(dir, 'f'), 'PWNED', {
      verbatim: true,
      writeSeams: { createTemp: createThenSwap },
    }));

    assert.ok(err, 'the write is refused');
    assert.strictEqual(err.code, 'ENXIO');
    assert.match(err.message, /its directory is not the one the path check approved/);
    assert.deepStrictEqual(fs.readdirSync(attacker), [], 'no target file lands in the attacker directory');
    assert.strictEqual(fs.readFileSync(path.join(`${dir}.moved`, 'f'), 'utf8'), 'old', 'the original target is untouched');
  });

  test('a hard link added after the probe is caught by the post-open check: ENXIO, the other name untouched', () => {
    const target = at('target.txt');
    const alias = at('alias.txt');
    fs.writeFileSync(target, 'SECRET');
    const realOpen = fs.openSync;
    mock.method(fs, 'openSync', (p, flags, ...rest) => {
      if (p === target && typeof flags === 'number' && (flags & 3) === fs.constants.O_WRONLY) fs.linkSync(target, alias);
      return realOpen(p, flags, ...rest);
    });

    const err = attempt(() => platformWriteSync(target, 'PWNED', { verbatim: true, writeSeams: { createTemp: deniedTemp } }));

    assert.ok(err, 'the write is refused');
    assert.strictEqual(err.code, 'ENXIO');
    assert.match(err.message, /multiply-linked target cannot be replaced atomically/);
    assert.strictEqual(fs.readFileSync(alias, 'utf8'), 'SECRET');
    assert.strictEqual(fs.readFileSync(target, 'utf8'), 'SECRET');
  });

  test('the direct path refuses a hard link to a sensitive file and leaves it untouched', () => {
    const secret = at('secret.txt');
    const target = at('target.txt');
    fs.writeFileSync(secret, 'SECRET');
    fs.linkSync(secret, target);

    const err = attempt(() => platformWriteSync(target, 'PWNED', { verbatim: true, writeSeams: { createTemp: deniedTemp } }));

    assert.ok(err, 'the write is refused');
    assert.strictEqual(err.code, 'ENXIO');
    assert.match(err.message, /multiply-linked target cannot be replaced atomically/);
    assert.strictEqual(fs.readFileSync(secret, 'utf8'), 'SECRET');
    assert.strictEqual(fs.readFileSync(target, 'utf8'), 'SECRET');
  });

  test('control: the atomic path still replaces a multiply-linked entry and leaves the other name intact', () => {
    const secret = at('secret.txt');
    const target = at('target.txt');
    fs.writeFileSync(secret, 'SECRET');
    fs.linkSync(secret, target);

    platformWriteSync(target, 'NEW', { verbatim: true });

    assert.strictEqual(fs.readFileSync(target, 'utf8'), 'NEW');
    assert.strictEqual(fs.readFileSync(secret, 'utf8'), 'SECRET');
    assert.strictEqual(fs.statSync(target).nlink, 1);
  });

  test('a parent directory swapped for a symlink to a victim directory after the walk is refused; nothing lands in either directory', () => {
    const dir = at('d');
    const victim = at('victim');
    fs.mkdirSync(dir);
    fs.mkdirSync(victim);
    fs.writeFileSync(path.join(dir, 'f'), 'old');
    fs.writeFileSync(path.join(victim, 'f'), 'VICTIM');

    const err = attempt(() => platformWriteSync(path.join(dir, 'f'), 'PWNED', {
      verbatim: true,
      writeSeams: { afterPathWalk: () => { fs.renameSync(dir, `${dir}.moved`); fs.symlinkSync(victim, dir); } },
    }));

    assert.ok(err, 'the write is refused');
    assert.strictEqual(err.code, 'ENXIO');
    assert.strictEqual(fs.readFileSync(path.join(victim, 'f'), 'utf8'), 'VICTIM');
    assert.deepStrictEqual(fs.readdirSync(victim), ['f'], 'no temp file left in the victim directory');
    assert.deepStrictEqual(fs.readdirSync(`${dir}.moved`), ['f'], 'no temp file left in the original directory');
  });

  test('atomic: a parent directory swapped for a symlink after the walk is refused; the attacker directory is untouched', () => {
    const dir = at('d');
    const victim = at('victim');
    fs.mkdirSync(dir);
    fs.mkdirSync(victim);
    fs.writeFileSync(path.join(dir, 'f'), 'old');
    fs.writeFileSync(path.join(victim, 'f'), 'VICTIM');

    const err = attempt(() => platformWriteSync(path.join(dir, 'f'), 'PWNED', {
      verbatim: true,
      atomic: true,
      writeSeams: { afterPathWalk: () => { fs.renameSync(dir, `${dir}.moved`); fs.symlinkSync(victim, dir); } },
    }));

    assert.ok(err, 'the write is refused');
    assert.strictEqual(err.code, 'ENXIO');
    assert.strictEqual(fs.readFileSync(path.join(victim, 'f'), 'utf8'), 'VICTIM');
    assert.deepStrictEqual(fs.readdirSync(victim), ['f'], 'no temp file in the attacker directory');
    assert.strictEqual(fs.readFileSync(path.join(`${dir}.moved`, 'f'), 'utf8'), 'old', 'nothing was published');
  });

  test('atomic: a parent swapped between the temp create and the rename is refused with ENXIO; nothing lands in the attacker directory and the temp may be orphaned in the original directory', () => {
    const dir = at('d');
    const victim = at('victim');
    fs.mkdirSync(dir);
    fs.mkdirSync(victim);
    fs.writeFileSync(path.join(dir, 'f'), 'old');
    fs.writeFileSync(path.join(victim, 'f'), 'VICTIM');
    const { openExclusiveTempSync } = require(SHELL_PROJECTION_PATH);

    const err = attempt(() => platformWriteSync(path.join(dir, 'f'), 'PWNED', {
      verbatim: true,
      atomic: true,
      writeSeams: {
        createTemp: (base, suffix, mode) => {
          const made = openExclusiveTempSync(base, suffix, mode);
          fs.renameSync(dir, `${dir}.moved`);
          fs.symlinkSync(victim, dir);
          return made;
        },
      },
    }));

    assert.ok(err, 'the write is refused');
    assert.strictEqual(err.code, 'ENXIO');
    assert.deepStrictEqual(fs.readdirSync(victim), ['f'], 'nothing lands in the attacker directory');
    assert.strictEqual(fs.readFileSync(path.join(victim, 'f'), 'utf8'), 'VICTIM');
    // Documented residual: the cleanup unlink resolves through the swapped parent, so this
    // write's temp may stay in the original (moved) directory. It is never another file.
    const leftovers = fs.readdirSync(`${dir}.moved`).filter((n) => n !== 'f');
    for (const n of leftovers) {
      assert.match(n, /^f\..+\.\d+\..+$/, 'only this write\'s temp may remain in the original directory');
    }
    assert.strictEqual(fs.readFileSync(path.join(`${dir}.moved`, 'f'), 'utf8'), 'old', 'the target was not published');
  });

  test('a symbolic link that cannot be read is refused with ENXIO', () => {
    const entry = at('link.txt');
    fs.writeFileSync(at('real.txt'), 'old');
    fs.symlinkSync('real.txt', entry);
    const realReadlink = fs.readlinkSync;
    mock.method(fs, 'readlinkSync', (p, ...rest) => {
      if (p === entry) throw Object.assign(new Error('EIO'), { code: 'EIO' });
      return realReadlink(p, ...rest);
    });

    const err = attempt(() => platformWriteSync(entry, 'x', { verbatim: true }));

    assert.ok(err, 'the write is refused');
    assert.strictEqual(err.code, 'ENXIO');
    assert.match(err.message, /a symbolic link on its path cannot be read \(EIO\)/);
    assert.strictEqual(fs.readFileSync(at('real.txt'), 'utf8'), 'old');
  });

  test('a final target that cannot be inspected is refused with ENXIO', () => {
    const entry = at('plain.txt');
    fs.writeFileSync(entry, 'old');
    const realLstat = fs.lstatSync;
    let seen = 0;
    mock.method(fs, 'lstatSync', (p, ...rest) => {
      if (p === entry && ++seen === 2) throw Object.assign(new Error('EIO'), { code: 'EIO' });
      return realLstat(p, ...rest);
    });

    const err = attempt(() => platformWriteSync(entry, 'x', { verbatim: true }));

    assert.ok(err, 'the write is refused');
    assert.strictEqual(err.code, 'ENXIO');
    assert.match(err.message, /the target cannot be inspected \(EIO\)/);
    assert.strictEqual(fs.readFileSync(entry, 'utf8'), 'old');
  });

  test('a circular link chain is refused with ENXIO', () => {
    const a = at('a.txt');
    const b = at('b.txt');
    fs.symlinkSync('b.txt', a);
    fs.symlinkSync('a.txt', b);

    const err = attempt(() => platformWriteSync(a, 'x', { verbatim: true }));

    assert.ok(err, 'the write is refused');
    assert.strictEqual(err.code, 'ENXIO');
    assert.match(err.message, /circular or longer than 40 links/);
  });
});

describe('#5759 review round: printablePath escapes every format, separator and surrogate character', () => {
  const { printablePath } = require(path.join(LIB_DIR, 'config-file-read.cjs'));

  const CASES = [
    [0x061c, '\\u061c'], [0xfeff, '\\ufeff'], [0x00ad, '\\u00ad'], [0x180e, '\\u180e'],
    [0x206a, '\\u206a'], [0xfff9, '\\ufff9'], [0xe0001, '\\u{e0001}'],
  ];
  for (const [cp, expected] of CASES) {
    test(`U+${cp.toString(16)} becomes ${expected}`, () => {
      assert.strictEqual(printablePath(`a${String.fromCodePoint(cp)}b`), `a${expected}b`);
    });
  }

  test('a lone surrogate is escaped, a paired one is left alone', () => {
    assert.strictEqual(printablePath(`a${String.fromCharCode(0xd800)}b`), 'a\\ud800b');
    assert.strictEqual(printablePath(`a${String.fromCharCode(0xdc00)}b`), 'a\\udc00b');
    const pair = String.fromCodePoint(0x1f600);
    assert.strictEqual(printablePath(`a${pair}b`), `a${pair}b`);
  });

  test('ordinary non-ASCII is unchanged', () => {
    const word = `caf${String.fromCharCode(0xe9)}`;
    assert.strictEqual(printablePath(word), word);
  });
});

describe('#5759 review round: every bounded reader and special-target writer opens with O_NOCTTY', () => {
  const { mock } = require('node:test');
  const noctty = fs.constants.O_NOCTTY || 0;
  const READ_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0) | noctty;
  let tmpDir;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-5759-ctty-')); });
  afterEach(() => { mock.restoreAll(); cleanup(tmpDir); });

  function spyOpens() {
    const calls = [];
    const realOpen = fs.openSync;
    mock.method(fs, 'openSync', (p, flags, ...rest) => {
      calls.push({ p: String(p), flags });
      return realOpen(p, flags, ...rest);
    });
    return calls;
  }
  const flagsFor = (calls, file) => calls.filter((c) => c.p === file).map((c) => c.flags);

  const READERS = {
    'src/config-file-read (readConfigFileBounded)': (file) => require(path.join(LIB_DIR, 'config-file-read.cjs')).readConfigFileBounded(file),
    'src/capability-ledger (readSmallRegularFile)': (file) => require(path.join(LIB_DIR, 'capability-ledger.cjs')).readSmallRegularFile(file, 1024),
    'src/capability-ledger (readSmallRegularFileBuffer)': (file) => require(path.join(LIB_DIR, 'capability-ledger.cjs')).readSmallRegularFileBuffer(file, 1024),
    'src/configuration (migrateOnDisk)': (file) => require(path.join(LIB_DIR, 'configuration.cjs')).migrateOnDisk(tmpDir, undefined, file),
    'hooks/lib/config-read': (file) => require(path.join(__dirname, '..', 'hooks', 'lib', 'config-read.js')).readConfigFileBounded(file),
  };

  for (const [label, read] of Object.entries(READERS)) {
    test(`${label} opens with O_RDONLY | O_NONBLOCK | O_NOCTTY`, () => {
      const file = path.join(tmpDir, 'config.json');
      fs.writeFileSync(file, '{}');
      const calls = spyOpens();

      read(file);

      const flags = flagsFor(calls, file);
      assert.ok(flags.length >= 1, 'the reader opened the file');
      for (const f of flags) assert.strictEqual(f, READ_FLAGS);
    });
  }

  test('hooks/gsd-statusline settings reader opens with the same flag set', () => {
    const settings = path.join(tmpDir, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    fs.writeFileSync(settings, '{}');
    const calls = spyOpens();

    require(path.join(__dirname, '..', 'hooks', 'gsd-statusline.js')).isAutoCompactDisabled(tmpDir, {});

    const flags = flagsFor(calls, settings);
    assert.ok(flags.length >= 1, 'the settings file was opened');
    for (const f of flags) assert.strictEqual(f, READ_FLAGS);
  });

  for (const plugin of ['.opencode', '.kilo']) {
    test(`${plugin} plugin config reader opens with the same flag set`, async () => {
      const root = path.join(tmpDir, plugin.slice(1));
      fs.mkdirSync(path.join(root, 'plugins'), { recursive: true });
      fs.mkdirSync(path.join(root, 'hooks'), { recursive: true });
      fs.mkdirSync(path.join(root, 'gsd-core'), { recursive: true });
      const copy = path.join(root, 'plugins', 'gsd-core.js');
      fs.copyFileSync(path.join(__dirname, '..', plugin, 'plugins', 'gsd-core.js'), copy);
      const project = path.join(root, 'proj');
      fs.mkdirSync(path.join(project, '.planning'), { recursive: true });
      const config = path.join(project, '.planning', 'config.json');
      fs.writeFileSync(config, JSON.stringify({ hooks: { context_warnings: false } }));
      const calls = spyOpens();

      const hooks = await require(copy).server({ directory: project });
      // The Kilo plugin reads the config only for a tracked session (contextWarningsDisabled is gated on
      // currentSessionId); the OpenCode plugin also reads it for its community-hook gates.
      await hooks.event({ event: { type: 'session.created', properties: { info: { id: 's1', directory: project } } } });
      const call = { tool: 'bash', args: { command: 'ls' }, sessionID: 's1' };
      try { await hooks['tool.execute.after'](call, { args: call.args, output: '', metadata: {} }); } catch { /* only the open matters */ }

      const flags = calls.filter((c) => c.p.endsWith(path.join('.planning', 'config.json'))).map((c) => c.flags);
      assert.ok(flags.length >= 1, 'the plugin opened the config');
      for (const f of flags) assert.strictEqual(f, READ_FLAGS);
    });
  }

  test('the prior-Markdown read of platformWriteSync opens with O_NOCTTY', {
    skip: process.platform === 'win32' ? 'O_NOCTTY is not defined on Windows, so the assertion is vacuous there' : false,
  }, () => {
    const { platformWriteSync } = require(SHELL_PROJECTION_PATH);
    const file = path.join(tmpDir, 'doc.md');
    fs.writeFileSync(file, '# old\n');
    const calls = spyOpens();

    platformWriteSync(file, '# new\n');

    const flags = flagsFor(calls, file);
    assert.ok(flags.length >= 1, 'the prior document was opened');
    for (const f of flags) assert.strictEqual(f & noctty, noctty);
  });

  test('the special-target writers open a character device and a FIFO with O_NOCTTY', { skip: SKIP_WIN32 }, () => {
    const { platformWriteSync } = require(SHELL_PROJECTION_PATH);
    const fifo = path.join(tmpDir, 'out.fifo');
    makeFifo(fifo);
    const reader = fs.openSync(fifo, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    const calls = spyOpens();
    try {
      platformWriteSync('/dev/null', 'x', { allowSpecialTarget: true, verbatim: true });
      platformWriteSync(fifo, 'x', { allowSpecialTarget: true, verbatim: true });
    } finally {
      fs.closeSync(reader);
    }

    for (const target of ['/dev/null', fifo]) {
      const writes = calls.filter((c) => c.p === target && (c.flags & 3) === fs.constants.O_WRONLY);
      assert.ok(writes.length >= 1, `${target} was opened for write`);
      for (const w of writes) assert.strictEqual(w.flags & noctty, noctty, target);
    }
  });
});

// Windows only: NUL is a character device and is written in place (no temp file beside it).
describe('#5759 allowSpecialTarget on Windows device names', {
  skip: process.platform === 'win32' ? false : 'NUL and CON exist only on Windows',
}, () => {
  test('platformWriteSync("NUL", ..., { allowSpecialTarget: true }) succeeds and leaves no temp file', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-5759-nul-'));
    try {
      const script = [
        'try { require(process.argv[1]).platformWriteSync("NUL", "hello\\n", { allowSpecialTarget: true }); process.stdout.write("ok"); }',
        'catch (e) { process.stdout.write(String(e.code)); }',
      ].join('\n');
      const r = runNode(['-e', script, SHELL_PROJECTION_PATH], {
        cwd, env: installSpawnEnv({}), timeoutMs: PROBE_TIMEOUT_MS,
      });

      assertExitedByItself(r);
      assert.strictEqual(r.stdout, 'ok');
      assert.deepStrictEqual(fs.readdirSync(cwd), []);
    } finally { cleanup(cwd); }
  });

  // Windows 11 24H2 / Server 2025 changed path normalization: a reserved name INSIDE a directory
  // path (`cwd\NUL`) is an ordinary file there, and a device on older Windows. Only the bare name
  // and the \\.\ namespace form are devices on both, so the assertions below pin only those; the
  // absolute `cwd\NUL` form must succeed and is deliberately not asserted to leave no file.
  test('the \\\\.\\NUL namespace form is a device on every Windows and leaves no file', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-5759-nulns-'));
    try {
      const script = [
        'try { require(process.argv[1]).platformWriteSync("\\\\\\\\.\\\\nul", "hello\\n", { allowSpecialTarget: true }); process.stdout.write("ok"); }',
        'catch (e) { process.stdout.write(String(e.code)); }',
      ].join('\n');
      const r = runNode(['-e', script, SHELL_PROJECTION_PATH], {
        cwd, env: installSpawnEnv({}), timeoutMs: PROBE_TIMEOUT_MS,
      });

      assertExitedByItself(r);
      assert.strictEqual(r.stdout, 'ok');
      assert.deepStrictEqual(fs.readdirSync(cwd), []);
    } finally { cleanup(cwd); }
  });

  test('the \\\\.\\NUL namespace form without allowSpecialTarget is refused', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-5759-nulref-'));
    try {
      const script = [
        'try { require(process.argv[1]).platformWriteSync("\\\\\\\\.\\\\nul", "hello\\n", {}); process.stdout.write("ok"); }',
        'catch (e) { process.stdout.write(String(e.code)); }',
      ].join('\n');
      const r = runNode(['-e', script, SHELL_PROJECTION_PATH], {
        cwd, env: installSpawnEnv({}), timeoutMs: PROBE_TIMEOUT_MS,
      });

      assertExitedByItself(r);
      assert.strictEqual(r.stdout, 'ENXIO');
    } finally { cleanup(cwd); }
  });

  test('an absolute cwd\\NUL path succeeds (device on older Windows, ordinary file on 24H2+)', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-5759-nulabs-'));
    try {
      const r = writeChild(cwd, path.join(cwd, 'NUL'));

      assertExitedByItself(r);
      assert.strictEqual(r.stdout, 'ok');
    } finally { cleanup(cwd); }
  });

  // `nul.txt` is not an exact reserved stem, so it is never routed to the device. Windows 11 treats
  // it as an ordinary creatable file (written, with the data); older Windows normalizes it to the
  // device (nothing is created). Both outcomes are accepted; the seam describe below pins that the
  // code itself never opens \\.\NUL for it.
  test('a nul.txt in the cwd is written as an ordinary file (Windows 11) or absorbed by the device (older Windows)', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-5759-nultxt-'));
    try {
      const r = writeChild(cwd, 'nul.txt');

      assertExitedByItself(r);
      assert.strictEqual(r.stdout, 'ok');
      const entries = fs.readdirSync(cwd);
      if (entries.length === 0) return;
      assert.deepStrictEqual(entries, ['nul.txt']);
      assert.strictEqual(fs.readFileSync(path.join(cwd, 'nul.txt'), 'utf-8'), 'x');
    } finally { cleanup(cwd); }
  });

  // On Windows 11 a reserved-looking name can be an ordinary file. The device branch must not
  // write into it in place: a partial overwrite would leave "xRIGINAL..." behind.
  const ORIGINAL = 'ORIGINAL-CONTENT-ORIGINAL-CONTENT';
  const writeChild = (cwd, target) => {
    const script = [
      'try { require(process.argv[1]).platformWriteSync(process.argv[2], "x", { allowSpecialTarget: true, verbatim: true }); process.stdout.write("ok"); }',
      'catch (e) { process.stdout.write(String(e.code)); }',
    ].join('\n');
    return runNode(['-e', script, SHELL_PROJECTION_PATH, target], {
      cwd, env: installSpawnEnv({}), timeoutMs: PROBE_TIMEOUT_MS,
    });
  };

  test('a regular file named con.txt is replaced whole by the checked path, never written in place', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-5759-con-'));
    try {
      const file = '\\\\?\\' + path.join(dir, 'con.txt');
      fs.writeFileSync(file, ORIGINAL);

      const r = writeChild(dir, file);

      assertExitedByItself(r);
      assert.strictEqual(r.stdout, 'ok');
      assert.strictEqual(fs.readFileSync(file, 'utf-8'), 'x');
      assert.deepStrictEqual(fs.readdirSync(dir), ['con.txt']);
    } finally { cleanup(dir); }
  });

  // On Windows 11 `\\?\dir\con.txt` is an ordinary name: open(O_WRONLY) without O_CREAT fails with
  // ENOENT, which must fall through to the checked path that creates the file.
  test('a not-yet-existing \\\\?\\ con.txt is created by the checked path', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-5759-concreate-'));
    try {
      const file = '\\\\?\\' + path.join(dir, 'con.txt');

      const r = writeChild(dir, file);

      assertExitedByItself(r);
      assert.strictEqual(r.stdout, 'ok');
      assert.strictEqual(fs.readFileSync(path.join(dir, 'con.txt'), 'utf-8'), 'x');
    } finally { cleanup(dir); }
  });

  test('a symlink with a reserved-looking name is not written through to a regular file', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-5759-conlink-'));
    try {
      const real = path.join(dir, 'real.txt');
      const link = path.join(dir, 'con.txt');
      fs.writeFileSync(real, ORIGINAL);
      try { fs.symlinkSync(real, link, 'file'); } catch (err) {
        if (err.code === 'EPERM') { t.skip('symlink creation needs privileges'); return; }
        throw err;
      }

      const r = writeChild(dir, '\\\\?\\' + link);

      assertExitedByItself(r);
      // The link is never opened by the device branch: the checked path publishes over the link
      // name, so the file it pointed at keeps its content and the link name holds the new bytes.
      assert.strictEqual(r.stdout, 'ok');
      assert.strictEqual(fs.readFileSync(real, 'utf-8'), ORIGINAL);
      assert.strictEqual(fs.lstatSync(link).isSymbolicLink(), false);
      assert.strictEqual(fs.readFileSync(link, 'utf-8'), 'x');
    } finally { cleanup(dir); }
  });
});

// Runs on every OS: the device branch is driven through the injected { platform, fs } seam.
describe('#5759 Windows device branch via the deviceSeams seam', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-5759-seam-')); });
  afterEach(() => { cleanup(dir); });

  const { platformWriteSync } = require(SHELL_PROJECTION_PATH);
  const errno = (code) => Object.assign(new Error(code), { code });
  // A scripted fs: records every call; `stat` is what fstat reports for the opened handle.
  // The device is opened through its device-namespace path (\\.\NAME), never through a resolved
  // directory path: on Windows 11 24H2 / Server 2025 a reserved name inside a directory path is an
  // ordinary file, so `D:\x\NUL` must take the checked path and `NUL` / `\\.\NUL` the device.
  const scripted = ({ openError = null, charDevice = false } = {}) => {
    const log = [];
    return {
      log,
      fs: {
        lstatSync: (p) => { log.push(['lstat', p]); throw errno('ENOENT'); },
        openSync: (p, flags) => { log.push(['open', p, flags]); if (openError) throw errno(openError); return 99; },
        fstatSync: (fd) => { log.push(['fstat', fd]); return { isCharacterDevice: () => charDevice }; },
        writeFileSync: (fd, data) => { log.push(['write', fd, data]); },
        closeSync: (fd) => { log.push(['close', fd]); },
      },
    };
  };
  const write = (file, seam, platform = 'win32', allowSpecialTarget = true) =>
    platformWriteSync(file, 'x', { allowSpecialTarget, verbatim: true, deviceSeams: { platform, fs: seam.fs } });
  const kinds = (seam) => seam.log.map((e) => e[0]);
  // A bare name is relative to the cwd, so the checked-path fall-through runs inside the temp dir.
  const inDir = (fn) => {
    const prev = process.cwd();
    process.chdir(dir);
    try { return fn(); } finally { process.chdir(prev); }
  };

  test('a character-device handle is opened as \\\\.\\CON, written in place and closed', () => {
    const seam = scripted({ charDevice: true });

    inDir(() => write('con', seam));

    assert.deepStrictEqual(kinds(seam), ['open', 'fstat', 'write', 'close']);
    assert.deepStrictEqual(seam.log[0], ['open', '\\\\.\\CON', fs.constants.O_WRONLY]);
    assert.deepStrictEqual(seam.log[2], ['write', 99, 'x']);
    assert.deepStrictEqual(fs.readdirSync(dir), []);
  });

  // The bare stem reaches the device branch; on a real Windows the checked-path fall-through for a
  // bare `con` would write to the real console device, so these rows run on POSIX/macOS only.
  const SKIP_REAL_RESERVED = process.platform === 'win32' ? 'a bare reserved stem reaches the real device on Windows' : false;

  test('a non-character-device handle is closed untouched and the checked path writes the file', { skip: SKIP_REAL_RESERVED }, () => {
    fs.writeFileSync(path.join(dir, 'con'), 'ORIGINAL');
    const seam = scripted({ charDevice: false });

    inDir(() => write('con', seam));

    assert.deepStrictEqual(kinds(seam), ['open', 'fstat', 'close']);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'con'), 'utf-8'), 'x');
  });

  // Routing: which spellings reach the device open, and with which device-namespace path.
  const DEVICE_ROWS = [
    ['NUL', '\\\\.\\NUL'],
    ['nul', '\\\\.\\NUL'],
    ['.\\NUL', '\\\\.\\NUL'],
    ['./NUL', '\\\\.\\NUL'],
    ['\\\\.\\nul', '\\\\.\\NUL'],
    ['\\\\?\\NUL', '\\\\.\\NUL'],
    ['COM1', '\\\\.\\COM1'],
    ['LPT9', '\\\\.\\LPT9'],
    ['CON', '\\\\.\\CON'],
    ['CONIN$', '\\\\.\\CONIN$'],
  ];
  for (const [target, device] of DEVICE_ROWS) {
    test(`${JSON.stringify(target)} opens ${JSON.stringify(device)} and never lstats or walks the path`, (t) => {
      const seam = scripted({ charDevice: true });
      const lstat = t.mock.method(fs, 'lstatSync');
      const realpath = t.mock.method(fs.realpathSync, 'native');
      const stat = t.mock.method(fs, 'statSync');

      inDir(() => write(target, seam));

      assert.deepStrictEqual(kinds(seam), ['open', 'fstat', 'write', 'close']);
      assert.deepStrictEqual(seam.log[0], ['open', device, fs.constants.O_WRONLY]);
      assert.strictEqual(lstat.mock.callCount(), 0);
      assert.strictEqual(realpath.mock.callCount(), 0);
      assert.strictEqual(stat.mock.callCount(), 0);
    });
  }

  // Spellings that must never open the device. Every target stays inside the test's temp `dir`
  // (a bare name resolves against the cwd, which `inDir` sets to `dir`); the checked path's own
  // outcome is not asserted, only that the device seam saw no open. Spellings that cannot be
  // rooted in `dir` (`D:\x\NUL`, `C:NUL`, `..\NUL`, `\\.\C:`, `\\.\NUL.txt`) are classified by the
  // direct windowsDeviceNamespacePath table below instead of being written.
  const CHECKED_ROWS = [
    ['nul.txt', () => 'nul.txt'],
    ['NUL.', () => 'NUL.'],
    ['NUL:stream', () => 'NUL:stream'],
    ['COM\u00B9', () => 'COM\u00B9'],
    ['con.txt', () => 'con.txt'],
    ['NUL.txt', () => 'NUL.txt'],
    ['<dir>\\sub\\NUL', (d) => path.join(d, 'sub', 'NUL')],
    ['sub/NUL', () => 'sub/NUL'],
    ['<dir>\\sub\\con.txt', (d) => path.join(d, 'sub', 'con.txt')],
    ['\\\\?\\<dir>\\sub\\NUL', (d) => '\\\\?\\' + path.join(d, 'sub', 'NUL')],
  ];
  for (const [label, build] of CHECKED_ROWS) {
    test(`${JSON.stringify(label)} never opens a device and takes the checked path`, () => {
      const seam = scripted({ charDevice: true });
      fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });

      inDir(() => {
        try { write(build(dir), seam); } catch { /* the checked path may refuse the name on some platforms */ }
      });

      assert.deepStrictEqual(seam.log, []);
    });
  }

  test('a device-namespace target without allowSpecialTarget never reaches the device branch', () => {
    const seam = scripted({ charDevice: true });

    inDir(() => {
      try { write('\\\\.\\nul', seam, 'win32', false); } catch { /* refused or written as a plain name on POSIX */ }
    });

    assert.deepStrictEqual(seam.log, []);
  });

  for (const code of ['ENOENT', 'EISDIR', 'EACCES', 'EPERM', 'EBUSY', 'EINVAL']) {
    test(`an open failing with ${code} falls through to the checked path`, { skip: SKIP_REAL_RESERVED }, () => {
      const seam = scripted({ openError: code });

      inDir(() => write('con', seam));

      assert.deepStrictEqual(kinds(seam), ['open']);
      assert.strictEqual(fs.readFileSync(path.join(dir, 'con'), 'utf-8'), 'x');
    });
  }

  test('any other open failure is surfaced', () => {
    const seam = scripted({ openError: 'EIO' });

    assert.throws(() => inDir(() => write('con', seam)), { code: 'EIO' });
  });

  test('a non-reserved name or a non-win32 platform never touches the seam fs', () => {
    const a = scripted({ charDevice: true });
    const b = scripted({ charDevice: true });

    inDir(() => {
      write('config.json', a);
      write('con.txt', b, 'linux');
    });

    assert.deepStrictEqual(a.log, []);
    assert.deepStrictEqual(b.log, []);
  });
});

describe('#5759 windowsDeviceNamespacePath', () => {
  const { windowsDeviceNamespacePath } = require(SHELL_PROJECTION_PATH);

  test('exact reserved stems map to \\\\.\\STEM; every other spelling maps to null', () => {
    assert.strictEqual(windowsDeviceNamespacePath('nul'), '\\\\.\\NUL');
    assert.strictEqual(windowsDeviceNamespacePath('NUL'), '\\\\.\\NUL');
    assert.strictEqual(windowsDeviceNamespacePath('.\\com2'), '\\\\.\\COM2');
    assert.strictEqual(windowsDeviceNamespacePath('./LPT9'), '\\\\.\\LPT9');
    assert.strictEqual(windowsDeviceNamespacePath('\\\\.\\lpt1'), '\\\\.\\LPT1');
    assert.strictEqual(windowsDeviceNamespacePath('\\\\?\\Con'), '\\\\.\\CON');
    assert.strictEqual(windowsDeviceNamespacePath('conin$'), '\\\\.\\CONIN$');
    assert.strictEqual(windowsDeviceNamespacePath('CONOUT$'), '\\\\.\\CONOUT$');
    assert.strictEqual(windowsDeviceNamespacePath('prn'), '\\\\.\\PRN');
    assert.strictEqual(windowsDeviceNamespacePath('aux'), '\\\\.\\AUX');
  });

  for (const target of [
    'nul.txt', 'NUL.', 'NUL ', 'NUL:stream', 'con.txt', 'NUL.txt', '.\\com2.txt', 'LPT9.log', 'COM\u00B9', 'LPT\u00B2',
    'D:\\x\\NUL', 'sub\\NUL', 'sub/NUL', 'C:NUL', '\\\\?\\C:\\x\\NUL', '..\\NUL', '\\\\.\\C:', '\\\\.\\NUL.txt',
    '\\\\.\\NUL:s', 'config.json', 'com10', 'com0', 'lpt0', 'null', '',
  ]) {
    test(`${JSON.stringify(target)} maps to null`, () => {
      assert.strictEqual(windowsDeviceNamespacePath(target), null);
    });
  }

  test('property: a reserved stem followed by a non-empty suffix maps to null', () => {
    fc.assert(fc.property(
      fc.constantFrom('nul', 'con', 'prn', 'aux', 'com1', 'lpt9'),
      fc.stringMatching(/^[A-Za-z0-9_. :-]{1,8}$/),
      fc.boolean(),
      (stem, suffix, upper) => windowsDeviceNamespacePath((upper ? stem.toUpperCase() : stem) + suffix) === null,
    ));
  });
});

// Runs on every OS: a directory at the config path is unusable everywhere. POSIX reports
// EISDIR; Windows reports whatever errno its open(2) gives, so only the reason and the path
// are pinned there.
describe('#5759 a directory at the config path is unusable', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-5759-dir-')); });
  afterEach(() => { cleanup(tmpDir); });

  test('config.json is a directory: config_unreadable, named on stderr (EISDIR on POSIX)', () => {
    const rootConfig = path.join(tmpDir, '.planning', 'config.json');
    fs.mkdirSync(rootConfig, { recursive: true });

    const r = loadResolvedInChild(tmpDir);

    assertExitedByItself(r);
    assert.strictEqual(JSON.parse(r.stdout).reason, 'config_unreadable');
    assert.ok(r.stderr.includes(rootConfig));
    if (process.platform !== 'win32') assert.ok(r.stderr.includes('EISDIR'));
  });
});

// #5831: hostile STATE-ARCHIVE.md rows, moved from tests/state-prune.test.cjs so that file
// stays free of real-OS signals (symlinks, FIFOs, platform skips).
describe('#5831 state prune refuses a symlinked or FIFO STATE-ARCHIVE.md', { skip: SKIP_WIN32 }, () => {
  const { createTempProject } = require('./helpers.cjs');
  const STATE_LIB_PATH = path.join(LIB_DIR, 'state.cjs');
  const SEED_ARCHIVE = '# STATE Archive\n\nSeeded by the test.\n';
  let tmpDir;
  let statePath;
  let archivePath;

  beforeEach(() => {
    tmpDir = createTempProject();
    statePath = path.join(tmpDir, '.planning', 'STATE.md');
    archivePath = path.join(tmpDir, '.planning', 'STATE-ARCHIVE.md');
    fs.writeFileSync(statePath, [
      '# Session State', '', '**Current Phase:** 8', '', '## Decisions', '',
      '- [Phase 1]: Decision one, only copy',
      '- [Phase 2]: Decision two, only copy',
      '- [Phase 4]: Decision four, only copy',
      '- [Phase 7]: Recent decision', '',
    ].join('\n'));
  });
  afterEach(() => { cleanup(tmpDir); });

  function prune(keepRecent) {
    require(STATE_LIB_PATH).cmdStatePrune(tmpDir, { keepRecent: String(keepRecent), dryRun: false, silent: true }, true);
  }
  function lockReleased() {
    return !fs.existsSync(statePath + '.lock');
  }

  test('a symlinked STATE-ARCHIVE.md is refused: STATE.md, the link and its target are unchanged', () => {
    const linked = path.join(tmpDir, 'elsewhere-archive.md');
    fs.writeFileSync(linked, SEED_ARCHIVE);
    fs.symlinkSync(linked, archivePath);
    const stateBefore = fs.readFileSync(statePath);

    assert.throws(() => prune(3), /symlink|regular file/i);

    assert.deepStrictEqual(fs.readFileSync(statePath), stateBefore, 'STATE.md unchanged');
    assert.ok(fs.lstatSync(archivePath).isSymbolicLink(), 'the link is still a link');
    assert.strictEqual(fs.readFileSync(linked, 'utf-8'), SEED_ARCHIVE, 'the link target is untouched');
    assert.ok(lockReleased(), 'the STATE.md lock is released');
  });

  test('--dry-run with a symlinked STATE-ARCHIVE.md refuses like the real run and writes nothing', () => {
    const linked = path.join(tmpDir, 'elsewhere-archive.md');
    fs.writeFileSync(linked, SEED_ARCHIVE);
    fs.symlinkSync(linked, archivePath);
    const stateBefore = fs.readFileSync(statePath);

    assert.throws(
      () => require(STATE_LIB_PATH).cmdStatePrune(tmpDir, { keepRecent: '3', dryRun: true, silent: true }, true),
      /symlink|regular file/i,
    );

    assert.deepStrictEqual(fs.readFileSync(statePath), stateBefore, 'STATE.md unchanged');
    assert.ok(fs.lstatSync(archivePath).isSymbolicLink(), 'the link is still a link');
    assert.strictEqual(fs.readFileSync(linked, 'utf-8'), SEED_ARCHIVE, 'the link target is untouched');
    assert.ok(lockReleased(), 'no lock is left behind');
  });

  test('a FIFO at STATE-ARCHIVE.md is refused without blocking while the lock is held', () => {
    assertSeamExit(assert, runHook(archivePath, [], { interpreter: 'mkfifo', timeoutMs: PROBE_TIMEOUT_MS }), 0, 'mkfifo');
    const stateBefore = fs.readFileSync(statePath);
    const script = `try { require(${JSON.stringify(STATE_LIB_PATH)})` +
      `.cmdStatePrune(${JSON.stringify(tmpDir)}, { keepRecent: '3', dryRun: false, silent: true }, true); console.log('RAN'); }` +
      ` catch (e) { console.log('THREW ' + (e && e.code)); }`;
    const child = runNode(['-e', script], { timeoutMs: PROBE_TIMEOUT_MS });

    assert.strictEqual(child.outcome, OUTCOME.EXITED, `the prune must exit on a FIFO, not hang, die or fail to spawn (${child.summary})`);
    assert.match(child.stdout, /THREW/, 'the prune refuses the FIFO');
    assert.deepStrictEqual(fs.readFileSync(statePath), stateBefore, 'STATE.md unchanged');
  });

  for (const dryRun of [false, true]) {
    test(`a FIFO at STATE.md makes state prune${dryRun ? ' --dry-run' : ''} exit non-zero without blocking`, () => {
      fs.unlinkSync(statePath);
      assertSeamExit(assert, runHook(statePath, [], { interpreter: 'mkfifo', timeoutMs: PROBE_TIMEOUT_MS }), 0, 'mkfifo');
      // Uncaught: the child must exit non-zero on its own rather than block on the pipe.
      const script = `require(${JSON.stringify(STATE_LIB_PATH)})` +
        `.cmdStatePrune(${JSON.stringify(tmpDir)}, { keepRecent: '3', dryRun: ${dryRun}, silent: true }, true);`;
      const child = runNode(['-e', script], { timeoutMs: PROBE_TIMEOUT_MS });

      assert.strictEqual(child.outcome, OUTCOME.EXITED, `the prune must exit on a FIFO, not hang, die or fail to spawn (${child.summary})`);
      assert.notStrictEqual(child.exitCode, 0, 'the prune fails');
      assert.match(child.stderr, /ENXIO/, 'the FIFO is refused with ENXIO');
    });
  }

  test('a STATE.md that is a FIFO makes a locked read-modify-write command exit non-zero without blocking', () => {
    fs.unlinkSync(statePath);
    assertSeamExit(assert, runHook(statePath, [], { interpreter: 'mkfifo', timeoutMs: PROBE_TIMEOUT_MS }), 0, 'mkfifo');
    const script = `require(${JSON.stringify(STATE_LIB_PATH)}).cmdStateUpdate(${JSON.stringify(tmpDir)}, 'Status', 'x');`;
    const child = runNode(['-e', script], { timeoutMs: PROBE_TIMEOUT_MS });

    assert.strictEqual(child.outcome, OUTCOME.EXITED, `the command must exit on a FIFO, not hang, die or fail to spawn (${child.summary})`);
    assert.notStrictEqual(child.exitCode, 0, 'the command fails');
    assert.match(child.stderr, /ENXIO/, 'the FIFO is refused with ENXIO');
  });

  test('rolling back a prune of a symlinked STATE.md restores a regular file that is not given the link\'s 0777 mode', () => {
    const { mock } = require('node:test');
    const linkedTarget = path.join(tmpDir, 'real-state.md');
    const stateBefore = fs.readFileSync(statePath);
    fs.renameSync(statePath, linkedTarget);
    fs.chmodSync(linkedTarget, 0o600);
    fs.symlinkSync(linkedTarget, statePath);
    const probe = path.join(tmpDir, 'mode-probe');
    fs.writeFileSync(probe, '');
    const defaultMode = fs.statSync(probe).mode & 0o777; // what a newly created file gets under this umask

    // The STATE.md publish lands, then reports failure: the rollback must put the snapshot back.
    const realRename = fs.renameSync;
    let failed = false;
    mock.method(fs, 'renameSync', (from, to, ...rest) => {
      realRename.call(fs, from, to, ...rest);
      if (!failed && to === statePath) {
        failed = true;
        throw Object.assign(new Error('EIO: simulated'), { code: 'EIO' });
      }
    });
    try {
      assert.throws(() => prune(3), (err) => err.code === 'EIO');
    } finally {
      mock.restoreAll();
    }

    assert.ok(failed, 'the STATE.md write was made to fail');
    assert.ok(fs.lstatSync(statePath).isFile(), 'STATE.md is a regular file again');
    assert.deepStrictEqual(fs.readFileSync(statePath), stateBefore, 'the snapshot is back');
    if (process.platform !== 'win32') {
      const mode = fs.lstatSync(statePath).mode & 0o777;
      assert.notStrictEqual(mode, 0o777, 'the symlink\'s own mode is not applied');
      assert.strictEqual(mode, defaultMode, 'the restored file has the default creation mode');
    }
  });
});
