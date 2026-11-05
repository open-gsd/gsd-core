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
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

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
