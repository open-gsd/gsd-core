'use strict';

/**
 * Regression coverage for #4460 (discovered blocking this PR's own Windows
 * CI, unrelated to this PR's actual diff -- fixed inline per this repo's
 * no-defer policy): scripts/check-env.cjs's npm-version check used to
 * collapse every spawnSync failure mode into one message, "npm binary not
 * found on PATH" -- including a TIMEOUT under CI load, which looks
 * identical to a genuine ENOENT (exitCode stays non-zero, stdout stays
 * empty either way). Confirmed live, twice, on real Windows CI: the check
 * now correctly reports "timed out under CI load" for exactly that case.
 *
 * describeNpmVersionCheckFailure is the extracted, pure reason-selection
 * logic. It takes a plain result object shaped like this repo's canonical
 * OS-shell-projection seam's SpawnResultOutput (execNpm,
 * src/shell-command-projection.cts) -- same `timedOut` (error.code ===
 * 'ETIMEDOUT') semantics -- but check-env.cjs computes that shape inline
 * rather than importing the seam itself: that seam's compiled output
 * (gsd-core/bin/lib/*.cjs) does not exist yet when check-env.cjs runs as
 * its own standalone pre-`npm ci` CI step (an earlier version of this fix
 * imported it directly and crashed every real CI job with
 * MODULE_NOT_FOUND). Kept in scripts/lib/ so the wording is tested here
 * without a project directory; tests/check-env.test.cjs covers the checks.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { describeNpmVersionCheckFailure } = require('../scripts/lib/npm-version-check-diagnosis.cjs');

describe('describeNpmVersionCheckFailure (#4460)', () => {
  test('a genuine ENOENT (npm truly absent) reports the original message', () => {
    const result = { exitCode: 127, stdout: '', stderr: 'npm: not found', signal: null, error: Object.assign(new Error('spawnSync npm ENOENT'), { code: 'ENOENT' }), timedOut: false };
    assert.equal(
      describeNpmVersionCheckFailure(result),
      'npm binary not found on PATH',
    );
  });

  test('a timed-out spawn is reported as a timeout, not a missing binary', () => {
    const result = { exitCode: 1, stdout: '', stderr: '', signal: 'SIGTERM', error: Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' }), timedOut: true };
    const reason = describeNpmVersionCheckFailure(result);
    assert.match(reason, /timed out under CI load/);
    assert.doesNotMatch(reason, /^npm binary not found on PATH$/);
  });

  test('timedOut is authoritative even without an ENOENT-shaped error object', () => {
    // Mirrors what execNpm/_spawnResult actually produces for a timeout:
    // error is set (spawnSync always populates it when `timeout` fires),
    // but its code is ETIMEDOUT, not ENOENT -- timedOut is what matters.
    const result = { exitCode: 1, stdout: '', stderr: '', signal: 'SIGTERM', error: null, timedOut: true };
    assert.match(describeNpmVersionCheckFailure(result), /timed out under CI load/);
  });

  test('a non-zero exit with no stdout and no timeout is reported with the actual exit code', () => {
    const result = { exitCode: 1, stdout: '', stderr: '', signal: null, error: null, timedOut: false };
    assert.equal(
      describeNpmVersionCheckFailure(result),
      'npm --version exited 1 with no usable output',
    );
  });

  test('exitCode 0 with no stdout gets its own message, not the "not found" fallback', () => {
    // npm ran and exited cleanly but printed nothing -- distinct from every
    // other branch (all of which involve a failed/absent spawn); must not be
    // misdescribed as "not found on PATH" when the binary plainly ran.
    const result = { exitCode: 0, stdout: '', stderr: '', signal: null, error: null, timedOut: false };
    assert.equal(
      describeNpmVersionCheckFailure(result),
      'npm --version exited 0 but produced no output',
    );
  });
});
