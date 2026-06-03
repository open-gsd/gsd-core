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
