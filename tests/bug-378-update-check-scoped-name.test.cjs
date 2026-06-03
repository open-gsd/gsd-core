/**
 * Regression test for #378 / #498: the SessionStart update worker must end up
 * querying the SCOPED package name (@opengsd/gsd-core) when it asks
 * npm for the latest version.
 *
 * Background (#378): the worker once hardcoded the unscoped 'gsd-core',
 * which 404s from the registry, leaving update_available permanently false.
 *
 * Original #378 fix derived the name from `require('../package.json').name`.
 * That is broken at runtime (#498): the installed tree carries only a synthetic
 * `{"type":"commonjs"}` package.json (no `.name`), so post-install the worker
 * queried `npm view undefined version` → latest stayed null → update_available
 * permanently false. The old structural test passed only because it grepped the
 * DEV tree, where package.json still has a name.
 *
 * New contract (#498): the worker no longer resolves the package name itself.
 * It delegates the latest-version lookup to check-latest-version.cjs's
 * `checkLatestVersion()`, whose `PACKAGE_NAME` is sourced from the baked Package
 * Identity seam (`gsd-core/bin/lib/package-identity.cjs`). The seam's value
 * is a build-time constant, correct in every install layout, so the
 * undefined-at-runtime failure cannot recur. This test locks that contract:
 *
 *   1. Structural: worker must NOT contain the bare unscoped literal.
 *   2. Structural: worker must NOT use `require(...package.json...).name`
 *      (the runtime-broken path).
 *   3. Structural: worker delegates to check-latest-version's
 *      `checkLatestVersion` rather than calling `npm view` itself.
 *   4. Single-source: check-latest-version's PACKAGE_NAME === the seam's
 *      packageName === the scoped '@opengsd/gsd-core'.
 *
 * Source-grep policy: this test reads hook source via readFileSync. The repo's
 * lint-no-source-grep rule targets bin/lib/gsd-core — hooks/ is out of
 * scope. The behavior (correct name → no E404) only manifests at runtime
 * against the live registry; structural assertions are the minimum-cost
 * contract for the worker, the same rationale #378 carried.
 */

// allow-test-rule: structural assertion on hook delegation; the behavior being
// tested (correct package name → no E404) only manifests at runtime against the
// live npm registry, which CI does not call.

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const WORKER_PATH = path.join(__dirname, '..', 'hooks', 'gsd-check-update-worker.js');
const PKG_PATH = path.join(__dirname, '..', 'package.json');
const SEAM = require('../gsd-core/bin/lib/package-identity.cjs');
const { PACKAGE_NAME } = require('../gsd-core/bin/check-latest-version.cjs');

function workerCodeOnly() {
  const src = fs.readFileSync(WORKER_PATH, 'utf8');
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

describe('bug #378 / #498: update worker queries the scoped name via the seam', () => {
  test('worker file exists', () => {
    assert.ok(fs.existsSync(WORKER_PATH), `worker not found at ${WORKER_PATH}`);
  });

  test('package.json name is the scoped @opengsd/gsd-core', () => {
    const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
    assert.equal(pkg.name, '@opengsd/gsd-core');
  });

  test('worker does NOT hardcode the unscoped gsd-core as a string literal', () => {
    assert.doesNotMatch(
      workerCodeOnly(),
      /['"]gsd-core['"]/,
      "Worker must not pass the unscoped 'gsd-core' to npm — it 404s.",
    );
  });

  test('worker does NOT resolve the name via require(package.json).name (broken at runtime)', () => {
    assert.doesNotMatch(
      workerCodeOnly(),
      /require\s*\(\s*['"][^'"]*package\.json['"]\s*\)\s*\.name/,
      [
        'require(package.json).name resolves to undefined in the installed tree',
        '(only a {"type":"commonjs"} marker ships). The worker must delegate to',
        'checkLatestVersion(), which sources the name from the baked seam.',
      ].join(' '),
    );
  });

  test('worker delegates the latest-version lookup to checkLatestVersion', () => {
    const code = workerCodeOnly();
    assert.match(
      code,
      /check-latest-version/,
      'Worker must require check-latest-version.cjs and call checkLatestVersion().',
    );
    assert.match(code, /checkLatestVersion\s*\(/);
  });

  test('check-latest-version PACKAGE_NAME is single-sourced from the seam', () => {
    assert.equal(PACKAGE_NAME, SEAM.packageName);
    assert.equal(SEAM.packageName, '@opengsd/gsd-core');
  });
});
