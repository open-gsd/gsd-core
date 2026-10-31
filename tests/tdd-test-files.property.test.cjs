'use strict';

/**
 * Property-based tests for the #5181 test-file matcher
 *
 * Module: gsd-core/bin/lib/tdd-test-files.cjs (built from src/tdd-test-files.cts)
 * `stripGlobDepthPrefix` is module-private, so it is driven through the public
 * `isTestFilePath`, with samples from the shared SAMPLES_BY_SPEC.
 *
 * Properties tested:
 *   (a) separator invariance: `/` and `\` spell the same path
 *   (b) depth invariance: an instance of every pathspec stays a test file under any
 *       number of non-test parent directories (0, 1, 2, ... deep)
 *   (c) the `:(glob)**\/` prefix is stripped exactly: paths built only from non-test
 *       names are never test files, and `test_*.py` is a basename match, not a directory one
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('./helpers/fast-check-setup.cjs');
const { isTestFilePath } = require('../gsd-core/bin/lib/tdd-test-files.cjs');
const { SAMPLES_BY_SPEC } = require('./helpers/tdd-test-paths.cjs');

// A directory segment that is not a test directory name (`test`, `tests`, `__tests__`).
const filler = fc.stringMatching(/^[a-z]{1,8}$/).filter((s) => s !== 'test' && s !== 'tests');
const fillers = fc.array(filler, { maxLength: 4 });
// Every shared sample of every pathspec, flattened; the owner is tests/helpers/tdd-test-paths.cjs.
const samples = Object.entries(SAMPLES_BY_SPEC).flatMap(([spec, paths]) => paths.map((path) => [spec, path]));

describe('#5181 tdd-test-files matcher properties', () => {
  test('(a) separator invariance', () => {
    const segment = fc.oneof(filler, fc.constantFrom('tests', '__tests__', 'test_a.py', 'a.test.js', 'x.js'));
    fc.assert(fc.property(fc.array(segment, { minLength: 1, maxLength: 5 }), (segments) => {
      assert.equal(isTestFilePath(segments.join('/')), isTestFilePath(segments.join('\\')));
    }));
  });

  test('(b) depth invariance: every pathspec instance is a test file at any depth', () => {
    fc.assert(fc.property(fc.constantFrom(...samples), fillers, ([spec, sample], parents) => {
      const p = [...parents, sample].join('/');
      assert.equal(isTestFilePath(p), true, `${p} (from ${spec}) must be a test file`);
    }));
  });

  test('(c) the depth prefix is stripped exactly', () => {
    fc.assert(fc.property(fillers, filler, (parents, name) => {
      const p = [...parents, `${name}.js`].join('/');
      assert.equal(isTestFilePath(p), false, `${p} must not be a test file`);
    }));
    // `:(glob)**/test_*.py` is a basename match: a `test_`-prefixed directory is not a test.
    fc.assert(fc.property(fillers, filler, filler, (parents, dir, name) => {
      const p = [...parents, `test_${dir}`, `${name}.py`].join('/');
      assert.equal(isTestFilePath(p), false, `${p} must not be a test file`);
    }));
  });
});
