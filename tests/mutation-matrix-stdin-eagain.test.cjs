'use strict';

/**
 * tests/mutation-matrix-stdin-eagain.test.cjs
 *
 * Regression tests for the EAGAIN-resilient readStdinSync() helper added to
 * scripts/mutation-matrix.cjs (issue #1733).
 *
 * Background: On macOS, libuv sets a piped stdin fd to non-blocking mode.
 * Under heavy CI shard load a synchronous fs.readFileSync(process.stdin.fd)
 * can throw EAGAIN before the writer has filled the pipe, aborting the script
 * with status 2.  readStdinSync() retries on EAGAIN; these tests verify that
 * contract deterministically by monkeypatching fs.readSync (never via chmod /
 * permission tricks — see cross-platform IO-failure-injection convention).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const matrix = require(path.resolve(__dirname, '../scripts/mutation-matrix.cjs'));

describe('readStdinSync: EAGAIN resilience', () => {
  test('exports readStdinSync as a function', () => {
    assert.strictEqual(
      typeof matrix.readStdinSync,
      'function',
      'mutation-matrix.cjs must export readStdinSync'
    );
  });

  test('retries on EAGAIN then returns the full payload', () => {
    // Arrange: stub fs.readSync driven by a closure counter.
    //   Call 1  → throw EAGAIN  (simulates non-blocking pipe not ready)
    //   Call 2  → write payload into buffer, return byte length
    //   Call 3+ → return 0  (clean EOF)
    const payload = 'src/core-utils.cts\nsrc/adr-parser.cts\n';
    const payloadBuf = Buffer.from(payload, 'utf8');
    let callCount = 0;

    const origReadSync = fs.readSync;
    try {
      fs.readSync = (fd, buf, offset, _length, _position) => {
        callCount++;
        if (callCount === 1) {
          throw Object.assign(new Error('EAGAIN: resource temporarily unavailable'), { code: 'EAGAIN' });
        }
        if (callCount === 2) {
          payloadBuf.copy(buf, offset, 0, payloadBuf.length);
          return payloadBuf.length;
        }
        // Call 3+: EOF
        return 0;
      };

      const result = matrix.readStdinSync();

      assert.strictEqual(
        result,
        payload,
        'readStdinSync must return the full payload after retrying the EAGAIN'
      );
      assert.ok(
        callCount >= 3,
        `expected at least 3 fs.readSync calls (EAGAIN + data + EOF), got ${callCount}`
      );
    } finally {
      fs.readSync = origReadSync;
    }
  });

  test('non-EAGAIN errors propagate (are not swallowed)', () => {
    // Arrange: stub fs.readSync to throw a non-retryable error.
    const origReadSync = fs.readSync;
    try {
      fs.readSync = () => {
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      };

      assert.throws(
        () => matrix.readStdinSync(),
        (err) => {
          assert.strictEqual(err.code, 'EACCES');
          return true;
        },
        'readStdinSync must rethrow non-EAGAIN errors'
      );
    } finally {
      fs.readSync = origReadSync;
    }
  });
});
