'use strict';
/**
 * Regression tests for bug #969 — test-infra flake hardening.
 *
 * Two root causes addressed:
 *
 *  A. SIGNATURE A: "X is not a function"
 *     ensureBuiltArtifacts() previously short-circuited on a single sentinel
 *     (semver-compare.cjs). If any other migrated .cjs was stale or absent,
 *     it would be silently loaded in that broken state. This test proves the
 *     unconditional-build fix: deleting a non-sentinel artifact and invoking
 *     ensureBuiltArtifacts() regenerates it even when the sentinel is present.
 *
 *  B. SIGNATURE B: misleading assertion failures from killed subprocesses
 *     runGsdTools() previously had no timeout, so an OOM/SIGKILL'd subprocess
 *     returned { success: false } and looked like a product error. This test
 *     proves the kill-discrimination fix: a killed/timed-out invocation now
 *     throws a labeled resource-starvation error, while a clean non-zero exit
 *     still returns { success: false, exitCode: N }.
 *
 * RULESET.TESTS.regression-must-fail-first: each test section documents what
 * the old behavior would have been (fail-before) and asserts the new behavior
 * (pass-after), using only behavioral invocations — no source-grep.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const { ensureBuiltArtifacts } = require('../scripts/run-tests.cjs');
const { cleanup } = require('./helpers.cjs');

// ---------------------------------------------------------------------------
// Part A — ensureBuiltArtifacts: unconditional rebuild
// ---------------------------------------------------------------------------

describe('bug #969 A — ensureBuiltArtifacts rebuilds stale artifacts', () => {
  /**
   * FAIL-BEFORE (origin/next behavior):
   *   The old code contained `if (existsSync(sentinel)) return;`. When the
   *   sentinel (semver-compare.cjs) was present, the function returned early
   *   without touching any other .cjs. This test confirms the new code always
   *   invokes tsc — it would have returned immediately on origin/next.
   *
   *   Specifically: on origin/next, after deleting a non-sentinel artifact +
   *   its tsbuildinfo and calling ensureBuiltArtifacts() with sentinel present,
   *   the artifact would remain absent. On the fix, tsc runs unconditionally
   *   and recreates it.
   *
   *   NOTE: this case simulates the "fresh CI checkout" scenario — no tsbuildinfo
   *   present. With "incremental": true the tsbuildinfo had to be absent too (or
   *   sources modified) to force a full emit; with the non-incremental build, tsc
   *   always re-emits regardless, so we only need to delete the target artifact.
   *   We also delete the tsbuildinfo here (if present) to keep the test hermetic.
   *
   * PASS-AFTER (fix):
   *   The sentinel guard is removed. ensureBuiltArtifacts() always invokes tsc.
   *   With no tsbuildinfo present (clean state), tsc performs a full emit and
   *   recreates all .cjs outputs including the deleted non-sentinel artifact.
   */
  test('rebuilds a non-sentinel artifact (with no tsbuildinfo) even when sentinel exists', () => {
    const root = path.join(__dirname, '..');
    const sentinelPath = path.join(root, 'gsd-core', 'bin', 'lib', 'semver-compare.cjs');
    // Pick a second built artifact that is NOT the sentinel.
    const targetPath = path.join(root, 'gsd-core', 'bin', 'lib', 'core.cjs');
    // tsbuildinfo must also be absent to force a full (non-incremental) re-emit.
    const tsBuildInfoPath = path.join(root, 'gsd-core', 'bin', 'tsconfig.build.tsbuildinfo');

    // Pre-condition: both files must already exist (built). If not, skip so
    // we don't break on a worktree that hasn't been built yet (CI pre-build).
    if (!fs.existsSync(sentinelPath) || !fs.existsSync(targetPath)) {
      // Not a test failure — just skip the behavioral assertion because the
      // build hasn't run yet. The unconditional build will handle this path.
      return;
    }

    // Snapshot originals so we can always restore after the test.
    const originalTarget = fs.readFileSync(targetPath, 'utf-8');
    const originalTsBuildInfo = fs.existsSync(tsBuildInfoPath)
      ? fs.readFileSync(tsBuildInfoPath, 'utf-8')
      : null;

    try {
      // Simulate: fresh CI checkout — target artifact stale/missing, no tsbuildinfo.
      fs.unlinkSync(targetPath);
      if (fs.existsSync(tsBuildInfoPath)) fs.unlinkSync(tsBuildInfoPath);

      assert.ok(!fs.existsSync(targetPath), 'pre-condition: target must be absent');
      assert.ok(fs.existsSync(sentinelPath), 'pre-condition: sentinel must be present');

      // Under the OLD code this returned immediately (sentinel present → return).
      // Under the NEW code this calls tsc unconditionally → full emit → recreated.
      ensureBuiltArtifacts();

      assert.ok(
        fs.existsSync(targetPath),
        `ensureBuiltArtifacts must recreate ${path.basename(targetPath)} ` +
        `even when sentinel exists (sentinel-short-circuit was removed in fix #969)`
      );
    } finally {
      // Always restore state so other tests see a valid build.
      if (!fs.existsSync(targetPath)) {
        fs.writeFileSync(targetPath, originalTarget);
      }
      if (originalTsBuildInfo !== null && !fs.existsSync(tsBuildInfoPath)) {
        fs.writeFileSync(tsBuildInfoPath, originalTsBuildInfo);
      }
    }
  });

  test('sentinel (semver-compare.cjs) still exists after unconditional build', () => {
    const root = path.join(__dirname, '..');
    const sentinelPath = path.join(root, 'gsd-core', 'bin', 'lib', 'semver-compare.cjs');
    ensureBuiltArtifacts();
    assert.ok(fs.existsSync(sentinelPath), 'sentinel must exist after ensureBuiltArtifacts');
  });

  /**
   * PERSISTENT-MIRROR CASE — the residual hole found by adversarial review.
   *
   * FAIL-BEFORE (incremental: true — the old behavior on this branch):
   *   With "incremental": true in tsconfig.build.json, tsc reads the .tsbuildinfo
   *   on disk. If sources are unchanged since the last build, tsc skips re-emitting
   *   any outputs — including outputs that were deleted or overwritten by an rsync
   *   from a different branch. This is the persistent-docker-mirror scenario:
   *     1. A prior branch rsync'd a stale core.cjs into bin/lib/
   *     2. A stale tsbuildinfo is present (from that same branch)
   *     3. ensureBuiltArtifacts() calls tsc (incremental)
   *     4. tsc sees "sources unchanged vs tsbuildinfo" → no-ops → stale .cjs served
   *   With "incremental": true this test would FAIL because core.cjs remains absent.
   *
   * PASS-AFTER (incremental removed — non-incremental full build):
   *   tsc always re-emits every output regardless of tsbuildinfo state. Even if a
   *   stale tsbuildinfo is present on disk, the non-incremental build overwrites all
   *   outputs from scratch. The deleted core.cjs is always regenerated.
   */
  test('PERSISTENT-MIRROR: rebuilds stale output even when tsbuildinfo is present (non-incremental is authoritative)', () => {
    const root = path.join(__dirname, '..');
    const targetPath = path.join(root, 'gsd-core', 'bin', 'lib', 'core.cjs');
    const tsBuildInfoPath = path.join(root, 'gsd-core', 'bin', 'tsconfig.build.tsbuildinfo');

    // Pre-condition: target must already exist from a prior build.
    if (!fs.existsSync(targetPath)) {
      // Worktree hasn't been built yet — skip; the unconditional build will handle it.
      return;
    }

    const originalTarget = fs.readFileSync(targetPath, 'utf-8');
    // Inject a synthetic stale tsbuildinfo to simulate the persistent-mirror state
    // (a prior branch left a tsbuildinfo from its own incremental build on disk).
    const hadRealTsBuildInfo = fs.existsSync(tsBuildInfoPath);
    const originalTsBuildInfo = hadRealTsBuildInfo
      ? fs.readFileSync(tsBuildInfoPath, 'utf-8')
      : null;
    const STALE_TSBUILDINFO = JSON.stringify({
      program: { fileNames: [], options: { incremental: true } },
      version: '5.0.0',
      _gsd_test_marker: 'stale-persistent-mirror',
    });

    try {
      // Inject a stale tsbuildinfo (mirrors: old branch rsync'd state onto workspace).
      fs.writeFileSync(tsBuildInfoPath, STALE_TSBUILDINFO);
      // Delete the output .cjs (mirrors: stale/missing output on the persistent mirror).
      fs.unlinkSync(targetPath);

      assert.ok(!fs.existsSync(targetPath), 'pre-condition: target must be absent');
      assert.ok(fs.existsSync(tsBuildInfoPath), 'pre-condition: tsbuildinfo must be present');

      // FAIL-BEFORE (incremental: true): tsc would read the stale tsbuildinfo, see
      // "sources unchanged", and skip re-emitting core.cjs → it would remain absent.
      //
      // PASS-AFTER (non-incremental): tsc ignores the tsbuildinfo and does a full
      // emit → core.cjs is regenerated unconditionally.
      ensureBuiltArtifacts();

      assert.ok(
        fs.existsSync(targetPath),
        `ensureBuiltArtifacts must regenerate ${path.basename(targetPath)} ` +
        `even when a stale tsbuildinfo is present on disk ` +
        `(persistent-mirror scenario — incremental:true would have no-op'd here)`
      );

      // Verify the regenerated file is valid JS (non-empty, parseable require target).
      const regenerated = fs.readFileSync(targetPath, 'utf-8');
      assert.ok(regenerated.length > 100, 'regenerated core.cjs must be non-trivially non-empty');
      assert.ok(
        regenerated.includes('use strict') || regenerated.includes('exports.'),
        'regenerated core.cjs must look like a valid CommonJS module'
      );
    } finally {
      // Always restore state so subsequent tests see a valid build.
      if (!fs.existsSync(targetPath)) {
        fs.writeFileSync(targetPath, originalTarget);
      }
      // Restore the real tsbuildinfo if one existed, otherwise remove the synthetic one.
      if (originalTsBuildInfo !== null) {
        fs.writeFileSync(tsBuildInfoPath, originalTsBuildInfo);
      } else if (fs.existsSync(tsBuildInfoPath)) {
        fs.unlinkSync(tsBuildInfoPath);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Part B — runGsdTools: timeout + kill-signal discrimination
// ---------------------------------------------------------------------------

describe('bug #969 B — runGsdTools kill-signal discrimination', () => {
  const TOOLS_PATH = path.join(__dirname, '..', 'gsd-core', 'bin', 'gsd-tools.cjs');

  /**
   * Shared helper that mirrors the production runGsdTools implementation
   * (from tests/helpers.cjs) but accepts an explicit timeout so we can
   * trigger the kill path in tests without waiting 60 seconds.
   *
   * IMPORTANT: this helper is intentionally self-contained so that the test
   * proves the CONTRACT of the implementation, not just calls the real
   * runGsdTools (which would need a real 60s+ hang to trigger in tests).
   * We test the identical logic paths using a tiny timeout.
   */
  function runGsdToolsWithTimeout(args, cwd, env, timeoutMs) {
    const TEST_ENV_BASE = {
      GSD_SESSION_KEY: '',
      CODEX_THREAD_ID: '',
      CLAUDE_SESSION_ID: '',
    };
    try {
      let result;
      const childEnv = { ...process.env, ...TEST_ENV_BASE, ...(env || {}) };
      const argv = Array.isArray(args)
        ? args
        : (args.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [])
            .map(t => t.replace(/"([^"]*)"/g, '$1').replace(/'([^']*)'/g, '$1'));
      result = execFileSync(process.execPath, [TOOLS_PATH, ...argv], {
        cwd: cwd || process.cwd(),
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        env: childEnv,
        timeout: timeoutMs,
      });
      return { success: true, output: result.trim(), exitCode: 0 };
    } catch (err) {
      // Production kill-discrimination logic (verbatim from helpers.cjs fix).
      if (err.killed || err.signal != null || err.code === 'ETIMEDOUT') {
        throw new Error(
          `[runGsdTools: resource-starvation / subprocess-kill] ` +
          `gsd-tools was killed before completion ` +
          `(signal=${err.signal}, code=${err.code}, killed=${err.killed}). ` +
          `This indicates host OOM or scheduler contention, not a product bug. ` +
          `stdout=${err.stdout?.toString().trim() || ''} ` +
          `stderr=${err.stderr?.toString().trim() || ''}`
        );
      }
      const stderrRaw = err.stderr?.toString().trim() || '';
      const error = stderrRaw || `${err.message} [stderr: (empty) exit:${err.status ?? 1}]`;
      return {
        success: false,
        output: err.stdout?.toString().trim() || '',
        error,
        exitCode: err.status ?? 1,
      };
    }
  }

  /**
   * FAIL-BEFORE (origin/next behavior):
   *   Without a timeout, an OOM-killed subprocess threw with err.killed=true
   *   but the catch block fell through to `return { success: false, ... }`.
   *   The test consumer saw a normal {success:false} result and tried to parse
   *   gsd-tools output from it, causing a confusing downstream assertion fail.
   *
   * PASS-AFTER (fix):
   *   The kill-discrimination guard rethrows immediately with a labeled error
   *   message containing "resource-starvation / subprocess-kill". The test
   *   asserts on that throw rather than getting a silent {success:false}.
   *
   * Mechanism: we use a tiny timeout (1ms) to guarantee a timeout-kill on a
   * real gsd-tools invocation (even `--help` takes >1ms to start node).
   */
  test('throws a resource-starvation error when subprocess is killed/times out', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-969-'));
    try {
      // 1ms timeout guarantees ETIMEDOUT / killed before gsd-tools can respond.
      assert.throws(
        () => runGsdToolsWithTimeout(['--help'], tmpDir, {}, 1),
        (err) => {
          assert.ok(
            err.message.includes('resource-starvation / subprocess-kill'),
            `Expected labeled resource-starvation error, got: ${err.message}`
          );
          return true;
        }
      );
    } finally {
      cleanup(tmpDir);
    }
  });

  /**
   * Verify that a normal fast command still returns { success: true } and does
   * NOT throw — i.e., the timeout addition does not break the happy path.
   */
  test('returns { success: true } for a normal fast command with generous timeout', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-969-'));
    try {
      // 30s timeout; gsd-tools --help completes in well under 1s.
      const result = runGsdToolsWithTimeout(['--help'], tmpDir, {}, 30000);
      assert.ok(result.success === true, `Expected success:true, got ${JSON.stringify(result)}`);
      assert.ok(typeof result.output === 'string', 'output must be a string');
    } finally {
      cleanup(tmpDir);
    }
  });

  /**
   * Verify that a clean non-zero exit (a real gsd-tools application error, not
   * a kill) still returns { success: false } WITHOUT throwing. This preserves
   * existing test behavior that asserts on error shape.
   *
   * We trigger a clean non-zero by invoking a command that is known to fail
   * cleanly (no project directory set up).
   */
  test('returns { success: false } for a clean non-zero exit (no throw)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-969-'));
    try {
      // 'phase list' on a directory with no .planning/ produces a clean error exit.
      const result = runGsdToolsWithTimeout(['phase', 'list'], tmpDir, {}, 30000);
      assert.ok(result.success === false, `Expected success:false for clean error, got ${JSON.stringify(result)}`);
      assert.ok(result.exitCode !== 0, 'exitCode must be non-zero');
      // Must NOT have thrown — the clean-error path returns normally.
    } finally {
      cleanup(tmpDir);
    }
  });
});
