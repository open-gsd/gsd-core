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
const { execFileSync } = require('child_process');
const os = require('os');
const { cleanup } = require('./helpers.cjs');

const GSD_TOOLS = path.join(__dirname, '..', 'gsd-core', 'bin', 'gsd-tools.cjs');

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
    return execFileSync('node', [GSD_TOOLS, ...args, '--cwd', tmpDir], {
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
  }

  function runRaw(...args) {
    return run(...args, '--raw');
  }

  function runExpectError(...args) {
    try {
      execFileSync('node', [GSD_TOOLS, ...args, '--cwd', tmpDir], {
        encoding: 'utf-8',
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      assert.fail('Expected command to exit non-zero');
    } catch (err) {
      assert.ok(err.status !== 0, 'Expected non-zero exit code');
      return err;
    }
  }

  test('absent key without --default errors', () => {
    fs.writeFileSync(path.join(planningDir, 'config.json'), '{}');
    runExpectError('config-get', 'nonexistent.key', '--raw');
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
    runExpectError('config-get', 'any.key', '--raw');
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
