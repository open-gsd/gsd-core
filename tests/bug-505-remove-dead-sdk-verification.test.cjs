/**
 * Regression guard for #505: dead SDK-shim verification subsystem removed.
 *
 * Post-ADR-0174 the `@opengsd/gsd-sdk` package was retired; `sdk/` no longer
 * ships. `installSdkIfNeeded` and all functions it transitively called are
 * dead code with no live callers. This test asserts:
 *
 *   1. All removed symbols are NO LONGER exported from bin/install.js.
 *   2. The two live stale-standalone-SDK helpers (detectStaleStandaloneSdk,
 *      formatStaleStandaloneSdkWarning) are STILL exported as functions — they
 *      handle a real user-facing condition (#3406) and MUST NOT be removed.
 */

'use strict';

process.env.GSD_TEST_MODE = '1';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const inst = require('../bin/install.js');

describe('bug #505: dead SDK verification subsystem removed from bin/install.js', () => {
  // ----------------------------------------------------------------
  // Dead symbols — must NOT be exported after removal
  // ----------------------------------------------------------------
  const deadSymbols = [
    'installSdkIfNeeded',
    'classifySdkInstall',
    'buildSdkFailFastReport',
    'renderSdkFailFastReport',
    'buildGsdSdkVersionMismatchReport',
    'renderGsdSdkVersionMismatchReport',
    'readGsdSdkVersion',
    'parseGsdSdkVersion',
    'findGsdSdkOnPath',
    'isGsdSdkOnPath',
    'isLegacyGsdSdkShim',
    'trySelfLinkGsdSdk',
    'trySelfLinkGsdSdkWindows',
    'buildWindowsShimTriple',
    'formatSdkPathDiagnostic',
    'filterNpxFromPath',
    'getUserShellPath',
    'getUserShellWindowsPersistentPath',
  ];

  for (const sym of deadSymbols) {
    test(`dead symbol '${sym}' is not exported`, () => {
      assert.equal(
        typeof inst[sym],
        'undefined',
        `'${sym}' should have been removed (post #505 dead-code removal) but is still exported as ${typeof inst[sym]}`,
      );
    });
  }

  // ----------------------------------------------------------------
  // Live symbols — MUST still be exported as functions
  // ----------------------------------------------------------------
  test('live function detectStaleStandaloneSdk is still exported', () => {
    assert.equal(
      typeof inst.detectStaleStandaloneSdk,
      'function',
      'detectStaleStandaloneSdk handles real stale-SDK condition (#3406) and must not be removed',
    );
  });

  test('live function formatStaleStandaloneSdkWarning is still exported', () => {
    assert.equal(
      typeof inst.formatStaleStandaloneSdkWarning,
      'function',
      'formatStaleStandaloneSdkWarning handles real stale-SDK condition (#3406) and must not be removed',
    );
  });
});
