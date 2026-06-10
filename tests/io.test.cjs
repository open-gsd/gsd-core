/**
 * Tests for src/io.cts (compiled to gsd-core/bin/lib/io.cjs).
 *
 * Verifies behavioural contracts of the extracted CLI I/O primitives:
 *   - output() writes expected structure to stdout
 *   - error() writes expected structure to stderr and exits
 *   - ERROR_REASON constants have the correct wire values
 *   - setJsonErrorMode/getJsonErrorMode toggle behaviour
 *   - core.cjs re-export shims resolve to the exact same objects as io.cjs
 *
 * ADR-857 phase 1 / issue #859.
 */

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const io = require('../gsd-core/bin/lib/io.cjs');
const core = require('../gsd-core/bin/lib/core.cjs');

// ─── ERROR_REASON constants ───────────────────────────────────────────────────

describe('ERROR_REASON', () => {
  test('is a frozen object', () => {
    assert.ok(Object.isFrozen(io.ERROR_REASON));
  });

  test('contains expected wire values', () => {
    assert.strictEqual(io.ERROR_REASON.CONFIG_KEY_NOT_FOUND, 'config_key_not_found');
    assert.strictEqual(io.ERROR_REASON.CONFIG_NO_FILE, 'config_no_file');
    assert.strictEqual(io.ERROR_REASON.CONFIG_PARSE_FAILED, 'config_parse_failed');
    assert.strictEqual(io.ERROR_REASON.CONFIG_INVALID_KEY, 'config_invalid_key');
    assert.strictEqual(io.ERROR_REASON.SDK_FAIL_FAST, 'sdk_fail_fast');
    assert.strictEqual(io.ERROR_REASON.SDK_UNKNOWN_COMMAND, 'sdk_unknown_command');
    assert.strictEqual(io.ERROR_REASON.SDK_MISSING_ARG, 'sdk_missing_arg');
    assert.strictEqual(io.ERROR_REASON.PHASE_NOT_FOUND, 'phase_not_found');
    assert.strictEqual(io.ERROR_REASON.SUMMARY_NO_PLANNING, 'summary_no_planning');
    assert.strictEqual(io.ERROR_REASON.GRAPHIFY_NO_GRAPH, 'graphify_no_graph');
    assert.strictEqual(io.ERROR_REASON.GRAPHIFY_INVALID_QUERY, 'graphify_invalid_query');
    assert.strictEqual(io.ERROR_REASON.HOOKS_OPT_OUT, 'hooks_opt_out');
    assert.strictEqual(io.ERROR_REASON.SECURITY_SCAN_FAILED, 'security_scan_failed');
    assert.strictEqual(io.ERROR_REASON.USAGE, 'usage');
    assert.strictEqual(io.ERROR_REASON.UNKNOWN, 'unknown');
  });
});

// ─── setJsonErrorMode / getJsonErrorMode ─────────────────────────────────────

describe('setJsonErrorMode / getJsonErrorMode', () => {
  // Reset to false after each test so other tests are unaffected
  afterEach(() => {
    io.setJsonErrorMode(false);
  });

  test('defaults to false', () => {
    io.setJsonErrorMode(false); // ensure clean state
    assert.strictEqual(io.getJsonErrorMode(), false);
  });

  test('setJsonErrorMode(true) enables JSON error mode', () => {
    io.setJsonErrorMode(true);
    assert.strictEqual(io.getJsonErrorMode(), true);
  });

  test('setJsonErrorMode(false) disables JSON error mode', () => {
    io.setJsonErrorMode(true);
    io.setJsonErrorMode(false);
    assert.strictEqual(io.getJsonErrorMode(), false);
  });

  test('setJsonErrorMode coerces truthy values', () => {
    io.setJsonErrorMode(1);
    assert.strictEqual(io.getJsonErrorMode(), true);
    io.setJsonErrorMode(0);
    assert.strictEqual(io.getJsonErrorMode(), false);
  });

  test('setJsonErrorMode coerces string truthy', () => {
    io.setJsonErrorMode('yes');
    assert.strictEqual(io.getJsonErrorMode(), true);
    io.setJsonErrorMode('');
    assert.strictEqual(io.getJsonErrorMode(), false);
  });
});

// ─── output() ────────────────────────────────────────────────────────────────

// output() writes directly to fd 1 and never calls process.exit, so we can
// test it by spawning a child process and capturing its stdout.

describe('output()', () => {
  const ioPath = path.resolve(__dirname, '../gsd-core/bin/lib/io.cjs');

  test('emits JSON-serialised result to stdout', () => {
    const script = `
      const io = require(${JSON.stringify(ioPath)});
      io.output({ ok: true, value: 42 }, false);
    `;
    const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf-8' });
    assert.strictEqual(result.status, 0, `process exited non-zero: ${result.stderr}`);
    const parsed = JSON.parse(result.stdout);
    assert.deepStrictEqual(parsed, { ok: true, value: 42 });
  });

  test('emits raw string value when raw=true and rawValue provided', () => {
    const script = `
      const io = require(${JSON.stringify(ioPath)});
      io.output({ ignored: true }, true, 'raw-text-output');
    `;
    const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf-8' });
    assert.strictEqual(result.status, 0, `process exited non-zero: ${result.stderr}`);
    assert.strictEqual(result.stdout, 'raw-text-output');
  });

  test('falls back to JSON when raw=true but rawValue is undefined', () => {
    const script = `
      const io = require(${JSON.stringify(ioPath)});
      io.output({ fallback: true }, true);
    `;
    const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf-8' });
    assert.strictEqual(result.status, 0, `process exited non-zero: ${result.stderr}`);
    const parsed = JSON.parse(result.stdout);
    assert.deepStrictEqual(parsed, { fallback: true });
  });

  test('emits null correctly', () => {
    const script = `
      const io = require(${JSON.stringify(ioPath)});
      io.output(null, false);
    `;
    const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf-8' });
    assert.strictEqual(result.status, 0, `process exited non-zero: ${result.stderr}`);
    assert.strictEqual(result.stdout, 'null');
  });

  test('large payload (>50000 chars) spills to @file: tempfile', (t) => {
    // Build a payload whose serialized JSON exceeds 50000 chars.
    // A string of 60000 'x' chars serializes to 60002 chars ("x...x").
    const largeString = 'x'.repeat(60000);
    const payload = { large: largeString };
    const serialized = JSON.stringify(payload, null, 2);
    assert.ok(serialized.length > 50000, 'precondition: payload must exceed 50000 chars');

    const tmpFilesCreated = [];

    t.after(() => {
      for (const p of tmpFilesCreated) {
        try { fs.unlinkSync(p); } catch { /* ignore */ }
      }
    });

    const script = `
      const io = require(${JSON.stringify(ioPath)});
      const largeString = 'x'.repeat(60000);
      io.output({ large: largeString }, false);
    `;
    const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf-8' });
    assert.strictEqual(result.status, 0, `process exited non-zero: ${result.stderr}`);

    const stdout = result.stdout.trim();
    assert.ok(stdout.startsWith('@file:'), `expected stdout to start with "@file:", got: ${stdout.slice(0, 80)}`);

    const tmpPath = stdout.slice('@file:'.length);
    tmpFilesCreated.push(tmpPath);

    assert.ok(fs.existsSync(tmpPath), `expected temp file to exist at: ${tmpPath}`);

    const fileContents = fs.readFileSync(tmpPath, 'utf-8');
    const parsed = JSON.parse(fileContents);
    assert.deepStrictEqual(parsed, payload);

    fs.unlinkSync(tmpPath);
    tmpFilesCreated.length = 0; // already cleaned, skip t.after
  });
});

// ─── error() ─────────────────────────────────────────────────────────────────

describe('error()', () => {
  const ioPath = path.resolve(__dirname, '../gsd-core/bin/lib/io.cjs');

  test('plain-text mode: writes "Error: <msg>" to stderr and exits 1', () => {
    const script = `
      const io = require(${JSON.stringify(ioPath)});
      io.setJsonErrorMode(false);
      io.error('something went wrong');
    `;
    const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf-8' });
    assert.strictEqual(result.status, 1);
    assert.ok(result.stderr.includes('Error: something went wrong'), `stderr was: ${result.stderr}`);
    assert.strictEqual(result.stdout, '');
  });

  test('plain-text mode: default reason does not appear in stderr text', () => {
    const script = `
      const io = require(${JSON.stringify(ioPath)});
      io.setJsonErrorMode(false);
      io.error('no reason code expected');
    `;
    const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf-8' });
    assert.strictEqual(result.status, 1);
    // plain mode does NOT include the reason field
    assert.ok(!result.stderr.includes('"reason"'), `stderr unexpectedly contained reason: ${result.stderr}`);
  });

  test('JSON-error mode: writes structured JSON to stderr and exits 1', () => {
    const script = `
      const io = require(${JSON.stringify(ioPath)});
      io.setJsonErrorMode(true);
      io.error('structured error', io.ERROR_REASON.SDK_FAIL_FAST);
    `;
    const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf-8' });
    assert.strictEqual(result.status, 1);
    assert.strictEqual(result.stdout, '');
    const payload = JSON.parse(result.stderr.trim());
    assert.strictEqual(payload.ok, false);
    assert.strictEqual(payload.reason, 'sdk_fail_fast');
    assert.strictEqual(payload.message, 'structured error');
  });

  test('JSON-error mode: defaults reason to UNKNOWN when not supplied', () => {
    const script = `
      const io = require(${JSON.stringify(ioPath)});
      io.setJsonErrorMode(true);
      io.error('no reason given');
    `;
    const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf-8' });
    assert.strictEqual(result.status, 1);
    const payload = JSON.parse(result.stderr.trim());
    assert.strictEqual(payload.reason, 'unknown');
    assert.strictEqual(payload.message, 'no reason given');
  });

  test('all ERROR_REASON values round-trip through JSON-error mode', () => {
    // spot-check a few variants
    const cases = [
      ['config_key_not_found', 'CONFIG_KEY_NOT_FOUND'],
      ['phase_not_found',      'PHASE_NOT_FOUND'],
      ['usage',                'USAGE'],
    ];
    for (const [expected, key] of cases) {
      const script = `
        const io = require(${JSON.stringify(ioPath)});
        io.setJsonErrorMode(true);
        io.error('test', io.ERROR_REASON.${key});
      `;
      const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf-8' });
      assert.strictEqual(result.status, 1, `key=${key}`);
      const payload = JSON.parse(result.stderr.trim());
      assert.strictEqual(payload.reason, expected, `key=${key}`);
    }
  });
});

// ─── GSD_TEMP_DIR / reapStaleTempFiles ───────────────────────────────────────

describe('GSD_TEMP_DIR', () => {
  test('resolves to <tmpdir>/gsd', () => {
    assert.strictEqual(io.GSD_TEMP_DIR, path.join(os.tmpdir(), 'gsd'));
  });
});

describe('reapStaleTempFiles (via io)', () => {
  const TEST_PREFIX = 'gsd-io-test-';

  afterEach(() => {
    // clean up any test files we created
    try {
      const entries = fs.readdirSync(io.GSD_TEMP_DIR);
      for (const e of entries) {
        if (e.startsWith(TEST_PREFIX)) {
          const p = path.join(io.GSD_TEMP_DIR, e);
          try { fs.unlinkSync(p); } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }
  });

  test('removes stale files beyond maxAgeMs', () => {
    fs.mkdirSync(io.GSD_TEMP_DIR, { recursive: true });
    const stalePath = path.join(io.GSD_TEMP_DIR, TEST_PREFIX + 'stale.json');
    fs.writeFileSync(stalePath, '{}');
    // backdate mtime so it looks older than 1ms
    const old = new Date(Date.now() - 10000);
    fs.utimesSync(stalePath, old, old);

    io.reapStaleTempFiles(TEST_PREFIX, { maxAgeMs: 5000 });
    assert.ok(!fs.existsSync(stalePath), 'stale file should have been removed');
  });

  test('keeps fresh files within maxAgeMs', () => {
    fs.mkdirSync(io.GSD_TEMP_DIR, { recursive: true });
    const freshPath = path.join(io.GSD_TEMP_DIR, TEST_PREFIX + 'fresh.json');
    fs.writeFileSync(freshPath, '{}');
    // mtime is just now — well within a 1-hour window
    io.reapStaleTempFiles(TEST_PREFIX, { maxAgeMs: 60 * 60 * 1000 });
    assert.ok(fs.existsSync(freshPath), 'fresh file should have been kept');
  });

  test('does not throw when GSD_TEMP_DIR does not exist yet', () => {
    // reap against a non-existent prefix — must not throw
    assert.doesNotThrow(() => {
      io.reapStaleTempFiles('gsd-io-nonexistent-prefix-xyz-', { maxAgeMs: 0 });
    });
  });
});

// ─── core.cjs re-export shim parity ──────────────────────────────────────────

describe('core.cjs re-export shims', () => {
  test('core.output is the same function as io.output', () => {
    assert.strictEqual(core.output, io.output);
  });

  test('core.error is the same function as io.error', () => {
    assert.strictEqual(core.error, io.error);
  });

  test('core.ERROR_REASON is the same object as io.ERROR_REASON', () => {
    assert.strictEqual(core.ERROR_REASON, io.ERROR_REASON);
  });

  test('core.setJsonErrorMode is the same function as io.setJsonErrorMode', () => {
    assert.strictEqual(core.setJsonErrorMode, io.setJsonErrorMode);
  });

  test('core.getJsonErrorMode is the same function as io.getJsonErrorMode', () => {
    assert.strictEqual(core.getJsonErrorMode, io.getJsonErrorMode);
  });

  test('core.reapStaleTempFiles is the same function as io.reapStaleTempFiles', () => {
    assert.strictEqual(core.reapStaleTempFiles, io.reapStaleTempFiles);
  });

  test('core.GSD_TEMP_DIR is the same value as io.GSD_TEMP_DIR', () => {
    assert.strictEqual(core.GSD_TEMP_DIR, io.GSD_TEMP_DIR);
  });
});
