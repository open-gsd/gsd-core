'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  isCiGating,
  isShipped,
} = require(path.join(__dirname, '..', 'scripts', 'diff-touches-shipped-paths.cjs'));

describe('diff-touches-shipped-paths current path classifier', () => {
  test('root tests remain CI-gating paths', () => {
    assert.equal(isCiGating('tests/state.test.cjs'), true);
    assert.equal(isCiGating('tests/fixtures/example.json'), true);
  });

  test('retired SDK source tests are not a special CI-gating path', () => {
    assert.equal(isCiGating('sdk/src/query/state.test.ts'), false);
    assert.equal(isCiGating('sdk/src/query/state.spec.ts'), false);
  });

  test('current shipped script paths are classified through package files prefixes', () => {
    assert.equal(isShipped('scripts/diff-touches-shipped-paths.cjs', ['package.json', 'scripts']), true);
  });
});
