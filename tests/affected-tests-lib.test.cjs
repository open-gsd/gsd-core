'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseRelativeSpecifiers,
  pickAffectedTests,
  shouldRunFullSuite,
  resolveBaseRef,
  PR_EXCLUDED_SUITES,
  PR_FULL_SUITES,
} = require('../scripts/affected-tests-lib.cjs');

test('parseRelativeSpecifiers captures local require/import paths', () => {
  const source = `
    const a = require('./alpha.cjs');
    const b = require("node:assert/strict");
    import c from "../beta.js";
    import d from "external-lib";
  `;
  const out = parseRelativeSpecifiers(source);
  assert.deepEqual(out, ['./alpha.cjs', '../beta.js']);
});

test('shouldRunFullSuite true when critical paths change', () => {
  assert.equal(shouldRunFullSuite(['package-lock.json']), true);
  assert.equal(shouldRunFullSuite(['.github/workflows/test.yml']), true);
  assert.equal(shouldRunFullSuite(['tests/foo.test.cjs']), false);
});

test('pickAffectedTests includes direct test changes and reverse-index matches, excluding install suite', () => {
  const allTests = [
    'tests/alpha.test.cjs',
    'tests/install.test.cjs',
    'tests/tarball.install.test.cjs',
  ];
  const reverse = new Map([
    ['bin/install.js', new Set(['tests/install.test.cjs'])],
  ]);
  const selected = pickAffectedTests(
    ['tests/alpha.test.cjs', 'bin/install.js'],
    allTests,
    reverse,
  );
  // tests/install.test.cjs is a plain unit test (no install suite marker) so it is included.
  // tests/tarball.install.test.cjs is install suite — excluded.
  assert.deepEqual(selected, [
    'tests/alpha.test.cjs',
    'tests/install.test.cjs',
  ]);
});

test('pickAffectedTests falls back to smoke test when no matches found', () => {
  const allTests = ['tests/release-tarball-smoke.install.test.cjs'];
  const selected = pickAffectedTests(
    ['docs/README.md'],
    allTests,
    new Map(),
  );
  // New contract: install files are excluded; empty selection returns empty array.
  assert.deepEqual(selected, []);
});

test('pickAffectedTests excludes a directly-changed install test file', () => {
  // Even if the changed file IS an install test, it must be excluded from PR selection.
  const allTests = [
    'tests/foo.install.test.cjs',
    'tests/bar.test.cjs',
  ];
  const selected = pickAffectedTests(
    ['tests/foo.install.test.cjs'],
    allTests,
    new Map(),
  );
  assert.ok(!selected.includes('tests/foo.install.test.cjs'), 'install test must be excluded');
  assert.deepEqual(selected, []);
});

test('pickAffectedTests excludes install/slow pulled in by stem match', () => {
  // A changed source file whose stem matches an install or slow test file.
  const allTests = [
    'tests/release-tarball.install.test.cjs',
    'tests/perf-check.slow.test.cjs',
    'tests/release-tarball.test.cjs',
  ];
  const selected = pickAffectedTests(
    ['src/release-tarball.cjs'],
    allTests,
    new Map(),
  );
  assert.ok(!selected.includes('tests/release-tarball.install.test.cjs'), 'install suite must be excluded via stem match');
  assert.ok(!selected.includes('tests/perf-check.slow.test.cjs'), 'slow suite must be excluded');
  // The plain unit test matched by stem is still included.
  assert.ok(selected.includes('tests/release-tarball.test.cjs'), 'unit test matched by stem should be included');
});

test('pickAffectedTests returns empty (no install smoke) when nothing maps', () => {
  const allTests = [
    'tests/release-tarball-smoke.install.test.cjs',
    'tests/some-unit.test.cjs',
  ];
  // Changed file has no match and no stem match with unit tests.
  const selected = pickAffectedTests(
    ['docs/CONTRIBUTING.md'],
    allTests,
    new Map(),
  );
  assert.ok(
    !selected.includes('tests/release-tarball-smoke.install.test.cjs'),
    'install smoke test must not be injected as fallback',
  );
  assert.deepEqual(selected, []);
});

test('PR_EXCLUDED_SUITES contains install and slow; PR_FULL_SUITES excludes them', () => {
  assert.ok(PR_EXCLUDED_SUITES instanceof Set, 'PR_EXCLUDED_SUITES must be a Set');
  assert.ok(PR_EXCLUDED_SUITES.has('install'), 'install must be in PR_EXCLUDED_SUITES');
  assert.ok(PR_EXCLUDED_SUITES.has('slow'), 'slow must be in PR_EXCLUDED_SUITES');
  assert.ok(Array.isArray(PR_FULL_SUITES), 'PR_FULL_SUITES must be an array');
  assert.ok(PR_FULL_SUITES.includes('unit'), 'unit must be in PR_FULL_SUITES');
  assert.ok(PR_FULL_SUITES.includes('integration'), 'integration must be in PR_FULL_SUITES');
  assert.ok(PR_FULL_SUITES.includes('security'), 'security must be in PR_FULL_SUITES');
  assert.ok(!PR_FULL_SUITES.includes('install'), 'install must NOT be in PR_FULL_SUITES');
  assert.ok(!PR_FULL_SUITES.includes('slow'), 'slow must NOT be in PR_FULL_SUITES');
});

test('resolveBaseRef prefers explicit env override', () => {
  const original = {
    GSD_AFFECTED_BASE: process.env.GSD_AFFECTED_BASE,
    GITHUB_BASE_REF: process.env.GITHUB_BASE_REF,
  };
  try {
    process.env.GSD_AFFECTED_BASE = 'origin/next';
    process.env.GITHUB_BASE_REF = 'main';
    assert.equal(resolveBaseRef(), 'origin/next');

    delete process.env.GSD_AFFECTED_BASE;
    process.env.GITHUB_BASE_REF = 'next';
    assert.equal(resolveBaseRef(), 'origin/next');

    delete process.env.GSD_AFFECTED_BASE;
    delete process.env.GITHUB_BASE_REF;
    assert.equal(resolveBaseRef(), 'origin/main');
  } finally {
    if (original.GSD_AFFECTED_BASE === undefined) delete process.env.GSD_AFFECTED_BASE;
    else process.env.GSD_AFFECTED_BASE = original.GSD_AFFECTED_BASE;
    if (original.GITHUB_BASE_REF === undefined) delete process.env.GITHUB_BASE_REF;
    else process.env.GITHUB_BASE_REF = original.GITHUB_BASE_REF;
  }
});
