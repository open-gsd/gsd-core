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
