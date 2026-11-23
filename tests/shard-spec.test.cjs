'use strict';

/**
 * The shard-spec helper (tests/helpers/shard-spec.cjs) parses and checks the `N/M` shard entries of a CI matrix: a spec
 * is exact at its boundaries, and a shard set is complete only when it shares one denominator and holds every numerator
 * once (#4335). The release.yml wiring that uses it is the release-shard-lane-sharding text contract; its subject is
 * workflow text, while this file's subject is the helper's own code, so these cases stay a test.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseShardSpec, isCompleteShardSet } = require('./helpers/shard-spec.cjs');

test('shard-spec parsing is exact at its boundaries (#4335)', () => {
  assert.deepEqual(parseShardSpec('1/3'), { index: 1, total: 3 });
  assert.deepEqual(parseShardSpec('3/3'), { index: 3, total: 3 });
  assert.equal(parseShardSpec('0/3'), null);
  assert.equal(parseShardSpec('4/3'), null);
  assert.equal(parseShardSpec('a/3'), null);

  assert.equal(isCompleteShardSet(['1/3', '2/3', '3/3']), true);
  assert.equal(isCompleteShardSet(['1/3', '2/3']), false, 'missing numerator');
  assert.equal(isCompleteShardSet(['1/3', '2/3', '2/3']), false, 'duplicate numerator');
  assert.equal(isCompleteShardSet(['1/3', '2/3', '3/4']), false, 'mixed denominator');
  assert.equal(isCompleteShardSet([]), false, 'empty set');
});
