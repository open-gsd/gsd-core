'use strict';

process.env.GSD_TEST_MODE = '1';

/**
 * The retired gsd-sdk shim path should not keep Windows-only self-link helpers
 * alive. Current Windows coverage belongs to runtime hook shims, not a deleted
 * bin/gsd-sdk.js compatibility path.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const installModule = require(path.join(ROOT, 'bin', 'install.js'));

describe('retired gsd-sdk Windows self-link helpers', () => {
  test('installer no longer exports gsd-sdk self-link helpers', () => {
    assert.equal(
      Object.prototype.hasOwnProperty.call(installModule, 'trySelfLinkGsdSdk'),
      false,
      'trySelfLinkGsdSdk must not remain exported after gsd-sdk shim retirement',
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(installModule, 'trySelfLinkGsdSdkWindows'),
      false,
      'trySelfLinkGsdSdkWindows must not remain exported after gsd-sdk shim retirement',
    );
  });
});
