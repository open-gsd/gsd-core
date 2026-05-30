// allow-test-rule: integration-test-input
// The script under test (scripts/release-tarball-smoke.cjs) is the system
// under test. We exercise it via its exported pure function, not by reading
// source text. The tarball fixture is produced by npm pack in before().

'use strict';

process.env.GSD_TEST_MODE = '1';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { cleanup, createTempDir, runNpm, isolatedNpmEnv } = require('./helpers.cjs');
const { SMOKE, runSmoke } = require('../scripts/release-tarball-smoke.cjs');

const smokeMsg = (label, result) =>
  `${label}: code=${result.code} details=${JSON.stringify(result.details)}`;

const PKG_PATH = path.join(__dirname, '..', 'package.json');
const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf-8'));

describe('release-tarball-smoke', () => {
  // Shared fixture state: pack the tarball once, install it once, reuse for all tests.
  let packDir;
  let installPrefix;
  let tarballPath;
  // fixtureDir for lifecycle / init tests; created once in before(), cleaned in after().
  let fixtureDir;

  before(async () => {
    // Pack once into a temp dir.
    packDir = createTempDir('gsd-smoke-pack-');
    installPrefix = createTempDir('gsd-smoke-prefix-');
    fixtureDir = createTempDir('gsd-smoke-fixture-');

    // npm pack + npm install -g on a large tarball (1499 files, ~10 MB) can take
    // 3–6 minutes on slow Docker hosts (cold disk, constrained CPU). The runNpm
    // default timeout of 180 s is sufficient on fast machines but insufficient on
    // cartographer-class hosts. 600 s (10 min) gives a safe ceiling without
    // masking genuine hangs.
    const SLOW_HOST_TIMEOUT = 600_000;

    const packOutput = runNpm(
      ['pack', '--pack-destination', packDir],
      { cwd: path.join(__dirname, '..'), timeout: SLOW_HOST_TIMEOUT },
    );

    // npm pack prints the filename as the last line of stdout.
    const lines = packOutput.split(/\r?\n/).filter(Boolean);
    const tgzName = lines[lines.length - 1];
    tarballPath = path.join(packDir, tgzName);
    if (!fs.existsSync(tarballPath)) {
      const found = fs.readdirSync(packDir).find((f) => f.endsWith('.tgz'));
      if (!found) throw new Error(`npm pack produced no .tgz in ${packDir}; output: ${packOutput}`);
      tarballPath = path.join(packDir, found);
    }

    // Install once into installPrefix. All tests share this install.
    runNpm(['install', '-g', '--prefix', installPrefix, tarballPath], { timeout: SLOW_HOST_TIMEOUT });
  });

  after(() => {
    cleanup(packDir);
    cleanup(installPrefix);
    cleanup(fixtureDir);
  });

  // ── Test A — happy path ────────────────────────────────────────────────────
  test('A: happy path — installed version matches package.json', () => {
    const result = runSmoke({
      tarballPath,
      installPrefix,
      expectedVersion: pkg.version,
      fixtureDir,
      npmEnv: isolatedNpmEnv(),
    });

    assert.equal(result.code, SMOKE.OK, smokeMsg('A', result));
    assert.equal(result.details.version, pkg.version, smokeMsg('A', result));
  });

  // ── Test B — version mismatch detected ────────────────────────────────────
  test('B: version mismatch detected — returns VERSION_MISMATCH', () => {
    const result = runSmoke({
      tarballPath,
      installPrefix,
      expectedVersion: '99.99.99',
      fixtureDir,
      npmEnv: isolatedNpmEnv(),
    });

    assert.equal(result.code, SMOKE.VERSION_MISMATCH, smokeMsg('B', result));
  });

  // ── Test C — happy lifecycle ───────────────────────────────────────────────
  // Verifies that the installed package has all expected command .md files and
  // that each command resolves a workflow .md file that also exists.
  // Also verifies that `gsd-core --local --claude` (init) succeeds in
  // the fixtureDir and creates the expected .claude/ directories.
  test('C: happy lifecycle — command + workflow files resolve OK', () => {
    const result = runSmoke({
      tarballPath,
      installPrefix,
      expectedVersion: pkg.version,
      fixtureDir,
      lifecycleCommands: ['init', 'discuss-phase', 'plan-phase'],
      npmEnv: isolatedNpmEnv(),
    });

    assert.equal(result.code, SMOKE.OK, smokeMsg('C', result));

    // Each non-init command must be in lifecycleResolved with both paths populated
    const resolved = result.details.lifecycleResolved;
    assert.ok(Array.isArray(resolved));

    for (const entry of resolved) {
      assert.ok(
        typeof entry.commandPath === 'string' && entry.commandPath.length > 0,
        `expected commandPath for ${entry.command}`,
      );
      assert.ok(
        fs.existsSync(entry.commandPath) && fs.statSync(entry.commandPath).isFile(),
        `commandPath must be an existing file: ${entry.commandPath}`,
      );
      assert.ok(
        typeof entry.workflowPath === 'string' && entry.workflowPath.length > 0,
        `expected workflowPath for ${entry.command}`,
      );
      assert.ok(
        fs.existsSync(entry.workflowPath) && fs.statSync(entry.workflowPath).isFile(),
        `workflowPath must be an existing file: ${entry.workflowPath}`,
      );
    }
  });

  // ── Test D — missing command detected ─────────────────────────────────────
  // Passes a nonexistent command name; expects the smoke to detect the missing
  // command .md file and return COMMAND_FILE_MISSING with the right details.
  test('D: missing command detected — returns COMMAND_FILE_MISSING', () => {
    const result = runSmoke({
      tarballPath,
      installPrefix,
      expectedVersion: pkg.version,
      fixtureDir,
      lifecycleCommands: ['init', 'nonexistent-phase-xyz'],
      npmEnv: isolatedNpmEnv(),
    });

    assert.equal(result.code, SMOKE.COMMAND_FILE_MISSING, smokeMsg('D', result));
    assert.equal(result.details.command, 'nonexistent-phase-xyz', smokeMsg('D', result));
    assert.ok(typeof result.details.path === 'string' && result.details.path.length > 0, smokeMsg('D', result));
  });

  // ── Test E — workflow-body checks run (informational) ─────────────────────
  // Asserts that the workflow-body scanning machinery ran (structural assertion).
  // Does NOT assert colonLeakCount is zero — when those issues are fixed, this
  // test continues to pass unchanged.
  test('E: workflow-body checks run — scan counts are present integers', () => {
    const result = runSmoke({
      tarballPath,
      installPrefix,
      expectedVersion: pkg.version,
      fixtureDir,
      lifecycleCommands: [],
      npmEnv: isolatedNpmEnv(),
    });

    // Structural: the scan ran and populated the counters
    assert.ok(
      Number.isInteger(result.details.workflowsScanned) && result.details.workflowsScanned >= 1,
      smokeMsg('E', result),
    );
    assert.ok(
      Number.isInteger(result.details.colonLeakCount),
      smokeMsg('E', result),
    );
  });
});
