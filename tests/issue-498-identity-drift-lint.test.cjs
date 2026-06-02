'use strict';
process.env.GSD_TEST_MODE = '1';

// Issue #498: the drift-guard lint. Every GSD package/repo coordinate that
// appears as a literal anywhere in the runtime/code surface must equal the
// value the Package Identity seam derives from package.json. This is what
// makes a repoint a one-line change: rename package.json, regenerate the seam,
// and any stale literal fails CI until it is updated.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const { findCoordinateDrift } = require(
  path.join(ROOT, 'scripts', 'lint-package-identity-drift.cjs'),
);

const SEAM = { packageName: '@opengsd/get-shit-done-redux', repoSlug: 'open-gsd/get-shit-done-redux' };

describe('Issue #498: findCoordinateDrift (pure)', () => {
  test('a correct package literal is not drift', () => {
    const v = findCoordinateDrift('run npx -y @opengsd/get-shit-done-redux@latest', SEAM);
    assert.deepEqual(v, []);
  });

  test('a stale package literal (post-rename) is flagged', () => {
    const v = findCoordinateDrift('npx @opengsd/get-shit-done-classic@latest', SEAM);
    assert.equal(v.length, 1);
    assert.equal(v[0].found, '@opengsd/get-shit-done-classic');
    assert.equal(v[0].expected, SEAM.packageName);
    assert.equal(v[0].kind, 'package');
  });

  test('a different package (@opengsd/gsd-sdk) is NOT a gsd-core coordinate', () => {
    assert.deepEqual(findCoordinateDrift("require('@opengsd/gsd-sdk')", SEAM), []);
  });

  test('a correct github repo slug is not drift', () => {
    const v = findCoordinateDrift('https://github.com/open-gsd/get-shit-done-redux/issues', SEAM);
    assert.deepEqual(v, []);
  });

  test('a stale repo slug in a github url is flagged', () => {
    const v = findCoordinateDrift('https://github.com/tches/get-shit-done-classic.git', SEAM);
    assert.equal(v.length, 1);
    assert.equal(v[0].kind, 'slug');
    assert.equal(v[0].found, 'tches/get-shit-done-classic');
  });

  test('reports 1-based line numbers', () => {
    const text = 'line1\nnpx @opengsd/get-shit-done-OLD@latest\nline3';
    const v = findCoordinateDrift(text, SEAM);
    assert.equal(v[0].line, 2);
  });
});

describe('Issue #498: the live repo passes the drift lint', () => {
  test('scanRepo finds zero drift against the current seam', () => {
    const { scanRepo } = require(path.join(ROOT, 'scripts', 'lint-package-identity-drift.cjs'));
    const violations = scanRepo(ROOT);
    assert.deepEqual(
      violations,
      [],
      'stale GSD coordinate literal(s) found:\n' +
        violations.map((d) => `  ${d.file}:${d.line} ${d.kind} '${d.found}' != '${d.expected}'`).join('\n'),
    );
  });
});
