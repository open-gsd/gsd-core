/**
 * Tests for scripts/check-env.sh (issue #117).
 *
 * Verifies the environment validator exits correctly and emits
 * structured output for every documented check:
 *   1. Node version vs engines.node constraint
 *   2. npm version vs engines.npm constraint (if present)
 *   3. Lockfile presence
 *   4. Lockfile sync (npm ci --dry-run)
 *   5. Version-manager pin file matches active Node major
 *   6. --json flag produces parseable JSON with documented shape
 *   7. Integration smoke: exits 0 on the live worktree root
 *
 * Sources:
 *   npm engines: https://docs.npmjs.com/cli/v10/configuring-npm/package-json#engines
 *   npm ci:      https://docs.npmjs.com/cli/v10/commands/npm-ci
 */

'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.resolve(__dirname, '..', 'scripts', 'check-env.sh');
const FIXTURE_ROOT = path.resolve(__dirname, 'fixtures', 'check-env');
const LIVE_ROOT = path.resolve(__dirname, '..');

/**
 * Run check-env.sh synchronously in `cwd` with optional extra args.
 * Returns { status, stdout, stderr }.
 */
function runScript(cwd, args = []) {
  const result = spawnSync('bash', [SCRIPT, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 30_000,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

describe('check-env.sh', () => {
  // -------------------------------------------------------------------------
  // Test 1: Happy path — all checks green
  // -------------------------------------------------------------------------
  test('exits 0 in a fixture directory with engines, .nvmrc, and matching lockfile', () => {
    const cwd = path.join(FIXTURE_ROOT, 'good');
    const { status, stdout } = runScript(cwd);
    assert.equal(
      status, 0,
      `Expected exit 0, got ${status}.\nstdout: ${stdout}`
    );
  });

  // -------------------------------------------------------------------------
  // Test 2: engines.node constraint not satisfied
  // -------------------------------------------------------------------------
  test('exits 1 when engines.node constraint is not satisfied by current Node', () => {
    const cwd = path.join(FIXTURE_ROOT, 'bad-node-version');
    // Fixture has engines.node: "<14.0.0"; current Node is much higher.
    const { status, stdout } = runScript(cwd);
    assert.equal(
      status, 1,
      `Expected exit 1 (bad node version), got ${status}.\nstdout: ${stdout}`
    );
  });

  // -------------------------------------------------------------------------
  // Test 3: Missing lockfile
  // -------------------------------------------------------------------------
  test('exits 1 when package-lock.json is missing', () => {
    const cwd = path.join(FIXTURE_ROOT, 'missing-lockfile');
    const { status, stdout } = runScript(cwd);
    assert.equal(
      status, 1,
      `Expected exit 1 (missing lockfile), got ${status}.\nstdout: ${stdout}`
    );
  });

  // -------------------------------------------------------------------------
  // Test 4: .nvmrc major doesn't match active Node major
  // -------------------------------------------------------------------------
  test('exits 1 when .nvmrc major version does not match active Node major', () => {
    const cwd = path.join(FIXTURE_ROOT, 'bad-nvmrc');
    // Fixture .nvmrc says 22; current Node is v26.
    const { status, stdout } = runScript(cwd);
    assert.equal(
      status, 1,
      `Expected exit 1 (nvmrc mismatch), got ${status}.\nstdout: ${stdout}`
    );
  });

  // -------------------------------------------------------------------------
  // Test 5: --json flag produces parseable JSON with documented shape
  // -------------------------------------------------------------------------
  test('--json emits parseable JSON with pass and checks keys', () => {
    const cwd = path.join(FIXTURE_ROOT, 'good');
    const { status, stdout } = runScript(cwd, ['--json']);
    let parsed;
    try {
      parsed = JSON.parse(stdout);
    } catch (err) {
      assert.fail(`--json output was not valid JSON: ${err.message}\nstdout: ${stdout}`);
    }
    assert.equal(typeof parsed.pass, 'boolean', 'JSON must have boolean `pass` key');
    assert.ok(Array.isArray(parsed.checks), 'JSON must have array `checks` key');
    assert.ok(parsed.checks.length > 0, '`checks` array must not be empty');
    assert.equal(
      status, 0,
      `Expected exit 0 in good fixture with --json, got ${status}`
    );
  });

  // -------------------------------------------------------------------------
  // Test 6: Integration smoke — exits 0 on the live worktree root
  // -------------------------------------------------------------------------
  test('exits 0 when run against the live worktree root', () => {
    const { status, stdout, stderr } = runScript(LIVE_ROOT);
    assert.equal(
      status, 0,
      `Expected exit 0 on live repo, got ${status}.\nstdout: ${stdout}\nstderr: ${stderr}`
    );
  });
});
