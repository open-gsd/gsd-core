'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const {
  canonicalizeRuntimeName,
  resolveRuntimeNameFromCandidates,
} = require(path.join(ROOT, 'gsd-core', 'bin', 'lib', 'runtime-name-policy.cjs'));

describe('runtime-name-policy canonical runtime ids', () => {
  test('canonicalizes Kimi without adding extra aliases', () => {
    assert.strictEqual(canonicalizeRuntimeName('kimi'), 'kimi');
    assert.strictEqual(canonicalizeRuntimeName(' KIMI '), 'kimi');
    assert.strictEqual(resolveRuntimeNameFromCandidates('', null, 'kimi'), 'kimi');
    assert.strictEqual(canonicalizeRuntimeName('kimi-cli'), null);
  });
});
