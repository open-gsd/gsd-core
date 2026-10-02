'use strict';

/**
 * Capture what code under test writes to process.stdout / process.stderr WITHOUT swallowing node:test's
 * own report frames (#4031, #5170).
 *
 * Why: under `node --test` each test file runs in a child whose results travel to the parent as V8-serialized
 * Buffers written through `process.stdout.write`, looked up at write time. A test that replaces
 * `process.stdout.write` (t.mock.method) captures those frames too while the mock is active, and every result
 * flushed in that window never reaches the report: measured, a file of 22 tests with two stdout-mocking tests
 * reported 11, with no error and exit 0 (ci-next-health: 3 of 37, ci-pr-mergeability: 38 of 81 on CI).
 * Code under test writes STRINGS; report frames are Buffers. The mock records strings and forwards anything else
 * to the real write.
 */

/**
 * Mock `stream.write` for the lifetime of test context `t`. Returns the array the strings are pushed to.
 * @param {import('node:test').TestContext} t
 * @param {{ write: Function }} stream
 * @returns {string[]}
 */
function captureStringWrites(t, stream) {
  const sink = [];
  const original = stream.write;
  t.mock.method(stream, 'write', function captured(chunk, ...rest) {
    if (typeof chunk === 'string') {
      sink.push(chunk);
      return true;
    }
    return Reflect.apply(original, this, [chunk, ...rest]);
  });
  return sink;
}

module.exports = { captureStringWrites };
