'use strict';

/**
 * Platform-sensitive tests split out of tests/config-loader-bounded-read.test.cjs (#5074, #5759).
 *
 * scripts/gen-platform-conformance-tier.cjs selects whole files for the real-OS
 * (Windows/macOS) conformance tier. The rows below carry the platform signal, so they live
 * here; tests/config-loader-bounded-read.test.cjs stays signal-free and runs on Linux only.
 * Add a new platform-sensitive row HERE, not in the base file.
 *
 * Moved rows and why each needs a real OS:
 * - every "FIFO" row — creates a real named pipe with `mkfifo`; there is no FIFO on
 *   Windows (process-platform, raw-child-process).
 * - "config.json is a directory" — the errno a directory yields on open() is the
 *   POSIX one (EISDIR); Windows reports a different code (process-platform).
 *
 * A config FIFO with no writer blocks open(2) forever, so each hang row spawns the
 * command under a kill timer and asserts that the child EXITED ON ITS OWN with status 0.
 * There is no elapsed-time assertion: a hang surfaces as outcome `timed_out`, not as a
 * slow pass.
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

const CONFIG_LOADER_PATH = path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'config-loader.cjs');
const LOAD_RESOLVED_SCRIPT =
  'process.stdout.write(JSON.stringify(require(process.argv[1]).loadConfigResolved(process.argv[2])))';

function makeFifo(fifoPath) {
  // Throws when mkfifo fails, so on POSIX a row never passes without a real FIFO.
  execFileSync('mkfifo', [fifoPath], { stdio: 'ignore', timeout: PROBE_TIMEOUT_MS });
}

describe('#5759 a FIFO or directory config.json must not hang configuration loading', {
  skip: process.platform === 'win32' ? 'no FIFOs on Windows' : false,
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

  function loadResolvedInChild() {
    return runNode(['-e', LOAD_RESOLVED_SCRIPT, CONFIG_LOADER_PATH, tmpDir], {
      cwd: tmpDir,
      env: installSpawnEnv({ GSD_WORKSTREAM: '' }),
      timeoutMs: PROBE_TIMEOUT_MS,
    });
  }

  function assertExitedByItself(r) {
    assert.strictEqual(r.outcome, OUTCOME.EXITED, `child must exit on its own, not be killed: ${r.summary}`);
    assert.strictEqual(r.exitCode, 0, r.summary);
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

    const r = loadResolvedInChild();

    assertExitedByItself(r);
    const resolution = JSON.parse(r.stdout);
    assert.strictEqual(resolution.reason, 'config_unreadable');
    assert.strictEqual(resolution.degraded, true);
  });

  test('config.json is a directory: config_unreadable with EISDIR (unchanged)', () => {
    fs.mkdirSync(rootConfig());

    const r = loadResolvedInChild();

    assertExitedByItself(r);
    assert.strictEqual(JSON.parse(r.stdout).reason, 'config_unreadable');
    assert.ok(r.stderr.includes(rootConfig()) && r.stderr.includes('EISDIR'));
  });
});
