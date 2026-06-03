/**
 * Tests for cache lineage validation (issue #607).
 *
 * Verifies that per-package cache filenames and package_name lineage guards
 * are correctly enforced across gsd-update-banner.js, gsd-statusline.js,
 * and the worker result shape.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { PACKAGE_NAME, updateCacheFileName } = require('../gsd-core/bin/lib/package-identity.cjs');
const { buildBannerOutput } = require('../hooks/gsd-update-banner.js');
const { evaluateUpdateCache } = require('../hooks/gsd-statusline.js');

// ─── Package identity constants ──────────────────────────────────────────────

describe('package-identity exports', () => {
  test('PACKAGE_NAME is @opengsd/gsd-core', () => {
    assert.equal(PACKAGE_NAME, '@opengsd/gsd-core');
  });

  test('updateCacheFileName is per-package filename', () => {
    assert.equal(updateCacheFileName, 'gsd-update-check-opengsd-gsd-core.json');
  });
});

// ─── Worker result shape: package_name field ─────────────────────────────────
// The worker writes { ..., package_name: PACKAGE_NAME } to the cache.
// We assert the documented contract by confirming PACKAGE_NAME is correct
// and that it equals the value that the worker will embed.

describe('worker result shape contract', () => {
  test('PACKAGE_NAME value matches the expected installed package', () => {
    // The worker adds package_name: PACKAGE_NAME to its result object.
    // This test asserts the value that will appear in the cache.
    assert.equal(PACKAGE_NAME, '@opengsd/gsd-core');
  });
});

// ─── buildBannerOutput: lineage guard ────────────────────────────────────────

describe('buildBannerOutput lineage guard', () => {
  test('returns null when package_name is present but foreign', () => {
    const out = buildBannerOutput({
      cache: {
        update_available: true,
        installed: '1.2.0',
        latest: '1.42.3',
        package_name: 'get-shit-done-cc',
      },
      parseError: false,
      suppressFailureWarning: false,
    });
    assert.equal(out, null, 'foreign lineage must be rejected');
  });

  test('returns banner when package_name matches PACKAGE_NAME', () => {
    const out = buildBannerOutput({
      cache: {
        update_available: true,
        installed: '1.2.0',
        latest: '1.3.0',
        package_name: '@opengsd/gsd-core',
      },
      parseError: false,
      suppressFailureWarning: false,
    });
    assert.ok(out, 'expected banner envelope for matching lineage');
    assert.equal(typeof out.systemMessage, 'string');
    assert.ok(out.systemMessage.includes('1.2.0'));
    assert.ok(out.systemMessage.includes('1.3.0'));
    assert.ok(out.systemMessage.includes('/gsd:update'));
  });

  test('returns null when package_name is absent (untrusted cache)', () => {
    const out = buildBannerOutput({
      cache: {
        update_available: true,
        installed: '1.2.0',
        latest: '1.3.0',
        // no package_name field
      },
      parseError: false,
      suppressFailureWarning: false,
    });
    assert.equal(out, null, 'absent package_name must be treated as untrusted → null');
  });
});

// ─── evaluateUpdateCache: lineage guard in statusline ────────────────────────

describe('evaluateUpdateCache lineage guard', () => {
  test('returns showUpdate=false when cache is null', () => {
    const r = evaluateUpdateCache(null);
    assert.equal(r.showUpdate, false);
    assert.equal(r.staleWarning, 'none');
  });

  test('returns showUpdate=false when package_name is absent (untrusted)', () => {
    const r = evaluateUpdateCache({
      update_available: true,
      installed: '1.2.0',
      latest: '1.3.0',
    });
    assert.equal(r.showUpdate, false);
    assert.equal(r.staleWarning, 'none');
  });

  test('returns showUpdate=false when package_name is foreign', () => {
    const r = evaluateUpdateCache({
      update_available: true,
      installed: '1.2.0',
      latest: '1.3.0',
      package_name: 'some-other-package',
    });
    assert.equal(r.showUpdate, false);
    assert.equal(r.staleWarning, 'none');
  });

  test('returns showUpdate=true when update_available and package_name matches', () => {
    const r = evaluateUpdateCache({
      update_available: true,
      installed: '1.2.0',
      latest: '1.3.0',
      package_name: '@opengsd/gsd-core',
    });
    assert.equal(r.showUpdate, true);
    assert.equal(r.staleWarning, 'none');
  });

  test('returns showUpdate=false when update_available=false', () => {
    const r = evaluateUpdateCache({
      update_available: false,
      installed: '1.3.0',
      latest: '1.3.0',
      package_name: '@opengsd/gsd-core',
    });
    assert.equal(r.showUpdate, false);
    assert.equal(r.staleWarning, 'none');
  });

  test('returns staleWarning=stale when stale_hooks present and matching package_name', () => {
    const r = evaluateUpdateCache({
      update_available: false,
      installed: '1.3.0',
      latest: '1.3.0',
      package_name: '@opengsd/gsd-core',
      stale_hooks: [{ file: 'gsd-statusline.js', hookVersion: '1.2.0', installedVersion: '1.3.0' }],
    });
    assert.equal(r.staleWarning, 'stale');
  });

  test('returns staleWarning=dev when installed > latest (dev install) and matching package_name', () => {
    const r = evaluateUpdateCache({
      update_available: false,
      installed: '2.0.0',
      latest: '1.3.0',
      package_name: '@opengsd/gsd-core',
      stale_hooks: [{ file: 'gsd-statusline.js', hookVersion: '1.2.0', installedVersion: '2.0.0' }],
    });
    assert.equal(r.staleWarning, 'dev');
  });

  test('returns staleWarning=none when stale_hooks present but package_name is foreign', () => {
    const r = evaluateUpdateCache({
      update_available: false,
      installed: '1.3.0',
      latest: '1.2.0',
      package_name: 'foreign-pkg',
      stale_hooks: [{ file: 'gsd-statusline.js', hookVersion: '1.2.0', installedVersion: '1.3.0' }],
    });
    assert.equal(r.staleWarning, 'none');
  });
});
