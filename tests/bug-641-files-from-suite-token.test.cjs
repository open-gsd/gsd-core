// Regression test for issue #641:
// `--files-from` with a bare suite token (e.g. "unit") crashes with
// "requested test file(s) not found: unit" instead of expanding the token
// to the matching suite's files.
//
// The bug: selectExplicitFiles() checked `available.has('unit')` against the
// set of *.test.cjs filenames. 'unit' is not a filename, so it landed in
// `missing` and caused exit 2. The fix teaches selectExplicitFiles() to
// delegate bare SUITES members to selectFiles() before the path-existence
// check.
'use strict';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const { createTempDir, cleanup } = require('./helpers.cjs');

const HARNESS = path.join(__dirname, '..', 'scripts', 'run-tests.cjs');

const PASS_BODY = `'use strict';
const { test } = require('node:test');
test('noop', () => {});
`;

function seed(dir, names) {
  for (const name of names) {
    fs.writeFileSync(path.join(dir, name), PASS_BODY, 'utf8');
  }
}

function runHarness(testDir, args = [], extraEnv = {}) {
  const env = { ...process.env, GSD_TEST_DIR: testDir, ...extraEnv };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, [HARNESS, ...args], {
    cwd: path.join(__dirname, '..'),
    env,
    encoding: 'utf8',
  });
}

describe('bug #641 — --files-from with bare suite token', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-641-suite-token-');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('--files-from with bare "unit" token expands to unit suite, does not exit 2', () => {
    // Seed a mix: one unit file, one security file.
    seed(tmpDir, ['a.test.cjs', 'b.security.test.cjs']);
    const listPath = path.join(tmpDir, 'ci-selected-tests.txt');
    fs.writeFileSync(listPath, 'unit\n', 'utf8');

    const r = runHarness(tmpDir, ['--files-from', listPath]);

    // Must NOT exit 2 with the "not found" error.
    assert.notStrictEqual(
      r.status,
      2,
      `Expected exit 0 or 1, got 2.\nstderr: ${r.stderr}\nstdout: ${r.stdout}`,
    );
    assert.doesNotMatch(
      r.stderr,
      /requested test file\(s\) not found: unit/,
      `Must not emit "not found: unit".\nstderr: ${r.stderr}`,
    );
    // The unit suite file (a.test.cjs) must appear in the run.
    assert.ok(
      r.stderr.includes('a.test.cjs'),
      `Expected a.test.cjs (unit suite) to be selected.\nstderr: ${r.stderr}`,
    );
    // The security suite file must NOT be included (unit token = unit only).
    assert.ok(
      !r.stderr.includes('b.security.test.cjs'),
      `Expected b.security.test.cjs (security suite) to be excluded.\nstderr: ${r.stderr}`,
    );
  });

  test('--files-from with bare "unit" token exits 0 (tests run successfully)', () => {
    seed(tmpDir, ['a.test.cjs']);
    const listPath = path.join(tmpDir, 'ci-selected-tests.txt');
    fs.writeFileSync(listPath, 'unit\n', 'utf8');

    const r = runHarness(tmpDir, ['--files-from', listPath]);

    assert.strictEqual(
      r.status,
      0,
      `Expected exit 0.\nstderr: ${r.stderr}\nstdout: ${r.stdout}`,
    );
  });

  test('--files with bare "unit" token also resolves correctly', () => {
    seed(tmpDir, ['a.test.cjs', 'b.security.test.cjs']);
    const r = runHarness(tmpDir, ['--files', 'unit']);

    assert.notStrictEqual(
      r.status,
      2,
      `Expected exit 0, got 2.\nstderr: ${r.stderr}`,
    );
    assert.doesNotMatch(r.stderr, /requested test file\(s\) not found: unit/);
    assert.ok(r.stderr.includes('a.test.cjs'), `a.test.cjs must be selected.\nstderr: ${r.stderr}`);
    assert.ok(!r.stderr.includes('b.security.test.cjs'), `security file must not be selected.\nstderr: ${r.stderr}`);
  });

  test('mixed: suite token "unit" alongside an explicit file resolves both', () => {
    seed(tmpDir, ['a.test.cjs', 'b.test.cjs', 'c.security.test.cjs']);
    const listPath = path.join(tmpDir, 'ci-selected-tests.txt');
    // 'unit' expands to [a.test.cjs, b.test.cjs]; b.test.cjs is explicit too.
    fs.writeFileSync(listPath, 'unit\nb.test.cjs\n', 'utf8');

    const r = runHarness(tmpDir, ['--files-from', listPath]);

    assert.strictEqual(r.status, 0, `stderr: ${r.stderr}`);
    // Both unit files present; security not.
    assert.ok(r.stderr.includes('a.test.cjs'), `a.test.cjs must be selected.\nstderr: ${r.stderr}`);
    assert.ok(r.stderr.includes('b.test.cjs'), `b.test.cjs must be selected.\nstderr: ${r.stderr}`);
    assert.ok(!r.stderr.includes('c.security.test.cjs'), `c.security.test.cjs must be excluded.\nstderr: ${r.stderr}`);
  });

  test('#408 fallback: ci-test-scope "unit" sentinel does not crash run-tests', () => {
    // This test simulates the end-to-end #408 fallback path:
    // ci-test-scope produces "unit" (the fallback sentinel for "code changed
    // but no rule matched any test"), ci-prepare-test-scope writes it verbatim,
    // and run-tests must resolve it rather than crash.
    seed(tmpDir, ['a.test.cjs', 'b.security.test.cjs']);
    // Simulate what ci-prepare-test-scope writes: "unit\n"
    const listPath = path.join(tmpDir, '.ci-selected-tests.txt');
    fs.writeFileSync(listPath, 'unit\n', 'utf8');

    const r = runHarness(tmpDir, ['--files-from', listPath]);

    assert.strictEqual(
      r.status,
      0,
      `#408 fallback: expected exit 0 but got ${r.status}.\nstderr: ${r.stderr}`,
    );
    assert.doesNotMatch(r.stderr, /not found: unit/);
    assert.ok(r.stderr.includes('a.test.cjs'), `unit test must run.\nstderr: ${r.stderr}`);
  });
});

// Regression test for issue #1329:
// ci-prepare-test-scope's empty-detection FALLBACK hardcoded an explicit file
// list that included tests/core.test.cjs — a file deleted in #1291. Every
// scoped lane (scope=targeted|windows) that hit the fallback wrote the stale
// path into .ci-selected-tests.txt and crashed run-tests with
// "requested test file(s) not found: core.test.cjs". The fix: existence-filter
// the fallback at write time, fall back to the 'unit' suite sentinel when
// nothing survives, and guard the FALLBACK constant against disk reality.
describe('bug #1329 — ci-prepare-test-scope fallback never emits a deleted file', () => {
  const { FALLBACK, FALLBACK_SENTINEL, SUITE_SENTINELS, resolveSelection } =
    require('../scripts/ci-prepare-test-scope.cjs');
  const REPO_ROOT = path.join(__dirname, '..');

  // Generative parity guard (DEFECT.GENERATIVE-FIX): the FALLBACK constant and
  // the test files on disk are two surfaces that must stay in sync. This fails
  // the instant a refactor deletes a file still named in FALLBACK — which is
  // precisely what #1291 did and CI did not catch.
  test('every FALLBACK entry resolves on disk or is a known suite sentinel', () => {
    for (const entry of FALLBACK) {
      const isSentinel = SUITE_SENTINELS.includes(entry);
      const exists = fs.existsSync(path.join(REPO_ROOT, entry));
      assert.ok(
        isSentinel || exists,
        `FALLBACK entry "${entry}" is neither an existing test file nor a suite sentinel — stale reference will crash scoped CI lanes (see #1329).`,
      );
    }
  });

  let tmpDir;
  beforeEach(() => {
    tmpDir = createTempDir('gsd-1329-fallback-');
    fs.mkdirSync(path.join(tmpDir, 'tests'), { recursive: true });
  });
  afterEach(() => {
    cleanup(tmpDir);
  });

  test('empty detection drops a non-existent fallback entry instead of emitting it', () => {
    // Create all but the last FALLBACK file under a controlled root, simulating
    // a since-deleted test (the #1329 mechanism), independent of which files
    // FALLBACK happens to name today.
    const present = FALLBACK.slice(0, -1);
    const absent = FALLBACK[FALLBACK.length - 1];
    for (const f of present) {
      fs.writeFileSync(path.join(tmpDir, f), PASS_BODY, 'utf8');
    }

    const lines = resolveSelection({ scope: 'targeted', targeted: '', windows: '', root: tmpDir });

    assert.ok(!lines.includes(absent), `absent file "${absent}" must be filtered out, got: ${lines.join(', ')}`);
    for (const f of present) {
      assert.ok(lines.includes(f), `present file "${f}" must survive, got: ${lines.join(', ')}`);
    }
  });

  test('empty detection with no surviving fallback files falls back to the unit sentinel', () => {
    // tmpDir/tests exists but contains none of the FALLBACK files.
    const lines = resolveSelection({ scope: 'windows', targeted: '', windows: '', root: tmpDir });
    assert.deepStrictEqual(lines, [FALLBACK_SENTINEL]);
  });

  test('detected list passes through verbatim — files and suite sentinels preserved, not existence-filtered', () => {
    // The detected list is already filtered by affected-tests-lib and may carry
    // a suite sentinel; ci-prepare-test-scope must not touch it.
    const lines = resolveSelection({
      scope: 'targeted',
      targeted: 'tests/does-not-exist.test.cjs unit',
      windows: '',
      root: tmpDir,
    });
    assert.deepStrictEqual(lines, ['tests/does-not-exist.test.cjs', 'unit']);
  });

  test('end-to-end: the real script writes a fallback list whose every entry resolves', () => {
    // Run the real script (subprocess) with empty detection inside an isolated
    // root that holds the FALLBACK files, then verify every line it wrote into
    // .ci-selected-tests.txt resolves — the exact scoped-lane path that crashed
    // in #1329. Hermetic: the temp root is removed by afterEach's cleanup().
    for (const f of FALLBACK) {
      fs.writeFileSync(path.join(tmpDir, f), PASS_BODY, 'utf8');
    }
    const prep = spawnSync(
      process.execPath,
      [path.join(REPO_ROOT, 'scripts', 'ci-prepare-test-scope.cjs')],
      { cwd: tmpDir, env: { ...process.env, TEST_SCOPE: 'targeted', TARGETED_TESTS: '', WINDOWS_TESTS: '' }, encoding: 'utf8' },
    );
    assert.strictEqual(prep.status, 0, `prepare step failed: ${prep.stderr}`);

    const selected = fs.readFileSync(path.join(tmpDir, '.ci-selected-tests.txt'), 'utf8');
    for (const line of selected.split('\n').filter(Boolean)) {
      const isSentinel = SUITE_SENTINELS.includes(line);
      assert.ok(
        isSentinel || fs.existsSync(path.join(tmpDir, line)),
        `selected entry "${line}" does not resolve — would crash run-tests (#1329)`,
      );
    }
    assert.doesNotMatch(selected, /core\.test\.cjs/, 'deleted core.test.cjs must never be selected');
  });
});
