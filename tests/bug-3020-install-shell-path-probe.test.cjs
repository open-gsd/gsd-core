/**
 * Regression coverage for retired SDK installer PATH probes.
 *
 * The standalone SDK package/binary is retired. The installer must not export
 * gsd-sdk PATH-probe helpers anymore, but it may still emit best-effort legacy
 * cleanup guidance for the known-bad @opengsd/gsd-sdk@0.1.0 global package.
 */

'use strict';

process.env.GSD_TEST_MODE = '1';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const INSTALL = require(path.join(__dirname, '..', 'bin', 'install.js'));

describe('retired SDK installer PATH probe surface', () => {
  test('does not export retired gsd-sdk PATH/shim helpers', () => {
    for (const name of [
      'isGsdSdkOnPath',
      'trySelfLinkGsdSdk',
      'trySelfLinkGsdSdkWindows',
      'buildWindowsShimTriple',
      'formatSdkPathDiagnostic',
    ]) {
      assert.equal(
        Object.prototype.hasOwnProperty.call(INSTALL, name),
        false,
        `${name} must not remain exported after SDK retirement`,
      );
    }
  });

  test('legacy standalone SDK detector is retained as cleanup-only guidance', () => {
    const detected = INSTALL.detectStaleStandaloneSdk(() => JSON.stringify({
      dependencies: {
        '@opengsd/gsd-sdk': { version: '0.1.0' },
      },
    }));

    assert.deepEqual(detected, { stale: true, version: '0.1.0' });

    const warning = INSTALL.formatStaleStandaloneSdkWarning(detected);
    assert.match(warning, /Legacy standalone @opengsd\/gsd-sdk@0\.1\.0/);
    assert.match(warning, /GSD no longer uses the standalone SDK package/);
    assert.doesNotMatch(warning, /gsd-sdk query|shadowing|current shim/i);
  });

  test('legacy standalone SDK detector ignores non-legacy versions', () => {
    const detected = INSTALL.detectStaleStandaloneSdk(() => JSON.stringify({
      dependencies: {
        '@opengsd/gsd-sdk': { version: '1.2.3' },
      },
    }));

    assert.deepEqual(detected, { stale: false });
  });
});
