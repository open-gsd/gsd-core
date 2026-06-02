'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const configuration = require('../gsd-core/bin/lib/configuration.cjs');

test('mergeDefaults clones defaults without JSON serialization fragility (#321)', () => {
  const sentinelKey = '__bug321_bigint_sentinel__';
  const sentinelValue = BigInt('9007199254740993001');

  configuration.CONFIG_DEFAULTS[sentinelKey] = sentinelValue;
  try {
    const merged = configuration.mergeDefaults({});
    assert.equal(
      merged[sentinelKey],
      sentinelValue,
      'mergeDefaults must preserve non-JSON scalar defaults when cloning'
    );
  }
  finally {
    delete configuration.CONFIG_DEFAULTS[sentinelKey];
  }
});
