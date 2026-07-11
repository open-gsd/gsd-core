/**
 * Tests for config-get --default flag (#1893)
 *
 * When --default <value> is passed, config-get should return the default
 * value (exit 0) instead of erroring (exit 1) when the key is absent.
 * When the key IS present, --default should be ignored and the real value
 * returned.
 */

'use strict';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { cleanup } = require('./helpers.cjs');

// In-process invocation, not execFileSync: cmdConfigGet is a pure CJS
// function reachable without spawning `node` as a child. The prior
// execFileSync(..., { timeout: 5000 }) raced a real subprocess's startup
// (full node boot + gsd-tools.cjs's large eager require graph — capability
// registry, phase/roadmap/agent/check/task routers, verify.cjs,
// cli-skew-check, findProjectRoot, etc.) against a fixed 5s wall clock, with
// no retry. Under Docker host contention that wall clock loses
// nondeterministically (ETIMEDOUT) — a test-harness race, not a product
// defect. bin/lib/config.cjs requires none of that dispatcher machinery, so
// calling cmdConfigGet directly removes the subprocess-spawn cost and the
// wall-clock race entirely: no timeout of any size can flake this.
const config = require(path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'config.cjs'));
// io.cjs owns error()/output() and the JSON-error-mode toggle. cmdConfigGet's `error`
// is bound to io.error at load, so we drive io directly to (a) get structured stderr
// we can assert a typed `reason` on, and (b) restore the mode after each error probe.
const io = require(path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'io.cjs'));

/**
 * cmdConfigGet's error() path (gsd-core/bin/lib/io.cjs) calls process.exit(1)
 * directly (it predates the ExitError/runMain seam used by the CLI
 * entrypoint's non-error paths). Intercepting process.exit with a throwable
 * sentinel lets the error path be exercised in-process without killing the
 * test worker.
 *
 * The sentinel carries the ORIGINAL error message (not a generic "process.exit(1)").
 * That matters for cmdConfigGet's "no config.json" branch, whose `error()` sits inside
 * a try/catch that reclassifies any throw NOT starting with "No config.json" as a parse
 * failure (a guard that is dead in production, where process.exit terminates first, but
 * becomes live once process.exit is a throwing seam). Carrying the real message makes
 * that guard re-throw — modeling the single, faithful production termination instead of
 * a spurious second error() call with the wrong reason.
 */
class _ExitSignal extends Error {
  constructor(code, message) {
    super(message ?? `process.exit(${code})`);
    this.code = code;
  }
}

/**
 * bin/lib/io.cjs's output()/error() write directly to the raw fd (1 or 2)
 * via fs.writeSync — they bypass console.log entirely, so
 * tests/helpers.cjs's captureConsole() cannot observe them (see
 * tests/io.test.cjs: "output() writes directly to fd 1"). Monkeypatch
 * fs.writeSync itself — save the original, override, restore in a finally,
 * the project's standard IO capture/fault-injection seam — to capture what
 * would have hit the fd.
 */
function captureFdWrite(fd, fn) {
  const orig = fs.writeSync;
  let captured = Buffer.alloc(0);
  fs.writeSync = (writeFd, ...rest) => {
    if (writeFd !== fd) return orig.call(fs, writeFd, ...rest);
    const [data, offset = 0, length] = rest;
    const chunk = Buffer.isBuffer(data)
      ? data.subarray(offset, offset + (length ?? data.length - offset))
      : Buffer.from(String(data), 'utf8');
    captured = Buffer.concat([captured, chunk]);
    return chunk.length;
  };
  try {
    fn();
  } finally {
    fs.writeSync = orig;
  }
  return captured.toString('utf-8');
}

/**
 * Parse a CLI-style config-get argv (mirrors gsd-core/bin/gsd-tools.cjs's
 * 'config-get' case: key is args[1], optional --default <value>, optional
 * --raw) into cmdConfigGet's positional params. Keeps the test bodies below
 * expressed in the same CLI-args vocabulary they always were.
 */
function parseConfigGetArgs(args) {
  const rest = args.slice(1); // drop the leading 'config-get'
  let raw = false;
  let defaultValue;
  const positional = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--raw') { raw = true; continue; }
    if (rest[i] === '--default') { defaultValue = rest[i + 1] ?? ''; i++; continue; }
    positional.push(rest[i]);
  }
  return { keyPath: positional[0], raw, defaultValue };
}

describe('config-get --default flag (#1893)', () => {
  let tmpDir;
  let planningDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-config-default-'));
    planningDir = path.join(tmpDir, '.planning');
    fs.mkdirSync(planningDir, { recursive: true });
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  function run(...args) {
    const { keyPath, raw, defaultValue } = parseConfigGetArgs(args);
    const out = captureFdWrite(1, () => {
      config.cmdConfigGet(tmpDir, keyPath, raw, defaultValue);
    });
    return out.trim();
  }

  function runRaw(...args) {
    return run(...args, '--raw');
  }

  function runExpectError(...args) {
    const { keyPath, raw, defaultValue } = parseConfigGetArgs(args);
    const origExit = process.exit;
    const origWriteSync = fs.writeSync;
    io.setJsonErrorMode(true); // structured stderr line lets the sentinel carry the message + assert reason
    let exitCount = 0;
    let exitCode;
    let stderr = '';
    fs.writeSync = (fd, ...rest) => {
      if (fd !== 2) return origWriteSync.call(fs, fd, ...rest);
      const [data, offset = 0, length] = rest;
      const chunk = Buffer.isBuffer(data)
        ? data.subarray(offset, offset + (length ?? data.length - offset)).toString('utf8')
        : String(data);
      stderr += chunk;
      return Buffer.byteLength(chunk);
    };
    const lastError = () => {
      const parts = stderr.split('\n').filter(Boolean);
      try { return JSON.parse(parts[parts.length - 1]); } catch { return {}; }
    };
    process.exit = (code) => {
      exitCount++;
      exitCode = code;
      // Carry the just-emitted error message so cmdConfigGet's seam guard re-throws
      // (single, faithful fire) instead of catching + reclassifying into a 2nd error().
      throw new _ExitSignal(code, lastError().message);
    };
    try {
      config.cmdConfigGet(tmpDir, keyPath, raw, defaultValue);
    } catch (e) {
      if (!(e instanceof _ExitSignal)) throw e;
    } finally {
      process.exit = origExit;
      fs.writeSync = origWriteSync;
      io.setJsonErrorMode(false);
    }
    assert.ok(exitCode !== 0 && exitCode !== undefined, 'Expected non-zero exit code');
    // Faithfulness guard: production process.exit terminates, so error() fires exactly
    // once. A count of 2 means the throwing-exit seam was caught + reclassified (the bug
    // this harness redesign fixes) — fail loudly rather than report a wrong reason.
    assert.equal(exitCount, 1, 'error() must fire exactly once (production process.exit terminates)');
    const payload = lastError();
    return { status: exitCode, reason: payload.reason, message: payload.message, stderr };
  }

  test('absent key without --default errors', () => {
    fs.writeFileSync(path.join(planningDir, 'config.json'), '{}');
    const { reason } = runExpectError('config-get', 'nonexistent.key', '--raw');
    assert.equal(reason, io.ERROR_REASON.CONFIG_KEY_NOT_FOUND, 'absent key must report CONFIG_KEY_NOT_FOUND');
  });

  test('absent key with --default returns default value', () => {
    fs.writeFileSync(path.join(planningDir, 'config.json'), '{}');
    const result = runRaw('config-get', 'nonexistent.key', '--default', 'fallback');
    assert.equal(result, 'fallback');
  });

  test('absent key with --default "" returns empty string', () => {
    fs.writeFileSync(path.join(planningDir, 'config.json'), '{}');
    const result = runRaw('config-get', 'nonexistent.key', '--default', '');
    assert.equal(result, '');
  });

  test('present key with --default returns real value (ignores default)', () => {
    fs.writeFileSync(path.join(planningDir, 'config.json'), JSON.stringify({
      workflow: { discuss_mode: 'adaptive' }
    }));
    const result = runRaw('config-get', 'workflow.discuss_mode', '--default', 'ignored');
    assert.equal(result, 'adaptive');
  });

  test('nested absent key with --default returns default', () => {
    fs.writeFileSync(path.join(planningDir, 'config.json'), JSON.stringify({
      workflow: {}
    }));
    const result = runRaw('config-get', 'workflow.deep.missing.key', '--default', 'safe');
    assert.equal(result, 'safe');
  });

  test('missing config.json with --default returns default', () => {
    // No config.json written
    const result = runRaw('config-get', 'any.key', '--default', 'no-config');
    assert.equal(result, 'no-config');
  });

  test('missing config.json without --default errors', () => {
    // No config.json written
    const { reason } = runExpectError('config-get', 'any.key', '--raw');
    assert.equal(reason, io.ERROR_REASON.CONFIG_NO_FILE, 'missing config.json must report CONFIG_NO_FILE');
  });

  test('--default works with JSON output (no --raw)', () => {
    fs.writeFileSync(path.join(planningDir, 'config.json'), '{}');
    const result = run('config-get', 'missing.key', '--default', 'json-test');
    const parsed = JSON.parse(result);
    assert.equal(parsed, 'json-test');
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-2798-context-window-config-key.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-2798-context-window-config-key (consolidation epic #1969 B3 #1972)", () => {
/**
 * Regression test for bug #2798
 *
 * `gsd-sdk query config-set context_window <n>` was rejected with
 * "Unknown config key: context_window" because context_window was missing
 * from VALID_CONFIG_KEYS in sdk/src/query/config-schema.ts.
 *
 * The fix added 'context_window' to the allowlist.
 * This test prevents future drift where the key gets accidentally removed.
 */

'use strict';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createTempProject, cleanup } = require('./helpers.cjs');

const REPO_ROOT = path.join(__dirname, '..');
const SDK_CLI = path.join(REPO_ROOT, 'sdk', 'dist', 'cli.js');

function runConfigSet(key, value, projectDir) {
  const argv = ['query', 'config-set', key, String(value), '--project-dir', projectDir];
  let stdout = '';
  let exitCode = 0;
  try {
    stdout = execFileSync(process.execPath, [SDK_CLI, ...argv], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, GSD_SESSION_KEY: '' },
    });
  } catch (err) {
    exitCode = err.status ?? 1;
    stdout = err.stdout?.toString() ?? '';
  }
  let json = null;
  try { json = JSON.parse(stdout.trim()); } catch { /* ok */ }
  return { exitCode, json };
}

describe('bug-2798: context_window is a valid config key', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject('gsd-test-2798-');
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ mode: 'balanced' })
    );
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('config-set context_window succeeds (not rejected as unknown key)', (t) => {
    if (!fs.existsSync(SDK_CLI)) {
      t.skip('sdk/dist/cli.js not built — run `cd sdk && npm run build` to enable this integration test');
      return;
    }
    const result = runConfigSet('context_window', 1000000, tmpDir);

    assert.strictEqual(result.exitCode, 0, 'should exit 0 (key is valid)');
    assert.ok(result.json !== null, 'should emit JSON');
    assert.strictEqual(result.json?.updated, true, 'updated should be true');
    assert.strictEqual(result.json?.key, 'context_window');
  });

  test('context_window value is written to config.json', (t) => {
    if (!fs.existsSync(SDK_CLI)) {
      t.skip('sdk/dist/cli.js not built — run `cd sdk && npm run build` to enable this integration test');
      return;
    }
    runConfigSet('context_window', 500000, tmpDir);

    const config = JSON.parse(
      fs.readFileSync(path.join(tmpDir, '.planning', 'config.json'), 'utf-8')
    );
    assert.strictEqual(config.context_window, 500000, 'context_window should be persisted');
  });

  test('config-schema CJS and SDK allowlists both include context_window', (t) => {
    if (!fs.existsSync(path.join(REPO_ROOT, 'sdk', 'dist', 'query', 'config-schema.js'))) {
      t.skip('sdk/dist/query/config-schema.js not built — run `cd sdk && npm run build` to enable this integration test');
      return;
    }
    const cjsSchema = require(path.join(REPO_ROOT, 'gsd-core', 'bin', 'lib', 'config-schema.cjs'));
    const sdkSchema = require(path.join(REPO_ROOT, 'sdk', 'dist', 'query', 'config-schema.js'));

    assert.ok(
      cjsSchema.VALID_CONFIG_KEYS.has('context_window'),
      'CJS VALID_CONFIG_KEYS must include context_window'
    );
    assert.ok(
      sdkSchema.VALID_CONFIG_KEYS.has('context_window'),
      'SDK VALID_CONFIG_KEYS must include context_window'
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-2943-config-get-context-window-default.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-2943-config-get-context-window-default (consolidation epic #1969 B3 #1972)", () => {
/**
 * Regression test for bug #2943
 *
 * `gsd-tools.cjs config-get context_window` (and the SDK equivalent) threw
 * "Key not found: context_window" when the key was absent from config.json,
 * even though context_window has a documented schema default of 200000.
 *
 * Fix: `cmdConfigGet` in bin/lib/config.cjs now consults a SCHEMA_DEFAULTS map
 * before emitting "Key not found", so schema-defaulted keys always return the
 * default value (exit 0) when not explicitly set in the project config.
 */

'use strict';

// Migrated to typed-IR (#2974): the previous shape grepped stderr/stdout for
// "Key not found"; now the test passes `--json-errors` to gsd-tools and
// asserts on the structured `reason` code (a frozen-enum value from
// `core.cjs::ERROR_REASON`). Exit code is also a typed signal — together
// they fully discriminate the failure class.

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const GSD_TOOLS = path.join(__dirname, '..', 'gsd-core', 'bin', 'gsd-tools.cjs');
const { ERROR_REASON } = require(path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'io.cjs'));
const { cleanup } = require('./helpers.cjs');

describe('bug-2943: config-get returns schema default for context_window', () => {
  let tmpDir;
  let planningDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-test-2943-'));
    planningDir = path.join(tmpDir, '.planning');
    fs.mkdirSync(planningDir, { recursive: true });
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  /**
   * Run config-get with optional extra args. Returns { exitCode, stdout, stderr }.
   * Uses --raw so we get the plain scalar value, not JSON-wrapped.
   */
  function runConfigGet(keyPath, extraArgs = []) {
    const args = [GSD_TOOLS, 'config-get', keyPath, '--raw', '--cwd', tmpDir, ...extraArgs];
    let stdout = '';
    let stderr = '';
    let exitCode = 0;
    try {
      // Windows/Node 22 under --test-concurrency=4 can starve subprocess slots when
      // sharing a wave with bug-2760-codex-install (8–15s install subtests). 15s covers
      // observed worst case (13.5s) with headroom.
      stdout = execFileSync(process.execPath, args, {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 15000,
      });
    } catch (err) {
      exitCode = err.status ?? 1;
      stdout = err.stdout?.toString() ?? '';
      stderr = err.stderr?.toString() ?? '';
    }
    return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
  }

  test('returns "200000" (exit 0) when context_window absent from config.json', () => {
    // Fixture A: config with unrelated keys, no context_window
    fs.writeFileSync(
      path.join(planningDir, 'config.json'),
      JSON.stringify({ workflow: { auto_advance: false } })
    );

    const result = runConfigGet('context_window');

    assert.strictEqual(result.exitCode, 0, 'should exit 0 (schema default applied)');
    assert.strictEqual(result.stdout, '200000', 'should return schema default of 200000');
  });

  test('returns configured value when context_window is explicitly set', () => {
    // Fixture B: config has context_window: 1000000
    fs.writeFileSync(
      path.join(planningDir, 'config.json'),
      JSON.stringify({ context_window: 1000000 })
    );

    const result = runConfigGet('context_window');

    assert.strictEqual(result.exitCode, 0, 'should exit 0 for found key');
    assert.strictEqual(result.stdout, '1000000', 'should return configured value not schema default');
  });

  test('--default flag overrides schema default', () => {
    // config has context_window but we pass --default with a different value —
    // when key IS present, real value wins over any default
    fs.writeFileSync(
      path.join(planningDir, 'config.json'),
      JSON.stringify({ workflow: { auto_advance: false } })
    );

    const result = runConfigGet('context_window', ['--default', '123456']);

    assert.strictEqual(result.exitCode, 0, 'should exit 0 when --default provided');
    assert.strictEqual(result.stdout, '123456', 'should return the --default value, not schema default');
  });

  test('errors with reason=CONFIG_KEY_NOT_FOUND (exit 1) for an unknown absent key — no regression', () => {
    // An unrecognised key with no schema default still errors as before.
    // Migrated #2974: assert on the structured reason code from --json-errors,
    // not on substring presence in stderr/stdout text.
    fs.writeFileSync(
      path.join(planningDir, 'config.json'),
      JSON.stringify({ workflow: { auto_advance: false } })
    );

    const result = runConfigGet('totally_unknown_key_xyz', ['--json-errors']);

    assert.strictEqual(result.exitCode, 1, 'should exit 1 for unknown absent key');
    let parsed;
    try {
      parsed = JSON.parse(result.stderr);
    } catch (err) {
      assert.fail(`expected JSON-shaped stderr from --json-errors; got: ${JSON.stringify(result.stderr)}`);
    }
    assert.strictEqual(parsed.ok, false);
    assert.strictEqual(parsed.reason, ERROR_REASON.CONFIG_KEY_NOT_FOUND,
      `expected reason=${ERROR_REASON.CONFIG_KEY_NOT_FOUND}, got=${parsed.reason}`);
  });

  test('--default flag still works for arbitrary absent keys', () => {
    fs.writeFileSync(
      path.join(planningDir, 'config.json'),
      JSON.stringify({})
    );

    const result = runConfigGet('some.missing.key', ['--default', '200000']);

    assert.strictEqual(result.exitCode, 0, 'should exit 0 when --default supplied');
    assert.strictEqual(result.stdout, '200000', 'should return the explicit --default value');
  });
});
  });
}

// ────────────────────────────────────────────────────────────────────────
// Folded from tests/feat-3593-cli-negative-config.test.cjs — consolidation epic #1969 (B6 #1975)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:feat-3593-cli-negative-config (consolidation epic #1969 B6 #1975)", () => {
/**
 * CLI negative matrix for the `config` command family (#3593).
 *
 * Exercises the 12 adversarial input categories enumerated in
 * CONTRIBUTING.md §"QA Matrix Requirements / CLI and command routing"
 * against `config-get` and `config-set`. The harness in
 * `tests/helpers/cli-negative.cjs` shapes spawnSync output into a typed
 * IR so every assertion runs on `result.reason`, `result.status`, and
 * `result.hasStackTrace` — never on stderr/stdout prose.
 *
 * Each test gets its own temp project (no shared state) so concurrent
 * runs can't observe each other's filesystem mutations. Hostile values
 * (shell metacharacters, null bytes, unicode, very long strings) reach
 * the CLI as single argv elements via spawnSync — never composed into
 * a shell string — so the test framework itself can't be the source of
 * a false positive on shell-injection assertions.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runCli } = require('./helpers/cli-negative.cjs');
const { createTempProject, cleanup } = require('./helpers.cjs');

/**
 * Universal invariants every adversarial case must satisfy when the
 * CLI is invoked with --json-errors. Bundling these in a helper keeps
 * each test focused on the case-specific reason assertion.
 */
function assertSafeFailure(result, msg = '') {
  assert.notEqual(result.status, 0, `${msg} :: expected non-zero exit`);
  assert.equal(result.signal, null, `${msg} :: must exit cleanly, not via signal`);
  assert.equal(result.hasStackTrace, false, `${msg} :: stderr must not leak a V8 stack frame`);
  assert.equal(result.ok, false, `${msg} :: JSON payload ok must be false`);
  assert.equal(typeof result.reason, 'string', `${msg} :: reason must be a string`);
  assert.notEqual(result.reason, '', `${msg} :: reason must not be empty`);
  // The harness's JSON-shape detection runs on the trimmed stderr; if we
  // got here with reason set, the payload was a valid object — that already
  // implies no rogue prose was mixed in. Re-asserting the trimmed form would
  // be redundant.
}

/**
 * Snapshot the file inventory of a directory so a later assertion can
 * prove the failing CLI invocation did NOT create or modify any file.
 */
function snapshotInventory(dir) {
  const entries = [];
  function walk(rel) {
    const abs = path.join(dir, rel);
    let stat;
    try { stat = fs.lstatSync(abs); } catch { return; }
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(abs).sort()) walk(path.join(rel, name));
    } else {
      entries.push(`${rel}\t${stat.size}\t${stat.mtimeMs}`);
    }
  }
  walk('.');
  return entries.join('\n');
}

// ─── 1. Missing required arg ────────────────────────────────────────────────

test('config-get with no key fails with a typed reason and no stack trace', (t) => {
  const projectDir = createTempProject('cli-neg-config-1-');
  t.after(() => cleanup(projectDir));
  const before = snapshotInventory(projectDir);
  const result = runCli(['config-get'], { cwd: projectDir });
  assertSafeFailure(result, 'config-get missing key');
  assert.equal(snapshotInventory(projectDir), before, 'failing read must not mutate FS');
});

test('config-set with no key fails with a typed reason', (t) => {
  const projectDir = createTempProject('cli-neg-config-2-');
  t.after(() => cleanup(projectDir));
  const result = runCli(['config-set'], { cwd: projectDir });
  assertSafeFailure(result, 'config-set missing key');
});

test('config-set with key but no value fails with a typed reason', (t) => {
  const projectDir = createTempProject('cli-neg-config-3-');
  t.after(() => cleanup(projectDir));
  const result = runCli(['config-set', 'model_profile'], { cwd: projectDir });
  assertSafeFailure(result, 'config-set missing value');
});

// ─── 2/3. Empty / whitespace arg ────────────────────────────────────────────

test('config-get with empty-string key fails safely', (t) => {
  const projectDir = createTempProject('cli-neg-config-4-');
  t.after(() => cleanup(projectDir));
  const before = snapshotInventory(projectDir);
  const result = runCli(['config-get', ''], { cwd: projectDir });
  assertSafeFailure(result, 'config-get empty key');
  assert.equal(snapshotInventory(projectDir), before, 'failing read must not mutate FS');
});

test('config-get with whitespace-only key fails safely', (t) => {
  const projectDir = createTempProject('cli-neg-config-5-');
  t.after(() => cleanup(projectDir));
  const result = runCli(['config-get', '   \t  '], { cwd: projectDir });
  assertSafeFailure(result, 'config-get whitespace key');
});

test('config-set with empty key string fails safely', (t) => {
  const projectDir = createTempProject('cli-neg-config-6-');
  t.after(() => cleanup(projectDir));
  const result = runCli(['config-set', '', 'value'], { cwd: projectDir });
  assertSafeFailure(result, 'config-set empty key');
});

// ─── 4. Duplicate flags ─────────────────────────────────────────────────────

test('--cwd specified twice does not silently use the wrong one', (t) => {
  // Make two real but distinct dirs so the test can't accidentally pass
  // because one of the paths is invalid.
  const a = createTempProject('cli-neg-config-7a-');
  const b = createTempProject('cli-neg-config-7b-');
  t.after(() => { cleanup(a); cleanup(b); });
  // No --json-errors here on purpose: --cwd is parsed before json mode is
  // applied, so we exercise both code paths by running once each.
  const result = runCli(['--cwd', a, '--cwd', b, 'config-get', 'model_profile'], { cwd: process.cwd() });
  // Either: (a) the CLI rejects duplicate --cwd with a typed reason; OR
  // (b) it commits to one of the values deterministically. The safety
  // bar is "no stack trace, no half-state mutation in EITHER dir".
  assert.equal(result.hasStackTrace, false, 'duplicate --cwd must not crash with a stack trace');
  // Neither tmp dir should have a written config since model_profile is
  // a read, not a write, and it didn't exist beforehand. Prove the read
  // didn't accidentally trigger a write side effect.
  assert.equal(fs.existsSync(path.join(a, '.planning', 'config.json')), false);
  assert.equal(fs.existsSync(path.join(b, '.planning', 'config.json')), false);
});

// ─── 5. Conflicting flags ───────────────────────────────────────────────────

test('--json-errors with --no-such-flag does not crash with a stack trace', (t) => {
  const projectDir = createTempProject('cli-neg-config-8-');
  t.after(() => cleanup(projectDir));
  const result = runCli(['--no-such-flag', 'config-get', 'model_profile'], { cwd: projectDir });
  assert.equal(result.hasStackTrace, false, 'unknown global flag must not crash with a stack trace');
  assert.notEqual(result.status, 0, 'unknown global flag must fail');
});

// ─── 6. Malformed assignment / unknown subcommand ──────────────────────────

test('config-FAKE subcommand fails with a typed reason', (t) => {
  const projectDir = createTempProject('cli-neg-config-9-');
  t.after(() => cleanup(projectDir));
  const result = runCli(['config-FAKE'], { cwd: projectDir });
  assertSafeFailure(result, 'unknown config-* command');
});

// ─── 7. Unknown subcommands at each command depth ───────────────────────────

test('config family — bare top-level "config" without a subcommand fails safely', (t) => {
  const projectDir = createTempProject('cli-neg-config-10-');
  t.after(() => cleanup(projectDir));
  const result = runCli(['config'], { cwd: projectDir });
  // Either "missing subcommand" usage or genuine no-op behavior — what we
  // pin is "no stack trace, no FS mutation".
  assert.equal(result.hasStackTrace, false);
});

// ─── 8. Values that look like flags ─────────────────────────────────────────

test('config-set value that starts with -- is treated as a value, not a flag', (t) => {
  const projectDir = createTempProject('cli-neg-config-11-');
  t.after(() => cleanup(projectDir));
  // First create a config.json so the set has a target file.
  runCli(['config-ensure-section'], { cwd: projectDir });
  const result = runCli(['config-set', 'project_code', '--weird'], { cwd: projectDir });
  // Acceptable outcomes:
  //   (a) CLI accepts --weird as the value (and persists it),
  //   (b) CLI rejects it as a usage error.
  // Either way: no stack trace, no half-written corrupt config.
  assert.equal(result.hasStackTrace, false, 'value-looking-like-a-flag must not crash');
  const configPath = path.join(projectDir, '.planning', 'config.json');
  if (fs.existsSync(configPath)) {
    // If a config exists, it must still be valid JSON — no half-write corruption.
    const raw = fs.readFileSync(configPath, 'utf-8');
    assert.doesNotThrow(() => JSON.parse(raw), 'config.json must remain parseable after a failed set');
  }
});

// ─── 9. Invalid JSON / corrupt config file ──────────────────────────────────

test('config-get against a corrupt config.json fails with a parse-failed reason', (t) => {
  const projectDir = createTempProject('cli-neg-config-12-');
  t.after(() => cleanup(projectDir));
  const configPath = path.join(projectDir, '.planning', 'config.json');
  fs.writeFileSync(configPath, '{ this is not json'); // deliberate corruption
  const originalCorrupt = fs.readFileSync(configPath, 'utf-8');
  const result = runCli(['config-get', 'model_profile'], { cwd: projectDir });
  assertSafeFailure(result, 'corrupt config.json');
  // The corrupt file must remain untouched — the CLI must not "helpfully"
  // overwrite an unparseable config in the failure path.
  assert.equal(fs.readFileSync(configPath, 'utf-8'), originalCorrupt, 'corrupt file must be preserved as-is');
  // Specific reason: CONFIG_PARSE_FAILED (or equivalent) — pin this so a
  // regression where parse failure leaks as "unknown" is caught.
  assert.match(
    result.reason,
    /^(config_parse_failed|config_no_file|config_invalid_key|usage)$/,
    `parse-failure reason must be from the typed ERROR_REASON enum (got: ${result.reason})`,
  );
});

// ─── 10. Very long arg ──────────────────────────────────────────────────────

test('config-get with a very long key (50KB) fails safely without hanging', (t) => {
  const projectDir = createTempProject('cli-neg-config-13-');
  t.after(() => cleanup(projectDir));
  const longKey = 'x'.repeat(50000);
  const result = runCli(['config-get', longKey], { cwd: projectDir, timeoutMs: 8000 });
  assert.equal(result.signal, null, 'long input must not trigger the harness timeout');
  assert.equal(result.hasStackTrace, false, 'long input must not crash');
  assert.notEqual(result.status, 0, 'unknown 50KB key must fail');
});

// ─── 11. Unicode / non-ASCII ────────────────────────────────────────────────

test('config-get with a Unicode key fails safely', (t) => {
  const projectDir = createTempProject('cli-neg-config-14-');
  t.after(() => cleanup(projectDir));
  const result = runCli(['config-get', 'workflow.🔥_mode'], { cwd: projectDir });
  assertSafeFailure(result, 'unicode key');
});

test('config-set with an emoji value persists or rejects without corrupting JSON', (t) => {
  const projectDir = createTempProject('cli-neg-config-15-');
  t.after(() => cleanup(projectDir));
  runCli(['config-ensure-section'], { cwd: projectDir });
  const result = runCli(['config-set', 'project_code', '🔥👾'], { cwd: projectDir });
  assert.equal(result.hasStackTrace, false);
  // If it accepted, the JSON must round-trip cleanly.
  const configPath = path.join(projectDir, '.planning', 'config.json');
  if (result.status === 0 && fs.existsSync(configPath)) {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    assert.equal(typeof parsed, 'object', 'config.json must be a valid object');
    if (parsed.project_code != null) {
      assert.equal(typeof parsed.project_code, 'string', 'project_code must remain a string');
    }
  }
});

// ─── 12. Shell metacharacters (the security-critical case) ──────────────────

const SHELL_PAYLOADS = [
  // Each one would, if shell-interpreted, create a sentinel file
  // adjacent to the project tree. Argv-based invocation must treat them
  // as opaque text.
  '$(touch ${PROJECT}/INJ-dollar-paren)',
  '`touch ${PROJECT}/INJ-backtick`',
  '; touch ${PROJECT}/INJ-semicolon;',
  '&& touch ${PROJECT}/INJ-and',
  '|| touch ${PROJECT}/INJ-or',
  '| tee ${PROJECT}/INJ-pipe',
  '> ${PROJECT}/INJ-redirect',
  // Quote-balanced payloads — these have historically broken naive
  // shell-string composition even when the rest of the code uses argv.
  '"; touch ${PROJECT}/INJ-quote;"',
  '\'; touch ${PROJECT}/INJ-quote;\'',
];

for (const payload of SHELL_PAYLOADS) {
  test(`config-get with shell-metachar key (${payload.slice(0, 25)}…) does NOT execute the payload`, (t) => {
    const projectDir = createTempProject('cli-neg-config-shell-');
    t.after(() => cleanup(projectDir));
    const resolvedPayload = payload.replace(/\$\{PROJECT\}/g, projectDir);
    const result = runCli(['config-get', resolvedPayload], { cwd: projectDir });
    // No shell interpretation: none of the INJ-* sentinel files must
    // exist after the run. Walk the project dir and assert.
    const entries = fs.readdirSync(projectDir);
    const sentinels = entries.filter((n) => n.startsWith('INJ-'));
    assert.deepEqual(sentinels, [], `shell payload must NOT create sentinel files (found: ${sentinels.join(', ')})`);
    // The CLI may exit 0 (legitimate — the metacharacter-laden key
    // simply doesn't exist in config) or non-zero (typed reason). Both
    // are acceptable as long as no payload was executed.
    assert.equal(result.hasStackTrace, false);
  });
}

// ─── Cross-cutting: --cwd points at a non-existent path ────────────────────

test('--cwd pointing at a non-existent path fails with a typed usage reason', (_t) => {
  const nonExistent = path.join(require('os').tmpdir(), 'cli-neg-no-such-dir-' + Date.now() + '-' + Math.random());
  assert.equal(fs.existsSync(nonExistent), false, 'pre-check: path must not exist');
  const result = runCli(['--cwd', nonExistent, 'config-get', 'model_profile'], { cwd: process.cwd() });
  assert.notEqual(result.status, 0);
  assert.equal(result.hasStackTrace, false);
  // gsd-tools validates --cwd up-front and emits ERROR_REASON.USAGE.
  assert.equal(result.reason, 'usage', `expected reason=usage for invalid --cwd, got: ${result.reason}`);
});

test('--cwd with an empty value fails with a typed usage reason', () => {
  const result = runCli(['--cwd', '', 'config-get', 'model_profile'], { cwd: process.cwd() });
  assert.notEqual(result.status, 0);
  assert.equal(result.hasStackTrace, false);
  assert.equal(result.reason, 'usage');
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/feat-3593-cli-negative-harness.test.cjs — consolidation epic #1969 (B6 #1975)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:feat-3593-cli-negative-harness (consolidation epic #1969 B6 #1975)", () => {
/**
 * Meta-test for the CLI negative-matrix harness (#3593).
 *
 * The harness in `tests/helpers/cli-negative.cjs` shapes spawnSync
 * results into a typed IR that adversarial-input tests consume. This
 * file pins the IR contract by exercising the harness against
 * deliberate scenarios — not as a placeholder for the real matrix tests
 * (those live in sibling feat-3593-* files) but to surface harness
 * regressions before they cascade through every matrix test.
 *
 * Tests deliberately avoid prose-matching: they assert on numeric exit
 * codes, boolean flags, and reason codes pulled from the parsed JSON
 * payload.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runCli, parseSpawnResult } = require('./helpers/cli-negative.cjs');
const { createTempProject, cleanup } = require('./helpers.cjs');

test('runCli rejects non-array argv with TypeError', () => {
  assert.throws(
    () => runCli('config-get', { cwd: '/tmp' }),
    (err) => err instanceof TypeError && /argv/.test(err.message),
  );
});

test('runCli rejects missing cwd with TypeError', () => {
  assert.throws(
    () => runCli(['config-get'], {}),
    (err) => err instanceof TypeError && /cwd/.test(err.message),
  );
});

test('runCli surfaces typed reason from a known failure path', (t) => {
  const projectDir = createTempProject('cli-neg-harness-');
  t.after(() => cleanup(projectDir));
  // Unknown command — gsd-tools emits ERROR_REASON.SDK_UNKNOWN_COMMAND or
  // USAGE depending on dispatch depth. Either is a real reason string;
  // the contract we pin here is just "the IR carries a reason from the
  // ERROR_REASON enum, never null".
  const result = runCli(['this-command-does-not-exist'], { cwd: projectDir });
  assert.notEqual(result.status, 0, 'unknown command must exit non-zero');
  assert.equal(result.ok, false, 'JSON payload must report ok=false');
  assert.equal(typeof result.reason, 'string', 'reason must be a string from ERROR_REASON');
  assert.notEqual(result.reason, null);
  assert.notEqual(result.reason, '');
  assert.equal(result.hasStackTrace, false, 'a typed failure must NOT print a V8 stack trace');
});

test('parseSpawnResult detects stack-trace leakage in stderr', () => {
  const fakeSpawn = {
    status: 1,
    signal: null,
    stdout: '',
    stderr: 'Error: boom\n    at Object.<anonymous> (/some/file.js:10:5)\n    at Module._compile\n',
    error: null,
  };
  const ir = parseSpawnResult(fakeSpawn, { jsonErrorsRequested: false });
  assert.equal(ir.hasStackTrace, true, 'stack frames in stderr must be flagged');
  assert.equal(ir.reason, null, 'non-JSON stderr leaves reason null');
});

test('parseSpawnResult does NOT match the literal word "at" in prose', () => {
  // Guard against a regex regression that would catch sentences like
  // "command failed at startup" as stack frames.
  const fakeSpawn = {
    status: 1,
    signal: null,
    stdout: '',
    stderr: 'Error: command failed at startup\nbecause no project was found.\n',
    error: null,
  };
  const ir = parseSpawnResult(fakeSpawn, { jsonErrorsRequested: false });
  assert.equal(ir.hasStackTrace, false, 'prose containing the word "at" is not a stack frame');
});

test('parseSpawnResult extracts ok/reason/message from a json-errors payload', () => {
  const payload = { ok: false, reason: 'config_invalid_key', message: 'no such key: foo' };
  const fakeSpawn = {
    status: 1,
    signal: null,
    stdout: '',
    stderr: JSON.stringify(payload) + '\n',
    error: null,
  };
  const ir = parseSpawnResult(fakeSpawn, { jsonErrorsRequested: true });
  assert.equal(ir.ok, false);
  assert.equal(ir.reason, 'config_invalid_key');
  assert.equal(ir.message, 'no such key: foo');
  assert.equal(ir.hasStackTrace, false);
});

test('parseSpawnResult ignores malformed JSON in stderr without throwing', () => {
  const fakeSpawn = {
    status: 1,
    signal: null,
    stdout: '',
    stderr: '{ ok: false, reason }', // missing quotes — invalid JSON
    error: null,
  };
  const ir = parseSpawnResult(fakeSpawn, { jsonErrorsRequested: true });
  assert.equal(ir.ok, null, 'malformed JSON must NOT promote partial data into ok');
  assert.equal(ir.reason, null);
  assert.equal(ir.message, null);
});

test('parseSpawnResult ignores JSON arrays and primitives, only accepts objects', () => {
  const cases = [
    '["ok", false]',     // array
    '"just a string"',   // primitive
    'null',              // null literal
    '42',                // number
  ];
  for (const stderr of cases) {
    const ir = parseSpawnResult(
      { status: 1, signal: null, stdout: '', stderr, error: null },
      { jsonErrorsRequested: true },
    );
    assert.equal(ir.ok, null, `non-object JSON (${stderr}) must not set ok`);
    assert.equal(ir.reason, null);
  }
});

test('runCli treats jsonErrors=false as an explicit human-formatter path', (t) => {
  const projectDir = createTempProject('cli-neg-harness-text-');
  t.after(() => cleanup(projectDir));
  const result = runCli(['this-command-does-not-exist'], { cwd: projectDir, jsonErrors: false });
  assert.notEqual(result.status, 0);
  assert.equal(result.jsonErrorsRequested, false);
  // Reason fields stay null in human-mode because stderr is prose, not JSON.
  assert.equal(result.ok, null);
  assert.equal(result.reason, null);
  // But the prose still must not include a V8 stack trace.
  assert.equal(result.hasStackTrace, false);
});
  });
}
