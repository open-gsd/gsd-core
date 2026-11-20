'use strict';

/**
 * Regression tests for #5933: the global `--default <value>` option took the
 * next token as its value even when that token was another flag, and removed
 * it from argv before command routing. `migrate-config --default --dry-run`
 * therefore lost `--dry-run` and wrote the config.
 *
 * `--default` now refuses a missing or `--`-led value with the same usage error
 * as its siblings `--cwd`, `--project-dir` and `--pick`, before any token is
 * removed. An explicit empty string and ordinary values keep working.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTempProject, cleanup } = require('./helpers.cjs');
const { runCli } = require('./helpers/cli-negative.cjs');
const { ERROR_REASON } = require('../gsd-core/bin/lib/io.cjs');

function assertUsageRefusal(result) {
  assert.notEqual(result.status, 0, `expected a non-zero exit, got ${result.status}`);
  assert.equal(result.reason, ERROR_REASON.USAGE);
  assert.equal(result.stdout, '', 'a refused flag must print no result');
  assert.equal(result.hasStackTrace, false);
}

describe('--default refuses a missing or flag-shaped value (#5933)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject('gsd-default-5933-');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('migrate-config --default --dry-run is refused and the config is not rewritten', () => {
    const configPath = path.join(tmpDir, '.planning', 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ depth: 'comprehensive' }, null, 2), 'utf-8');
    const before = fs.readFileSync(configPath);

    const result = runCli(['migrate-config', '--default', '--dry-run'], { cwd: tmpDir });

    assertUsageRefusal(result);
    assert.deepEqual(fs.readFileSync(configPath), before, 'the config must be byte-for-byte unchanged');
  });

  for (const value of ['--foo', '--', '--dry-run']) {
    test(`config-get <absent> --default ${value} is refused`, () => {
      const result = runCli(['config-get', 'absent.key', '--default', value], { cwd: tmpDir });
      assertUsageRefusal(result);
    });
  }

  test('a bare trailing --default is refused instead of becoming an empty default', () => {
    const result = runCli(['config-get', 'absent.key', '--default'], { cwd: tmpDir });
    assertUsageRefusal(result);
  });

  test('a bare trailing --default after --raw is refused', () => {
    const result = runCli(['config-get', 'absent.key', '--raw', '--default'], { cwd: tmpDir });
    assertUsageRefusal(result);
  });
});

describe('--default keeps accepting real values (#5933)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject('gsd-default-5933-ok-');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // Boundary rows: "" (limit - 1), "x" (limit), "--x" (limit + 1, refused above
  // and in the parity block below). Single-dash and whitespace-only values are
  // values: only the `--` prefix is refused, as for the sibling options.
  // [argv value, value the JSON output decodes to (ADR 1411 encoding, unchanged)]
  const accepted = [
    ['', ''],
    ['x', 'x'],
    ['fallback', 'fallback'],
    ['null', null],
    ['[]', []],
    ['5', 5],
    ['end-of-phase', 'end-of-phase'],
    ['-x', '-x'],
    [' ', ' '],
    ['défaut', 'défaut'],
  ];

  for (const [value, decoded] of accepted) {
    test(`--raw prints ${JSON.stringify(value)} for an absent key`, () => {
      const result = runCli(['config-get', 'absent.key', '--default', value, '--raw'], { cwd: tmpDir });
      assert.equal(result.status, 0, `stderr: ${result.stderr}`);
      assert.equal(result.stdout, value);
    });

    test(`JSON output carries ${JSON.stringify(value)} for an absent key`, () => {
      const result = runCli(['config-get', 'absent.key', '--default', value], { cwd: tmpDir });
      assert.equal(result.status, 0, `stderr: ${result.stderr}`);
      assert.deepEqual(JSON.parse(result.stdout), decoded);
    });
  }
});

describe('the value-taking global options share one refusal rule (#5933)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject('gsd-global-flags-5933-');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  for (const flag of ['--cwd', '--project-dir', '--pick', '--default']) {
    test(`${flag} refuses a following --x with the usage reason`, () => {
      const result = runCli(['config-get', 'absent.key', flag, '--x'], { cwd: tmpDir });
      assertUsageRefusal(result);
    });

    test(`${flag} with no value at all is refused with the usage reason`, () => {
      const result = runCli(['config-get', 'absent.key', flag], { cwd: tmpDir });
      assertUsageRefusal(result);
    });
  }
});
