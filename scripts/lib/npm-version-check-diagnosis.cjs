'use strict';

/**
 * #4460: distinguishes WHY scripts/check-env.cjs's npm-version check's
 * spawnSync(npmCmd, ['--version'], ...) produced no usable output, instead
 * of collapsing every case into "npm binary not found on PATH" -- a
 * message that used to fire identically for a genuinely-missing binary AND
 * for a spawnSync TIMEOUT under CI load (exitCode stays non-zero, stdout
 * stays empty, either way). Root-caused live: an unrelated PR's Windows CI
 * shard failed this check twice in a row while running ~51 concurrent test
 * files; npm.cmd's own cold-start plausibly exceeded the check's original
 * 10s window under that contention, and the misleading message made a real
 * timeout indistinguishable from npm actually being absent.
 *
 * Expects `result.timedOut` to already be computed the same way this
 * repo's canonical OS-shell-projection seam (execNpm / isSpawnTimeout,
 * src/shell-command-projection.cts) computes it: `error.code ===
 * 'ETIMEDOUT'`, which Node's spawnSync guarantees when its own `timeout`
 * option fires. NOT imported directly here -- check-env.cjs deliberately
 * cannot depend on that seam's compiled output (gsd-core/bin/lib/*.cjs), a
 * tsc build artifact that does not exist yet when check-env.cjs runs as its
 * own standalone pre-`npm ci` CI step (confirmed live: an earlier version
 * of this fix routed through execNpm directly and crashed every real CI
 * job with MODULE_NOT_FOUND) -- so the same ETIMEDOUT check is computed
 * inline in check-env.cjs instead. Checking `result.signal === 'SIGTERM'`
 * directly (what an earlier version of this fix did) is platform-fragile
 * per that seam's own documented reasoning, with a specifically-called-out
 * risk of a false NEGATIVE on Windows -- the exact platform this failure
 * was discovered on.
 *
 * Kept in its own module so the wording can be tested without a project
 * directory. scripts/check-env.cjs is itself importable (#6375): it runs its
 * CLI only as the entry script.
 *
 * @param {{exitCode: number, stdout: string, signal: string|null, error: (Error & {code?: string})|null, timedOut: boolean}} result
 * @returns {string}
 */
function describeNpmVersionCheckFailure(result) {
  if (result.error && result.error.code === 'ENOENT') {
    return 'npm binary not found on PATH';
  }
  if (result.timedOut) {
    return `npm --version timed out under CI load -- not a missing binary`;
  }
  if (result.exitCode !== 0) {
    return `npm --version exited ${result.exitCode} with no usable output`;
  }
  if (result.exitCode === 0) {
    // npm ran and exited cleanly but printed nothing -- distinct from every
    // case above (which all involve a failed/absent spawn), so it gets its
    // own message rather than falling through to "not found on PATH", which
    // would misdescribe a real npm binary that simply produced no output.
    return 'npm --version exited 0 but produced no output';
  }
  return 'npm binary not found on PATH';
}

module.exports = { describeNpmVersionCheckFailure };
