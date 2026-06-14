// allow-test-rule: run-tests.cjs is a CLI test harness whose only IR is its
// stable stderr line `run-tests: suite="X" files=N: name1 name2 ...` plus its
// exit code. No typed IR is exposable from a shell script; the printed line
// IS the contract this test pins. See docs/TESTING-SUITES.md and issue #3597.
//
// Tests for scripts/run-tests.cjs --suite filtering (issue #3597).
//
// Drives the harness through its subprocess seam — the same seam CI uses —
// rather than importing internals. Each test seeds a temporary directory
// with mock `.test.cjs` files (each one a trivial node:test no-op) and
// runs the harness against it via GSD_TEST_DIR.

'use strict';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const { createTempDir, cleanup } = require('./helpers.cjs');

const HARNESS = path.join(__dirname, '..', 'scripts', 'run-tests.cjs');

// Minimal valid node:test file. Each fixture file passes when executed.
const PASS_BODY = `'use strict';
const { test } = require('node:test');
test('noop', () => {});
`;

function seed(dir, names) {
  for (const name of names) {
    const full = path.join(dir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, PASS_BODY, 'utf8');
  }
}

function runHarness(testDir, args = [], extraEnv = {}) {
  // Clear node:test parent-context env so the harness's child `node --test`
  // doesn't refuse to run with "recursive run() skipping running files".
  const env = { ...process.env, GSD_TEST_DIR: testDir, ...extraEnv };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, [HARNESS, ...args], {
    cwd: path.join(__dirname, '..'),
    env,
    encoding: 'utf8',
  });
}

describe('run-tests.cjs harness (issue #3597)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-3597-harness-');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  describe('argument parsing', () => {
    test('unknown suite name exits non-zero with valid-suites hint', () => {
      seed(tmpDir, ['a.test.cjs']);
      const r = runHarness(tmpDir, ['--suite', 'bogus']);
      assert.notStrictEqual(r.status, 0);
      assert.match(r.stderr, /unknown suite/i);
      assert.match(r.stderr, /unit/);
      assert.match(r.stderr, /security/);
    });

    test('missing --suite value exits non-zero', () => {
      seed(tmpDir, ['a.test.cjs']);
      const r = runHarness(tmpDir, ['--suite']);
      assert.notStrictEqual(r.status, 0);
      assert.match(r.stderr, /requires a value/i);
    });

    test('duplicate --suite flag is rejected', () => {
      seed(tmpDir, ['a.test.cjs']);
      const r = runHarness(tmpDir, ['--suite', 'unit', '--suite', 'security']);
      assert.notStrictEqual(r.status, 0);
      assert.match(r.stderr, /duplicate/i);
    });

    test('unknown positional argument is rejected', () => {
      seed(tmpDir, ['a.test.cjs']);
      const r = runHarness(tmpDir, ['unit']);
      assert.notStrictEqual(r.status, 0);
      assert.match(r.stderr, /unknown argument/i);
    });

    test('--suite=value syntax is accepted', () => {
      seed(tmpDir, ['a.test.cjs', 'b.security.test.cjs']);
      const r = runHarness(tmpDir, ['--suite=security']);
      assert.strictEqual(r.status, 0, `stderr: ${r.stderr}\nstdout: ${r.stdout}`);
    });

    test('missing --files value exits non-zero', () => {
      seed(tmpDir, ['a.test.cjs']);
      const r = runHarness(tmpDir, ['--files']);
      assert.notStrictEqual(r.status, 0);
      assert.match(r.stderr, /--files requires a value/i);
    });

    test('duplicate --files flag is rejected', () => {
      seed(tmpDir, ['a.test.cjs']);
      const r = runHarness(tmpDir, ['--files', 'a.test.cjs', '--files', 'a.test.cjs']);
      assert.notStrictEqual(r.status, 0);
      assert.match(r.stderr, /duplicate --files/i);
    });

    test('--files and --files-from cannot be combined', () => {
      seed(tmpDir, ['a.test.cjs']);
      const listPath = path.join(tmpDir, 'selected-tests.txt');
      fs.writeFileSync(listPath, 'a.test.cjs\n', 'utf8');
      const r = runHarness(tmpDir, ['--files', 'a.test.cjs', '--files-from', listPath]);
      assert.notStrictEqual(r.status, 0);
      assert.match(r.stderr, /cannot be combined/i);
    });
  });

  describe('suite filtering', () => {
    test('no flag runs ALL test files (backcompat)', () => {
      seed(tmpDir, [
        'a.test.cjs',
        'b.security.test.cjs',
        'c.integration.test.cjs',
      ]);
      const r = runHarness(tmpDir);
      assert.strictEqual(r.status, 0);
      // node:test TAP output mentions each file path.
      assert.ok(r.stderr.includes('a.test.cjs'), 'expected a.test.cjs in output');
      assert.ok(
        r.stderr.includes('b.security.test.cjs'),
        'expected b.security.test.cjs in output',
      );
      assert.ok(
        r.stderr.includes('c.integration.test.cjs'),
        'expected c.integration.test.cjs in output',
      );
    });

    test('--suite all is equivalent to no flag', () => {
      seed(tmpDir, ['a.test.cjs', 'b.security.test.cjs']);
      const r = runHarness(tmpDir, ['--suite', 'all']);
      assert.strictEqual(r.status, 0);
      assert.ok(r.stderr.includes('a.test.cjs'));
      assert.ok(r.stderr.includes('b.security.test.cjs'));
    });

    test('--suite unit excludes marked suites', () => {
      seed(tmpDir, [
        'a.test.cjs',
        'b.security.test.cjs',
        'c.integration.test.cjs',
        'd.install.test.cjs',
        'e.slow.test.cjs',
      ]);
      const r = runHarness(tmpDir, ['--suite', 'unit']);
      assert.strictEqual(r.status, 0, `stderr: ${r.stderr}`);
      assert.ok(r.stderr.includes('a.test.cjs'));
      assert.ok(!r.stderr.includes('b.security.test.cjs'));
      assert.ok(!r.stderr.includes('c.integration.test.cjs'));
      assert.ok(!r.stderr.includes('d.install.test.cjs'));
      assert.ok(!r.stderr.includes('e.slow.test.cjs'));
    });

    test('--suite security selects only *.security.test.cjs', () => {
      seed(tmpDir, [
        'a.test.cjs',
        'b.security.test.cjs',
        'c.integration.test.cjs',
      ]);
      const r = runHarness(tmpDir, ['--suite', 'security']);
      assert.strictEqual(r.status, 0);
      assert.ok(r.stderr.includes('b.security.test.cjs'));
      assert.ok(!r.stderr.includes('a.test.cjs'));
      assert.ok(!r.stderr.includes('c.integration.test.cjs'));
    });

    test('--suite integration selects only *.integration.test.cjs', () => {
      seed(tmpDir, ['a.test.cjs', 'b.integration.test.cjs']);
      const r = runHarness(tmpDir, ['--suite', 'integration']);
      assert.strictEqual(r.status, 0);
      assert.ok(r.stderr.includes('b.integration.test.cjs'));
      assert.ok(!r.stderr.includes('a.test.cjs'));
    });

    test('--suite install selects only *.install.test.cjs', () => {
      seed(tmpDir, ['a.test.cjs', 'b.install.test.cjs']);
      const r = runHarness(tmpDir, ['--suite', 'install']);
      assert.strictEqual(r.status, 0);
      assert.ok(r.stderr.includes('b.install.test.cjs'));
    });

    test('--suite slow selects only *.slow.test.cjs', () => {
      seed(tmpDir, ['a.test.cjs', 'b.slow.test.cjs']);
      const r = runHarness(tmpDir, ['--suite', 'slow']);
      assert.strictEqual(r.status, 0);
      assert.ok(r.stderr.includes('b.slow.test.cjs'));
    });
  });

  describe('empty-suite behavior', () => {
    test('--suite security with zero matching files exits non-zero with an error', () => {
      seed(tmpDir, ['a.test.cjs']);
      const r = runHarness(tmpDir, ['--suite', 'security']);
      assert.notStrictEqual(r.status, 0);
      assert.match(r.stderr, /0 test files selected/i);
    });

    test('GSD_ALLOW_EMPTY_SUITE=1 downgrades empty suite to a warning and exits 0', () => {
      seed(tmpDir, ['a.test.cjs']);
      const r = runHarness(tmpDir, ['--suite', 'security'], { GSD_ALLOW_EMPTY_SUITE: '1' });
      assert.strictEqual(r.status, 0);
      assert.match(r.stderr, /WARNING.*0 test files selected/i);
    });

    test('completely empty test dir still exits non-zero (preserves prior behavior)', () => {
      const r = runHarness(tmpDir);
      assert.notStrictEqual(r.status, 0);
      assert.match(r.stderr, /no test files/i);
    });
  });

  describe('explicit file selection', () => {
    test('--files runs only the named tests', () => {
      seed(tmpDir, ['a.test.cjs', 'b.security.test.cjs', 'c.test.cjs']);
      const r = runHarness(tmpDir, ['--files', 'a.test.cjs tests/c.test.cjs']);
      assert.strictEqual(r.status, 0, `stderr: ${r.stderr}`);
      assert.ok(r.stderr.includes('a.test.cjs'));
      assert.ok(r.stderr.includes('c.test.cjs'));
      assert.ok(!r.stderr.includes('b.security.test.cjs'));
    });

    test('--files-from runs tests listed in a file', () => {
      seed(tmpDir, ['a.test.cjs', 'b.security.test.cjs', 'c.test.cjs']);
      const listPath = path.join(tmpDir, 'selected-tests.txt');
      fs.writeFileSync(listPath, 'a.test.cjs\nb.security.test.cjs\n', 'utf8');
      const r = runHarness(tmpDir, ['--files-from', listPath]);
      assert.strictEqual(r.status, 0, `stderr: ${r.stderr}`);
      assert.ok(r.stderr.includes('a.test.cjs'));
      assert.ok(r.stderr.includes('b.security.test.cjs'));
      assert.ok(!r.stderr.includes('c.test.cjs'));
    });

    test('missing explicit test file exits non-zero', () => {
      seed(tmpDir, ['a.test.cjs']);
      const r = runHarness(tmpDir, ['--files', 'a.test.cjs missing.test.cjs']);
      assert.notStrictEqual(r.status, 0);
      assert.match(r.stderr, /requested test file\(s\) not found: missing\.test\.cjs/i);
    });
  });

  describe('subdir file matching (findings #1 and #9)', () => {
    test('bare basename resolves to its single subdir file', () => {
      seed(tmpDir, ['sub/001-foo.test.cjs', 'b.test.cjs']);
      const r = runHarness(tmpDir, ['--files', '001-foo.test.cjs']);
      assert.strictEqual(r.status, 0, `stderr: ${r.stderr}`);
      assert.ok(r.stderr.includes('001-foo.test.cjs'));
      assert.ok(!r.stderr.includes('b.test.cjs'));
    });

    test('full subdir relpath matches exactly', () => {
      seed(tmpDir, ['sub/001-foo.test.cjs', 'b.test.cjs']);
      const r = runHarness(tmpDir, ['--files', 'sub/001-foo.test.cjs']);
      assert.strictEqual(r.status, 0, `stderr: ${r.stderr}`);
      assert.ok(r.stderr.includes('001-foo.test.cjs'));
      assert.ok(!r.stderr.includes('b.test.cjs'));
    });

    test('backslash-separated subdir path resolves on all platforms', () => {
      seed(tmpDir, ['sub/001-foo.test.cjs', 'b.test.cjs']);
      // Simulate a Windows caller passing backslash path
      const r = runHarness(tmpDir, ['--files', 'sub\\001-foo.test.cjs']);
      assert.strictEqual(r.status, 0, `stderr: ${r.stderr}`);
      assert.ok(r.stderr.includes('001-foo.test.cjs'));
    });

    test('tests/ prefix is stripped before subdir matching', () => {
      seed(tmpDir, ['sub/001-foo.test.cjs']);
      const r = runHarness(tmpDir, ['--files', 'tests/sub/001-foo.test.cjs']);
      assert.strictEqual(r.status, 0, `stderr: ${r.stderr}`);
      assert.ok(r.stderr.includes('001-foo.test.cjs'));
    });

    test('ambiguous bare basename exits non-zero with clear error', () => {
      seed(tmpDir, ['sub1/dup.test.cjs', 'sub2/dup.test.cjs']);
      const r = runHarness(tmpDir, ['--files', 'dup.test.cjs']);
      assert.notStrictEqual(r.status, 0);
      assert.match(r.stderr, /ambiguous basename/i);
      assert.match(r.stderr, /dup\.test\.cjs/);
      assert.match(r.stderr, /subdir path/i);
    });
  });

  describe('failure propagation', () => {
    test('non-zero from node:test propagates through harness', () => {
      const FAIL = `'use strict';
const { test } = require('node:test');
test('boom', () => { throw new Error('intentional'); });
`;
      fs.writeFileSync(path.join(tmpDir, 'a.test.cjs'), FAIL, 'utf8');
      const r = runHarness(tmpDir);
      assert.notStrictEqual(
        r.status,
        0,
        `expected non-zero exit; got status=${r.status} signal=${r.signal}\nSTDOUT:\n${r.stdout}\nSTDERR:\n${r.stderr}`,
      );
    });
  });

  describe('env hermeticity', () => {
    // Regression guard for the two `delete process.env.GSD_PROJECT/GSD_WORKSTREAM`
    // lines added in scripts/run-tests.cjs main() right after ensureBuiltArtifacts().
    // If those deletions are removed, the fixture's assertions fail inside the child
    // node:test process → non-zero harness exit → this test fails → CI catches it.
    test('harness strips GSD_PROJECT and GSD_WORKSTREAM before running child tests', () => {
      // Write a fixture that asserts both vars are absent in the child process env.
      const FIXTURE = `'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
test('ambient GSD workstream vars are stripped by the runner', () => {
  assert.strictEqual(process.env.GSD_PROJECT, undefined);
  assert.strictEqual(process.env.GSD_WORKSTREAM, undefined);
});
`;
      fs.writeFileSync(path.join(tmpDir, 'env-hermeticity.test.cjs'), FIXTURE, 'utf8');
      // Pass both vars in the ambient env given to the harness process.
      // The harness must delete them before spawning the child node:test process.
      const r = runHarness(tmpDir, [], {
        GSD_PROJECT: 'ambient-proj',
        GSD_WORKSTREAM: 'ambient-ws',
      });
      assert.strictEqual(r.status, 0, r.stderr);
    });
  });

  describe('Windows argv-overflow chunking (issue #3597)', () => {
    // Windows CreateProcess caps lpCommandLine at 32,767 chars. With ~550
    // tests the unchunked spawn fails instantly on Windows with no test
    // output. Linux/macOS allow ~2 MB so the same path works there. The
    // harness chunks selected files so each spawn stays under the ceiling,
    // and chunking is observable via the `run-tests: chunk N/M …` stderr
    // line. Long filenames force chunking even with a modest file count so
    // the test stays fast on every platform.
    test('chunks when total argv would exceed configured ceiling', () => {
      // Use a deliberately low MAX_CMDLINE_CHARS so the test is independent
      // of tmp-path length (varies by OS). With a 2000-char ceiling and 30
      // tests at ≥100 char paths, chunking must engage and at least one
      // `chunk N/M …` marker must appear in stderr.
      const longPrefix = 'a-deliberately-long-test-filename-to-force-chunking-behavior-cross-platform-';
      const names = Array.from({ length: 30 }, (_, i) => `${longPrefix}${String(i).padStart(4, '0')}.test.cjs`);
      seed(tmpDir, names);
      const r = runHarness(tmpDir, [], { RUN_TESTS_MAX_CMDLINE_CHARS: '2000' });
      assert.strictEqual(
        r.status,
        0,
        `expected zero exit; got status=${r.status} signal=${r.signal}\nSTDERR (tail):\n${r.stderr.split('\n').slice(-20).join('\n')}`,
      );
      assert.match(
        r.stderr,
        /run-tests: chunk \d+\/\d+ — \d+ files/,
        `expected chunking marker in stderr; STDERR (tail):\n${r.stderr.split('\n').slice(-20).join('\n')}`,
      );
    });

    test('chunks by file count even when argv length is below the ceiling', () => {
      const names = Array.from({ length: 7 }, (_, i) => `tiny-${String(i).padStart(2, '0')}.test.cjs`);
      seed(tmpDir, names);
      const r = runHarness(tmpDir, [], {
        RUN_TESTS_MAX_CMDLINE_CHARS: '100000',
        RUN_TESTS_MAX_FILES_PER_CHUNK: '3',
      });
      assert.strictEqual(
        r.status,
        0,
        `expected zero exit; got status=${r.status} signal=${r.signal}\nSTDERR:\n${r.stderr}`,
      );
      assert.match(
        r.stderr,
        /run-tests: chunk 1\/3 — 3 files/,
        `expected file-count chunking marker in stderr; STDERR:\n${r.stderr}`,
      );
      assert.match(
        r.stderr,
        /run-tests: chunk 3\/3 — 1 files/,
        `expected final file-count chunking marker in stderr; STDERR:\n${r.stderr}`,
      );
    });
  });

  describe('per-chunk timeout + force-exit (windows hang guard, #1051)', () => {
    // A unit test that leaks an open handle (un-terminated Worker, un-killed
    // child_process, ref'd timer) causes node --test to hang ~150s after its
    // last test prints. Two such stalls push the windows full lane past its
    // 20m CI cap and the job is CANCELLED — a false-negative gate. The harness
    // now adds --test-force-exit (exits once all tests finish) and a per-chunk
    // timeout (kills a hung child loudly instead of silently burning the budget).

    // Leaky fixture: the test passes immediately, then a ref'd setInterval keeps
    // the event loop alive so `node --test` hangs unless --test-force-exit is on.
    const LEAKY_BODY = `const { test } = require('node:test');
test('passes but leaks a ref-d timer', () => {});
setInterval(() => {}, 1 << 30);
`;

    test('a hung chunk hits the per-chunk timeout and fails with a clear message', () => {
      // Regression proof: pre-fix (no timeout guard) this hung until the OS/CI
      // killed it; now it fails fast with a diagnostic message.
      fs.writeFileSync(path.join(tmpDir, 'leaky.test.cjs'), LEAKY_BODY, 'utf8');
      const r = runHarness(tmpDir, [], {
        RUN_TESTS_NO_FORCE_EXIT: '1',
        RUN_TESTS_CHUNK_TIMEOUT_MS: '2000',
      });
      assert.notStrictEqual(
        r.status,
        0,
        `expected non-zero exit from timed-out chunk; got status=${r.status}\nSTDERR:\n${r.stderr}`,
      );
      assert.match(
        r.stderr,
        /exceeded the per-chunk timeout/,
        `expected timeout diagnostic in stderr; STDERR:\n${r.stderr}`,
      );
    });

    test('force-exit lets a chunk with a leaked handle exit cleanly', () => {
      const nodeMajor = Number(process.versions.node.split('.')[0]);
      // --test-force-exit was added in Node 22; skip on older engines.
      if (nodeMajor < 22) {
        return; // skip — harness test options object not available here; just return
      }
      fs.writeFileSync(path.join(tmpDir, 'leaky.test.cjs'), LEAKY_BODY, 'utf8');
      // force-exit is ON by default (RUN_TESTS_NO_FORCE_EXIT not set).
      // 30s timeout: if force-exit works the child exits promptly after the test
      // passes; if force-exit failed, the 30s timeout would fire and status ≠ 0.
      const r = runHarness(tmpDir, [], {
        RUN_TESTS_CHUNK_TIMEOUT_MS: '30000',
      });
      assert.strictEqual(
        r.status,
        0,
        `expected zero exit with force-exit enabled; got status=${r.status} signal=${r.signal}\nSTDERR:\n${r.stderr}`,
      );
    });
  });
});
