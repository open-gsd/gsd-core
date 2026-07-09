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

    // #2088: install-heavy files (real installs) are weighted so they never all
    // land in one chunk — otherwise the unsharded targeted lane packs the whole
    // install surface into a single chunk that blows the 600s per-chunk backstop
    // on the slow Windows runner.
    test('install-heavy files carry more weight so they SPREAD across chunks (#2088)', () => {
      // 4 install-* files at weight 3 = 12 against a 6-weight cap → 2 chunks
      // (2 heavy each). The whole install load is never in a single chunk.
      const heavy = Array.from({ length: 4 }, (_, i) => `install-weighttest-${i}.test.cjs`);
      seed(tmpDir, heavy);
      const rh = runHarness(tmpDir, [], {
        RUN_TESTS_MAX_CMDLINE_CHARS: '100000',
        RUN_TESTS_MAX_FILES_PER_CHUNK: '6',
        RUN_TESTS_HEAVY_FILE_WEIGHT: '3',
      });
      assert.strictEqual(rh.status, 0, `heavy: expected zero exit; STDERR:\n${rh.stderr}`);
      assert.match(rh.stderr, /run-tests: chunk 1\/2 — 2 files/, `install-heavy files must split into 2 chunks; STDERR:\n${rh.stderr}`);
      assert.match(rh.stderr, /run-tests: chunk 2\/2 — 2 files/, `STDERR:\n${rh.stderr}`);
    });

    test('light files of the same count stay in ONE chunk — split is weight-driven, not count-driven (#2088)', () => {
      // Same file COUNT (4) but LIGHT (weight 1 each): 4 < 6 cap → a single
      // chunk. Proves the split above is driven by install-heavy WEIGHT.
      const light = Array.from({ length: 4 }, (_, i) => `lightweighttest-${i}.test.cjs`);
      seed(tmpDir, light);
      const rl = runHarness(tmpDir, [], {
        RUN_TESTS_MAX_CMDLINE_CHARS: '100000',
        RUN_TESTS_MAX_FILES_PER_CHUNK: '6',
        RUN_TESTS_HEAVY_FILE_WEIGHT: '3',
      });
      assert.strictEqual(rl.status, 0, `light: expected zero exit; STDERR:\n${rl.stderr}`);
      // A single chunk emits NO `chunk N/M` split marker (it only prints when
      // chunks.length > 1), so its absence proves the 4 light files stayed together.
      assert.doesNotMatch(rl.stderr, /run-tests: chunk \d+\/\d+ — /, `4 light files must stay in one chunk (no split marker); STDERR:\n${rl.stderr}`);
    });
  });

  describe('shard partitioning CLI (#1212)', () => {
    // The windows full-test lane is sharded across N parallel runners via a
    // GitHub Actions matrix shard dimension; each shard runs
    // `run-tests.cjs --suite unit --shard i/n`. Selection is a deterministic
    // round-robin over the SORTED file list so duration variance spreads
    // across shards. The CLI surface is validated here; the pure partition
    // contract (completeness/disjointness/balance/determinism) is validated
    // against the exported selectShard() in the separate describe block below.

    // 9 files, sorted: shard-00..shard-08. With n=3, round-robin gives
    // shard 1 -> {00,03,06}, shard 2 -> {01,04,07}, shard 3 -> {02,05,08}.
    const SHARD_NAMES = Array.from(
      { length: 9 },
      (_, i) => `shard-${String(i).padStart(2, '0')}.test.cjs`,
    );

    test('--shard 1/3 runs a balanced round-robin slice of the sorted files', () => {
      seed(tmpDir, SHARD_NAMES);
      const r = runHarness(tmpDir, ['--shard', '1/3']);
      assert.strictEqual(r.status, 0, `stderr: ${r.stderr}`);
      // The harness echoes the selected basenames on its `files=N:` line.
      assert.match(r.stderr, /files=3:/);
      assert.match(r.stderr, /shard-00\.test\.cjs/);
      assert.match(r.stderr, /shard-03\.test\.cjs/);
      assert.match(r.stderr, /shard-06\.test\.cjs/);
      // Files belonging to other shards must NOT appear in this shard's run.
      assert.doesNotMatch(r.stderr, /shard-01\.test\.cjs/);
      assert.doesNotMatch(r.stderr, /shard-02\.test\.cjs/);
    });

    test('--shard 2/3 selects the second round-robin slice', () => {
      seed(tmpDir, SHARD_NAMES);
      const r = runHarness(tmpDir, ['--shard', '2/3']);
      assert.strictEqual(r.status, 0, `stderr: ${r.stderr}`);
      assert.match(r.stderr, /files=3:/);
      assert.match(r.stderr, /shard-01\.test\.cjs/);
      assert.match(r.stderr, /shard-04\.test\.cjs/);
      assert.match(r.stderr, /shard-07\.test\.cjs/);
      assert.doesNotMatch(r.stderr, /shard-00\.test\.cjs/);
    });

    test('--shard composes with --suite (shards the post-filter selection)', () => {
      // 6 unit files + 2 security files. `--suite unit --shard 1/2` must shard
      // only the unit selection, never pulling in the security files.
      seed(tmpDir, [
        'u0.test.cjs',
        'u1.test.cjs',
        'u2.test.cjs',
        'u3.test.cjs',
        's0.security.test.cjs',
        's1.security.test.cjs',
      ]);
      const r = runHarness(tmpDir, ['--suite', 'unit', '--shard', '1/2']);
      assert.strictEqual(r.status, 0, `stderr: ${r.stderr}`);
      assert.doesNotMatch(r.stderr, /\.security\.test\.cjs/);
    });

    test('--shard 1/1 is a pure no-op (runs every file)', () => {
      seed(tmpDir, SHARD_NAMES);
      const r = runHarness(tmpDir, ['--shard', '1/1']);
      assert.strictEqual(r.status, 0, `stderr: ${r.stderr}`);
      assert.match(r.stderr, /files=9:/);
    });

    test('an empty shard (n > file count) exits 0 without crashing', () => {
      // n=5 with only 2 files: shards 3,4,5 are legitimately empty. An empty
      // shard must NOT take the "discovery is broken" hard-error path.
      seed(tmpDir, ['only-a.test.cjs', 'only-b.test.cjs']);
      const r = runHarness(tmpDir, ['--shard', '5/5']);
      assert.strictEqual(
        r.status,
        0,
        `empty shard must exit 0; got status=${r.status} signal=${r.signal}\nSTDERR:\n${r.stderr}`,
      );
    });

    test('an empty suite BEFORE sharding still hits the discovery hard error', () => {
      // Regression (Codex #1212 review): a genuinely empty selection
      // (e.g. --suite security with zero security files) must NOT be masked
      // by the empty-shard escape hatch. Only a shard that emptied a NON-empty
      // list is a legitimate no-op; a pre-empty selection is a broken filter.
      seed(tmpDir, ['a.test.cjs', 'b.test.cjs']); // unit files only, no security
      const r = runHarness(tmpDir, ['--suite', 'security', '--shard', '1/3']);
      assert.notStrictEqual(
        r.status,
        0,
        `empty-before-shard must fail; got status=${r.status}\nSTDERR:\n${r.stderr}`,
      );
      assert.match(r.stderr, /0 test files selected|discovery/i);
    });

    test('--shard over --files is order-independent (sorted before partition)', () => {
      // Regression (Codex #1212 review): the partition keys off array index,
      // so the same file set passed in different --files order must produce
      // the same per-shard assignment. The runner sorts the selection before
      // sharding to guarantee this.
      seed(tmpDir, ['x0.test.cjs', 'x1.test.cjs', 'x2.test.cjs', 'x3.test.cjs']);
      const forward = runHarness(tmpDir, [
        '--files', 'x0.test.cjs x1.test.cjs x2.test.cjs x3.test.cjs',
        '--shard', '1/2',
      ]);
      const reversed = runHarness(tmpDir, [
        '--files', 'x3.test.cjs x2.test.cjs x1.test.cjs x0.test.cjs',
        '--shard', '1/2',
      ]);
      assert.strictEqual(forward.status, 0, `stderr: ${forward.stderr}`);
      assert.strictEqual(reversed.status, 0, `stderr: ${reversed.stderr}`);
      // Both runs select the SAME files (sorted shard 1/2 of x0..x3 = x0,x2).
      const filesLine = (s) => (s.match(/files=\d+: (.*)$/m) || [])[1] || '';
      const a = filesLine(forward.stderr).split(' ').sort().join(' ');
      const b = filesLine(reversed.stderr).split(' ').sort().join(' ');
      assert.strictEqual(a, b, `order-dependent shard assignment:\nforward=${a}\nreversed=${b}`);
      assert.match(a, /x0\.test\.cjs/);
      assert.match(a, /x2\.test\.cjs/);
    });

    test('--shard rejects i outside 1..n', () => {
      seed(tmpDir, SHARD_NAMES);
      const r = runHarness(tmpDir, ['--shard', '0/3']);
      assert.notStrictEqual(r.status, 0);
      assert.match(r.stderr, /shard/i);
    });

    test('--shard rejects i greater than n', () => {
      seed(tmpDir, SHARD_NAMES);
      const r = runHarness(tmpDir, ['--shard', '4/3']);
      assert.notStrictEqual(r.status, 0);
      assert.match(r.stderr, /shard/i);
    });

    test('--shard rejects n < 1', () => {
      seed(tmpDir, SHARD_NAMES);
      const r = runHarness(tmpDir, ['--shard', '1/0']);
      assert.notStrictEqual(r.status, 0);
      assert.match(r.stderr, /shard/i);
    });

    test('--shard rejects malformed (no slash) value', () => {
      seed(tmpDir, SHARD_NAMES);
      const r = runHarness(tmpDir, ['--shard', '2']);
      assert.notStrictEqual(r.status, 0);
      assert.match(r.stderr, /shard/i);
    });

    test('--shard rejects non-integer parts', () => {
      seed(tmpDir, SHARD_NAMES);
      const r = runHarness(tmpDir, ['--shard', '1.5/3']);
      assert.notStrictEqual(r.status, 0);
      assert.match(r.stderr, /shard/i);
    });

    test('duplicate --shard flag is rejected', () => {
      seed(tmpDir, SHARD_NAMES);
      const r = runHarness(tmpDir, ['--shard', '1/3', '--shard', '2/3']);
      assert.notStrictEqual(r.status, 0);
      assert.match(r.stderr, /duplicate/i);
    });

    test('--shard chunking engages within a shard (argv-overflow preserved)', () => {
      // Each shard must still chunk its own slice so a large shard cannot
      // overflow the Windows 32,767-char command-line ceiling (#3597).
      const longPrefix = 'a-deliberately-long-test-filename-to-force-chunking-within-a-shard-';
      const names = Array.from(
        { length: 30 },
        (_, i) => `${longPrefix}${String(i).padStart(4, '0')}.test.cjs`,
      );
      seed(tmpDir, names);
      // n=2 -> each shard gets 15 files; a 1500-char ceiling forces chunking.
      const r = runHarness(tmpDir, ['--shard', '1/2'], { RUN_TESTS_MAX_CMDLINE_CHARS: '1500' });
      assert.strictEqual(r.status, 0, `stderr (tail):\n${r.stderr.split('\n').slice(-20).join('\n')}`);
      assert.match(r.stderr, /run-tests: chunk \d+\/\d+ — \d+ files/);
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

// Pure partition contract for the shard selector (#1212). Imported directly
// (no subprocess) because these are deterministic in-memory assertions about
// the round-robin partition — the cheapest, most precise way to pin
// completeness / disjointness / balance / determinism, including a fast-check
// property test (RULESET.TESTS.property-based-testing: partition is a
// bijective transformation contract).
const { parseShardArg, selectShard } = require('../scripts/run-tests.cjs');

describe('selectShard round-robin partition (#1212)', () => {
  // A deterministic sorted file list; selectShard MUST NOT re-sort — the caller
  // sorts once and the partition keys off array index so ordering is identical
  // across Windows/macOS/Linux.
  const files = Array.from({ length: 25 }, (_, i) => `f${String(i).padStart(3, '0')}.test.cjs`);

  test('n=1 returns the full list unchanged (pure no-op)', () => {
    assert.deepStrictEqual(selectShard(files, { index: 1, total: 1 }), files);
  });

  test('completeness: the union of all shards equals the full list', () => {
    const n = 4;
    const union = [];
    for (let i = 1; i <= n; i++) union.push(...selectShard(files, { index: i, total: n }));
    assert.deepStrictEqual([...union].sort(), [...files].sort());
  });

  test('disjointness: no file appears in two shards', () => {
    const n = 4;
    const seen = new Set();
    for (let i = 1; i <= n; i++) {
      for (const f of selectShard(files, { index: i, total: n })) {
        assert.ok(!seen.has(f), `file ${f} appeared in more than one shard`);
        seen.add(f);
      }
    }
    assert.strictEqual(seen.size, files.length);
  });

  test('balance: shard sizes differ by at most 1', () => {
    const n = 4;
    const sizes = [];
    for (let i = 1; i <= n; i++) sizes.push(selectShard(files, { index: i, total: n }).length);
    assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1, `sizes=${sizes}`);
  });

  test('determinism: same input yields the same partition', () => {
    const a = selectShard(files, { index: 2, total: 3 });
    const b = selectShard(files, { index: 2, total: 3 });
    assert.deepStrictEqual(a, b);
  });

  test('round-robin: shard i gets indices i-1, i-1+n, i-1+2n, …', () => {
    const n = 3;
    assert.deepStrictEqual(
      selectShard(files, { index: 1, total: n }),
      files.filter((_, k) => k % n === 0),
    );
    assert.deepStrictEqual(
      selectShard(files, { index: 2, total: n }),
      files.filter((_, k) => k % n === 1),
    );
    assert.deepStrictEqual(
      selectShard(files, { index: 3, total: n }),
      files.filter((_, k) => k % n === 2),
    );
  });

  test('preserves relative order within a shard', () => {
    const slice = selectShard(files, { index: 1, total: 3 });
    const sorted = [...slice].sort();
    assert.deepStrictEqual(slice, sorted);
  });

  test('empty shard when total > file count returns []', () => {
    const two = ['a.test.cjs', 'b.test.cjs'];
    assert.deepStrictEqual(selectShard(two, { index: 5, total: 5 }), []);
    assert.deepStrictEqual(selectShard(two, { index: 3, total: 5 }), []);
    // shards 1 and 2 still get the two files
    assert.deepStrictEqual(selectShard(two, { index: 1, total: 5 }), ['a.test.cjs']);
    assert.deepStrictEqual(selectShard(two, { index: 2, total: 5 }), ['b.test.cjs']);
  });

  test('boundary: total exactly equals file count → one file per shard', () => {
    const three = ['a.test.cjs', 'b.test.cjs', 'c.test.cjs'];
    for (let i = 1; i <= 3; i++) {
      assert.strictEqual(selectShard(three, { index: i, total: 3 }).length, 1);
    }
  });

  test('boundary: total = count-1 and count+1', () => {
    const four = ['a.test.cjs', 'b.test.cjs', 'c.test.cjs', 'd.test.cjs'];
    // count-1 = 3 shards over 4 files → sizes {2,1,1}
    const sizes3 = [1, 2, 3].map(i => selectShard(four, { index: i, total: 3 }).length).sort();
    assert.deepStrictEqual(sizes3, [1, 1, 2]);
    // count+1 = 5 shards over 4 files → one shard empty
    const sizes5 = [1, 2, 3, 4, 5].map(i => selectShard(four, { index: i, total: 5 }).length).sort();
    assert.deepStrictEqual(sizes5, [0, 1, 1, 1, 1]);
  });

  test('property: partition is complete, disjoint, and balanced for any n,N', () => {
    const fc = require('fast-check');
    fc.assert(
      fc.property(
        fc.array(fc.string(), { minLength: 0, maxLength: 50 }),
        fc.integer({ min: 1, max: 12 }),
        (rawFiles, n) => {
          // Caller contract: deduped + sorted list. Mirror it so the property
          // exercises the same shape the runner feeds selectShard.
          const list = [...new Set(rawFiles)].sort();
          const shards = [];
          for (let i = 1; i <= n; i++) shards.push(selectShard(list, { index: i, total: n }));
          // completeness + disjointness
          const flat = shards.flat();
          assert.deepStrictEqual([...flat].sort(), [...list].sort());
          assert.strictEqual(new Set(flat).size, list.length);
          // balance — shard sizes differ by at most 1 (sizes is never empty
          // because n >= 1, so there is always at least one shard).
          const sizes = shards.map(s => s.length);
          assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1, `sizes=${sizes}`);
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('parseShardArg (#1212)', () => {
  test('parses i/n into { index, total }', () => {
    assert.deepStrictEqual(parseShardArg('2/3'), { index: 2, total: 3 });
    assert.deepStrictEqual(parseShardArg('1/1'), { index: 1, total: 1 });
  });

  const bad = ['', '2', '0/3', '4/3', '1/0', '-1/3', '1.5/3', 'a/b', '1/3/2', ' 1/3', '1 / 3'];
  for (const v of bad) {
    test(`rejects malformed/out-of-range value ${JSON.stringify(v)}`, () => {
      const r = parseShardArg(v);
      assert.ok(r && r.error, `expected an error result for ${JSON.stringify(v)}, got ${JSON.stringify(r)}`);
    });
  }
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-969-test-infra-flake-hardening.test.cjs — consolidation epic #1969 (B6 #1975)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-969-test-infra-flake-hardening (consolidation epic #1969 B6 #1975)", () => {
'use strict';
/**
 * Regression tests for bug #969 — test-infra flake hardening.
 *
 * Two root causes addressed:
 *
 *  A. SIGNATURE A: "X is not a function"
 *     ensureBuiltArtifacts() previously short-circuited on a single sentinel
 *     (semver-compare.cjs). If any other migrated .cjs was stale or absent,
 *     it would be silently loaded in that broken state. This test proves the
 *     unconditional-build fix: deleting a non-sentinel artifact and invoking
 *     ensureBuiltArtifacts() regenerates it even when the sentinel is present.
 *
 *  B. SIGNATURE B: misleading assertion failures from killed subprocesses
 *     runGsdTools() previously had no timeout, so an OOM/SIGKILL'd subprocess
 *     returned { success: false } and looked like a product error. This test
 *     proves the kill-discrimination fix: a killed/timed-out invocation now
 *     throws a labeled resource-starvation error, while a clean non-zero exit
 *     still returns { success: false, exitCode: N }.
 *
 *  C. SIGNATURE C: "Failed to install hooks: directory is empty" in scoped CI
 *     hooks/dist is gitignored and NOT built by `prepare` (build:lib only), so
 *     the scoped test lane starts with it absent. The first install test's
 *     before() hook triggers build-hooks.js, which creates DIST_DIR empty then
 *     fills it file-by-file — a window where a concurrently-spawned install
 *     reader sees zero hooks and hard-fails. ensureBuiltHooks() builds hooks/dist
 *     ONCE upfront (same chokepoint as ensureBuiltArtifacts) so the empty window
 *     never exists during concurrent test execution. These tests prove it
 *     rebuilds when dist is absent/empty/incomplete and no-ops when complete.
 *
 * RULESET.TESTS.regression-must-fail-first: each test section documents what
 * the old behavior would have been (fail-before) and asserts the new behavior
 * (pass-after), using only behavioral invocations — no source-grep.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const { ensureBuiltArtifacts, ensureBuiltHooks } = require('../scripts/run-tests.cjs');
const { cleanup } = require('./helpers.cjs');

// ---------------------------------------------------------------------------
// Part A — ensureBuiltArtifacts: unconditional rebuild
// ---------------------------------------------------------------------------

describe('bug #969 A — ensureBuiltArtifacts rebuilds stale artifacts', () => {
  /**
   * Helper: create a self-contained temp TypeScript project with two source files
   * (sentinelmod.cts and targetmod.cts) and a tsconfig that emits to <tmp>/out.
   * Returns { tmp, overrides, sentinelOut, targetOut, tsBuildInfoPath }.
   *
   * HERMETIC: all destructive tests use this helper. They NEVER touch the real
   * gsd-core/bin/lib/*.cjs or the real tsbuildinfo. (Regression from #996 fixed here.)
   */
  function makeTempProject() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-bug969-'));
    const srcDir = path.join(tmp, 'src');
    const outDir = path.join(tmp, 'out');
    const tsBuildInfoPath = path.join(outDir, '.tsbuildinfo');
    const tsconfigPath = path.join(tmp, 'tsconfig.build.json');

    fs.mkdirSync(srcDir, { recursive: true });
    fs.mkdirSync(outDir, { recursive: true });

    fs.writeFileSync(path.join(srcDir, 'sentinelmod.cts'), 'export const sentinelValue = 1;\n');
    fs.writeFileSync(path.join(srcDir, 'targetmod.cts'), 'export const targetValue = 2;\n');

    fs.writeFileSync(tsconfigPath, JSON.stringify({
      compilerOptions: {
        rootDir: 'src',
        outDir: 'out',
        module: 'commonjs',
        target: 'es2022',
        esModuleInterop: true,
        noEmitOnError: true,
        incremental: true,
        tsBuildInfoFile: 'out/.tsbuildinfo',
      },
      include: ['src/**/*.cts'],
    }, null, 2));

    const overrides = { root: tmp, srcDir, outDir, tsBuildInfoPath, tsconfigPath };
    const sentinelOut = path.join(outDir, 'sentinelmod.cjs');
    const targetOut = path.join(outDir, 'targetmod.cjs');
    return { tmp, overrides, sentinelOut, targetOut, tsBuildInfoPath };
  }

  /**
   * FAIL-BEFORE (origin/next behavior):
   *   The old code contained `if (existsSync(sentinel)) return;`. When the
   *   sentinel (semver-compare.cjs) was present, the function returned early
   *   without touching any other .cjs. This test confirms the new code always
   *   invokes tsc — it would have returned immediately on origin/next.
   *
   *   Specifically: on origin/next, after deleting a non-sentinel artifact +
   *   its tsbuildinfo and calling ensureBuiltArtifacts() with sentinel present,
   *   the artifact would remain absent. On the fix, tsc runs unconditionally
   *   and recreates it.
   *
   * PASS-AFTER (fix):
   *   The sentinel guard is removed. ensureBuiltArtifacts() always invokes tsc.
   *   With no tsbuildinfo present (clean state), tsc performs a full emit and
   *   recreates all .cjs outputs including the deleted non-sentinel artifact.
   *
   * HERMETIC: this test operates on a self-contained temp project. It NEVER
   * touches gsd-core/bin/lib/core.cjs or the real tsbuildinfo. (Fixed from #996.)
   */
  test('rebuilds a non-sentinel artifact (with no tsbuildinfo) even when sentinel exists', () => {
    const { tmp, overrides, sentinelOut, targetOut, tsBuildInfoPath } = makeTempProject();
    try {
      // Initial build — both outputs must appear.
      ensureBuiltArtifacts(overrides);
      assert.ok(fs.existsSync(sentinelOut), 'initial build: sentinelmod.cjs must exist');
      assert.ok(fs.existsSync(targetOut), 'initial build: targetmod.cjs must exist');

      // Simulate: fresh CI checkout — target artifact missing, no tsbuildinfo.
      fs.unlinkSync(targetOut);
      if (fs.existsSync(tsBuildInfoPath)) fs.unlinkSync(tsBuildInfoPath);

      assert.ok(!fs.existsSync(targetOut), 'pre-condition: targetmod.cjs must be absent');
      assert.ok(fs.existsSync(sentinelOut), 'pre-condition: sentinelmod.cjs must still be present');

      // Under the OLD code this returned immediately (sentinel present → return).
      // Under the NEW code this calls tsc unconditionally → full emit → recreated.
      ensureBuiltArtifacts(overrides);

      assert.ok(
        fs.existsSync(targetOut),
        'ensureBuiltArtifacts must recreate targetmod.cjs even when sentinelmod.cjs ' +
        'exists (sentinel-short-circuit was removed in fix #969)'
      );
    } finally {
      cleanup(tmp);
    }
  });

  /**
   * PASS-AFTER: the unconditional build emits the expected output (sentinelmod.cjs).
   * Uses the temp project helper so this test is fully hermetic — it never touches
   * the real gsd-core/bin/lib tree.
   */
  test('sentinel (semver-compare.cjs) still exists after unconditional build', () => {
    const { tmp, overrides, sentinelOut } = makeTempProject();
    try {
      ensureBuiltArtifacts(overrides);
      assert.ok(fs.existsSync(sentinelOut), 'sentinel output (sentinelmod.cjs) must exist after ensureBuiltArtifacts');
    } finally {
      cleanup(tmp);
    }
  });

  /**
   * PERSISTENT-MIRROR CASE — the residual hole found by adversarial review.
   *
   * FAIL-BEFORE (incremental: true — the old behavior on this branch):
   *   With "incremental": true in tsconfig.build.json, tsc reads the .tsbuildinfo
   *   on disk. If sources are unchanged since the last build, tsc skips re-emitting
   *   any outputs — including outputs that were deleted or overwritten by an rsync
   *   from a different branch. This is the persistent-docker-mirror scenario:
   *     1. A prior branch rsync'd a stale core.cjs into bin/lib/
   *     2. A stale tsbuildinfo is present (from that same branch)
   *     3. ensureBuiltArtifacts() calls tsc (incremental)
   *     4. tsc sees "sources unchanged vs tsbuildinfo" → no-ops → stale .cjs served
   *   With "incremental": true this test would FAIL because targetmod.cjs remains absent.
   *
   * PASS-AFTER (step-3 unlink+clean-reemit logic):
   *   When a missing/zero-bytes output is detected after the incremental pass,
   *   ensureBuiltArtifacts() unlinks the tsbuildinfo and runs tsc a second time
   *   (clean re-emit). The stale/missing output is always regenerated.
   *
   * HERMETIC: this test operates on a self-contained temp project. It NEVER
   * touches gsd-core/bin/lib/core.cjs or the real tsbuildinfo. (Fixed from #996.)
   */
  test('PERSISTENT-MIRROR: rebuilds stale output even when tsbuildinfo is present (non-incremental is authoritative)', () => {
    const { tmp, overrides, targetOut, tsBuildInfoPath } = makeTempProject();
    const STALE_TSBUILDINFO = JSON.stringify({
      program: { fileNames: [], options: { incremental: true } },
      version: '5.0.0',
      _gsd_test_marker: 'stale-persistent-mirror',
    });

    try {
      // Initial build to populate outputs.
      ensureBuiltArtifacts(overrides);
      assert.ok(fs.existsSync(targetOut), 'initial build: targetmod.cjs must exist');

      // Inject a stale tsbuildinfo (mirrors: old branch rsync'd state onto workspace).
      fs.writeFileSync(tsBuildInfoPath, STALE_TSBUILDINFO);
      // Delete the output .cjs (mirrors: stale/missing output on the persistent mirror).
      fs.unlinkSync(targetOut);

      assert.ok(!fs.existsSync(targetOut), 'pre-condition: targetmod.cjs must be absent');
      assert.ok(fs.existsSync(tsBuildInfoPath), 'pre-condition: tsbuildinfo must be present');

      // FAIL-BEFORE (incremental: true, no step-3): tsc would read the stale
      // tsbuildinfo, see "sources unchanged", and skip re-emitting targetmod.cjs
      // → it would remain absent.
      //
      // PASS-AFTER (step-3 unlink+clean-reemit): missing output detected after
      // incremental pass → tsbuildinfo unlinked → tsc runs again → targetmod.cjs
      // is regenerated unconditionally.
      ensureBuiltArtifacts(overrides);

      assert.ok(
        fs.existsSync(targetOut),
        'ensureBuiltArtifacts must regenerate targetmod.cjs even when a stale ' +
        'tsbuildinfo is present on disk (persistent-mirror scenario — ' +
        'incremental:true alone would have no-op\'d here)'
      );

      // Verify the regenerated file is valid JS.
      const regenerated = fs.readFileSync(targetOut, 'utf-8');
      assert.ok(regenerated.length > 0, 'regenerated targetmod.cjs must be non-empty');
      assert.ok(
        regenerated.includes('exports.') || regenerated.includes('"use strict"'),
        'regenerated targetmod.cjs must look like a valid CommonJS module'
      );
    } finally {
      cleanup(tmp);
    }
  });
});

// ---------------------------------------------------------------------------
// Part B — runGsdTools: timeout + kill-signal discrimination
// ---------------------------------------------------------------------------

describe('bug #969 B — runGsdTools kill-signal discrimination', () => {
  const TOOLS_PATH = path.join(__dirname, '..', 'gsd-core', 'bin', 'gsd-tools.cjs');

  /**
   * Shared helper that mirrors the production runGsdTools implementation
   * (from tests/helpers.cjs) but accepts an explicit timeout so we can
   * trigger the kill path in tests without waiting 60 seconds.
   *
   * IMPORTANT: this helper is intentionally self-contained so that the test
   * proves the CONTRACT of the implementation, not just calls the real
   * runGsdTools (which would need a real 60s+ hang to trigger in tests).
   * We test the identical logic paths using a tiny timeout.
   */
  function runGsdToolsWithTimeout(args, cwd, env, timeoutMs) {
    const TEST_ENV_BASE = {
      GSD_SESSION_KEY: '',
      CODEX_THREAD_ID: '',
      CLAUDE_SESSION_ID: '',
    };
    try {
      let result;
      const childEnv = { ...process.env, ...TEST_ENV_BASE, ...(env || {}) };
      const argv = Array.isArray(args)
        ? args
        : (args.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [])
            .map(t => t.replace(/"([^"]*)"/g, '$1').replace(/'([^']*)'/g, '$1'));
      result = execFileSync(process.execPath, [TOOLS_PATH, ...argv], {
        cwd: cwd || process.cwd(),
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        env: childEnv,
        timeout: timeoutMs,
      });
      return { success: true, output: result.trim(), exitCode: 0 };
    } catch (err) {
      // Production kill-discrimination logic (verbatim from helpers.cjs fix).
      if (err.killed || err.signal != null || err.code === 'ETIMEDOUT') {
        throw new Error(
          `[runGsdTools: resource-starvation / subprocess-kill] ` +
          `gsd-tools was killed before completion ` +
          `(signal=${err.signal}, code=${err.code}, killed=${err.killed}). ` +
          `This indicates host OOM or scheduler contention, not a product bug. ` +
          `stdout=${err.stdout?.toString().trim() || ''} ` +
          `stderr=${err.stderr?.toString().trim() || ''}`
        );
      }
      const stderrRaw = err.stderr?.toString().trim() || '';
      const error = stderrRaw || `${err.message} [stderr: (empty) exit:${err.status ?? 1}]`;
      return {
        success: false,
        output: err.stdout?.toString().trim() || '',
        error,
        exitCode: err.status ?? 1,
      };
    }
  }

  /**
   * FAIL-BEFORE (origin/next behavior):
   *   Without a timeout, an OOM-killed subprocess threw with err.killed=true
   *   but the catch block fell through to `return { success: false, ... }`.
   *   The test consumer saw a normal {success:false} result and tried to parse
   *   gsd-tools output from it, causing a confusing downstream assertion fail.
   *
   * PASS-AFTER (fix):
   *   The kill-discrimination guard rethrows immediately with a labeled error
   *   message containing "resource-starvation / subprocess-kill". The test
   *   asserts on that throw rather than getting a silent {success:false}.
   *
   * Mechanism: we use a tiny timeout (1ms) to guarantee a timeout-kill on a
   * real gsd-tools invocation (even `--help` takes >1ms to start node).
   */
  test('throws a resource-starvation error when subprocess is killed/times out', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-969-'));
    try {
      // 1ms timeout guarantees ETIMEDOUT / killed before gsd-tools can respond.
      assert.throws(
        () => runGsdToolsWithTimeout(['--help'], tmpDir, {}, 1),
        (err) => {
          assert.ok(
            err.message.includes('resource-starvation / subprocess-kill'),
            `Expected labeled resource-starvation error, got: ${err.message}`
          );
          return true;
        }
      );
    } finally {
      cleanup(tmpDir);
    }
  });

  /**
   * Verify that a normal fast command still returns { success: true } and does
   * NOT throw — i.e., the timeout addition does not break the happy path.
   */
  test('returns { success: true } for a normal fast command with generous timeout', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-969-'));
    try {
      // 30s timeout; gsd-tools --help completes in well under 1s.
      const result = runGsdToolsWithTimeout(['--help'], tmpDir, {}, 30000);
      assert.ok(result.success === true, `Expected success:true, got ${JSON.stringify(result)}`);
      assert.ok(typeof result.output === 'string', 'output must be a string');
    } finally {
      cleanup(tmpDir);
    }
  });

  /**
   * Verify that a clean non-zero exit (a real gsd-tools application error, not
   * a kill) still returns { success: false } WITHOUT throwing. This preserves
   * existing test behavior that asserts on error shape.
   *
   * We trigger a clean non-zero by invoking a command that is known to fail
   * cleanly (no project directory set up).
   */
  test('returns { success: false } for a clean non-zero exit (no throw)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-969-'));
    try {
      // 'phase list' on a directory with no .planning/ produces a clean error exit.
      const result = runGsdToolsWithTimeout(['phase', 'list'], tmpDir, {}, 30000);
      assert.ok(result.success === false, `Expected success:false for clean error, got ${JSON.stringify(result)}`);
      assert.ok(result.exitCode !== 0, 'exitCode must be non-zero');
      // Must NOT have thrown — the clean-error path returns normally.
    } finally {
      cleanup(tmpDir);
    }
  });
});

// ---------------------------------------------------------------------------
// Part C — ensureBuiltHooks: build hooks/dist once, closing the scoped-CI
// first-build empty-dir race.
// ---------------------------------------------------------------------------

describe('bug #969 C — ensureBuiltHooks populates hooks/dist before concurrent tests', () => {
  /**
   * Helper: a hermetic temp dist dir + a runBuild spy. The spy records how many
   * times a build was requested and, when invoked, writes the given hook files
   * (simulating build-hooks.js populating DIST_DIR) so idempotency is testable.
   *
   * HERMETIC: never touches the real hooks/dist. Uses dependency-injected
   * overrides (distDir, hookNames, runBuild) — no fs monkeypatching, so the test
   * is deterministic and root/OS-independent.
   */
  function makeHooksFixture(hookNames) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-969-hooks-'));
    const distDir = path.join(tmp, 'hooks', 'dist');
    let buildCalls = 0;
    const runBuild = () => {
      buildCalls += 1;
      fs.mkdirSync(distDir, { recursive: true });
      for (const h of hookNames) {
        fs.writeFileSync(path.join(distDir, h), `// ${h}\nmodule.exports = {};\n`);
      }
    };
    const overrides = () => ({ distDir, hookNames, runBuild });
    return { tmp, distDir, hookNames, overrides, calls: () => buildCalls };
  }

  const HOOKS = ['a-hook.js', 'b-hook.js', 'c-hook.sh'];

  /**
   * FAIL-BEFORE (origin/next): ensureBuiltHooks did not exist, so the export was
   * undefined and there was no upfront hooks build — the first concurrent
   * install test raced build-hooks.js's empty-then-fill window. The import at the
   * top of this file (ensureBuiltHooks) is itself the fail-first anchor: on
   * origin/next it is undefined and every test below throws "not a function".
   *
   * PASS-AFTER: ensureBuiltHooks() builds when hooks/dist is entirely absent.
   */
  test('builds when hooks/dist is absent (fresh checkout / scoped CI)', () => {
    const fx = makeHooksFixture(HOOKS);
    try {
      assert.equal(typeof ensureBuiltHooks, 'function',
        'ensureBuiltHooks must be exported (absent on origin/next — the fail-first anchor)');
      assert.ok(!fs.existsSync(fx.distDir), 'pre-condition: hooks/dist must be absent');
      ensureBuiltHooks(fx.overrides());
      assert.equal(fx.calls(), 1, 'a build must be triggered when dist is absent');
      for (const h of HOOKS) {
        assert.ok(fs.existsSync(path.join(fx.distDir, h)), `${h} must exist after build`);
      }
    } finally {
      cleanup(fx.tmp);
    }
  });

  /**
   * BOUNDARY: dist exists but is empty (0 of N hooks) — the exact transient state
   * build-hooks.js exposes between mkdir(DIST_DIR) and the first file rename.
   */
  test('builds when hooks/dist exists but is empty (0 of N)', () => {
    const fx = makeHooksFixture(HOOKS);
    try {
      fs.mkdirSync(fx.distDir, { recursive: true }); // empty dir — the race window
      ensureBuiltHooks(fx.overrides());
      assert.equal(fx.calls(), 1, 'an empty dist must trigger a build');
    } finally {
      cleanup(fx.tmp);
    }
  });

  /**
   * BOUNDARY: dist has all-but-one hook (N-1 of N) — a partially-filled dir mid
   * first-build. Must still be treated as incomplete and rebuilt.
   */
  test('builds when hooks/dist is partial (N-1 of N)', () => {
    const fx = makeHooksFixture(HOOKS);
    try {
      fs.mkdirSync(fx.distDir, { recursive: true });
      for (const h of HOOKS.slice(0, HOOKS.length - 1)) {
        fs.writeFileSync(path.join(fx.distDir, h), 'x');
      }
      ensureBuiltHooks(fx.overrides());
      assert.equal(fx.calls(), 1, 'a partial dist (missing one hook) must trigger a build');
    } finally {
      cleanup(fx.tmp);
    }
  });

  /**
   * BOUNDARY: a zero-byte hook (N of N present, but one is 0 bytes) — a truncated
   * mid-write file. statSync().size === 0 must count as incomplete → rebuild.
   */
  test('builds when a hook file is present but zero-byte', () => {
    const fx = makeHooksFixture(HOOKS);
    try {
      fs.mkdirSync(fx.distDir, { recursive: true });
      HOOKS.forEach((h, i) => {
        fs.writeFileSync(path.join(fx.distDir, h), i === 0 ? '' : 'ok'); // first is 0 bytes
      });
      ensureBuiltHooks(fx.overrides());
      assert.equal(fx.calls(), 1, 'a zero-byte hook must be treated as incomplete → rebuild');
    } finally {
      cleanup(fx.tmp);
    }
  });

  /**
   * BOUNDARY + idempotency: dist is complete (all N present, non-empty). No build
   * must fire — this keeps nested run-tests spawns and repeat invocations cheap
   * and avoids a redundant concurrent build against an already-populated dist.
   */
  test('no-op when hooks/dist is complete (N of N non-empty)', () => {
    const fx = makeHooksFixture(HOOKS);
    try {
      fs.mkdirSync(fx.distDir, { recursive: true });
      for (const h of HOOKS) fs.writeFileSync(path.join(fx.distDir, h), 'ok');
      ensureBuiltHooks(fx.overrides());
      assert.equal(fx.calls(), 0, 'a complete dist must NOT trigger a build (idempotent no-op)');
    } finally {
      cleanup(fx.tmp);
    }
  });

  /**
   * Integration guard: the REAL default hook set (from build-hooks.js) is what
   * ensureBuiltHooks checks when no override is given. Prove the real export is a
   * non-empty list so the completeness predicate can never vacuously pass.
   */
  test('default hook set (build-hooks.js HOOKS_TO_COPY) is a non-empty list', () => {
    const { HOOKS_TO_COPY } = require('../scripts/build-hooks.js');
    assert.ok(Array.isArray(HOOKS_TO_COPY) && HOOKS_TO_COPY.length > 0,
      'HOOKS_TO_COPY must be a non-empty array or the completeness check is vacuous');
  });
});
  });
}
