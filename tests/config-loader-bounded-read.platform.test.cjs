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
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { cleanup, TOOLS_PATH, installSpawnEnv } = require('./helpers.cjs');
const { runNode, OUTCOME } = require('./helpers/process-seam.cjs');
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
  execFileSync('mkfifo', [fifoPath], { stdio: 'ignore', timeout: PROBE_TIMEOUT_MS });
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
  // [first, last] of each escaped range; the code points on both sides must pass through.
  const RANGES = [[0x200b, 0x200f], [0x2028, 0x2029], [0x202a, 0x202e], [0x2066, 0x2069]];

  for (const [lo, hi] of RANGES) {
    test(`U+${lo.toString(16)}..U+${hi.toString(16)} are escaped and the neighbours are not`, () => {
      assert.strictEqual(printablePath(`a${String.fromCodePoint(lo - 1)}b`), `a${String.fromCodePoint(lo - 1)}b`);
      assert.strictEqual(printablePath(`a${String.fromCodePoint(hi + 1)}b`), `a${String.fromCodePoint(hi + 1)}b`);
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
    const git = (...args) => execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], {
      cwd: tmpDir, stdio: 'ignore', timeout: PROBE_TIMEOUT_MS,
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
