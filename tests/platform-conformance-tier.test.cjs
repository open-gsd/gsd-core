'use strict';

/**
 * Test matrix: .gsd/phase/chore-4591-conformance-tier-linux-primary/50-test-matrix.md
 *
 * Rows 1-15 exercise the pure, exported `classifyContent(content)` classifier
 * directly on short string fixtures. Rows 16-18 exercise the
 * `--check`/`--write` CLI behavior against a small temp fixture tree, driven
 * through the process seam (tests/helpers/process-seam.cjs's `runNode`) per
 * CONTRIBUTING.md's "spawning a subprocess: use the process seam" rule. Row
 * 19 is a real-tree regression proving the committed generated file matches a
 * fresh sweep of this repo's actual tests/ tree. Rows 20-21 prove the
 * suite-exclusion fix (#4591 CI incident): a suite-tagged file must never
 * enter the conformance-tier pool even when its content would otherwise
 * qualify, and the committed generated file must contain zero such files.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createTempDir, cleanup } = require('./helpers.cjs');
const { runNode } = require('./helpers/process-seam.cjs');
const { classifyContent, classifyTree, NOISY_FOR_SOURCE_REACHABILITY } = require('../scripts/gen-platform-conformance-tier.cjs');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'gen-platform-conformance-tier.cjs');
const GENERATED_PATH = path.join(ROOT, 'scripts', 'lib', 'platform-conformance-tier.generated.cjs');

// ─── Rows 1-15: classifyContent, pure fixtures ────────────────────────────────

describe('classifyContent — happy-path signals', () => {
  test('flags process.platform', () => {
    const { needsRealOs, signals } = classifyContent("if (process.platform === 'win32') { doThing(); }");
    assert.equal(needsRealOs, true);
    assert.ok(signals.includes('process-platform'));
  });

  test('flags os.platform()', () => {
    const { needsRealOs, signals } = classifyContent("const os = require('node:os');\nconst p = os.platform();");
    assert.equal(needsRealOs, true);
    assert.ok(signals.includes('os-platform'));
  });

  test('flags win32 literal', () => {
    const { needsRealOs, signals } = classifyContent("const platforms = ['win32', 'linux'];");
    assert.equal(needsRealOs, true);
    assert.ok(signals.includes('win32-darwin-literal'));
  });

  test('flags darwin literal', () => {
    const { needsRealOs, signals } = classifyContent("const platforms = ['darwin', 'linux'];");
    assert.equal(needsRealOs, true);
    assert.ok(signals.includes('win32-darwin-literal'));
  });

  test('flags chmod mode-bit octal', () => {
    const { needsRealOs, signals } = classifyContent('fs.chmodSync(target, 0o755);');
    assert.equal(needsRealOs, true);
    assert.ok(signals.includes('chmod-mode-bit'));
  });

  test('flags Windows-shell tokens', () => {
    for (const fixture of ["spawn('cmd.exe', args)", "spawn('powershell', args)", 'const e = process.env.ComSpec;']) {
      const { needsRealOs, signals } = classifyContent(fixture);
      assert.equal(needsRealOs, true, fixture);
      assert.ok(signals.includes('windows-shell-token'), fixture);
    }
  });

  test('flags Windows env-var names', () => {
    for (const fixture of [
      'const home = process.env.USERPROFILE;',
      'const drive = process.env.HOMEDRIVE;',
      'const p = process.env.HOMEPATH;',
    ]) {
      const { needsRealOs, signals } = classifyContent(fixture);
      assert.equal(needsRealOs, true, fixture);
      assert.ok(signals.includes('windows-env-var'), fixture);
    }
  });

  test('flags process-seam subprocess helpers', () => {
    for (const fixture of [
      "runNode(['--check'])",
      "runGit(['status'])",
      "runHook(HOOK_PATH, [])",
      "runGsdTools(['state', 'show'])",
    ]) {
      const { needsRealOs, signals } = classifyContent(fixture);
      assert.equal(needsRealOs, true, fixture);
      assert.ok(signals.includes('process-seam-subprocess'), fixture);
    }
  });

  test('flags raw child_process usage', () => {
    const fixture = "const { execFileSync } = require('child_process');\nexecFileSync('ls', []);";
    const { needsRealOs, signals } = classifyContent(fixture);
    assert.equal(needsRealOs, true);
    assert.ok(signals.includes('raw-child-process'));
  });

  test('flags symlink keyword', () => {
    const { needsRealOs, signals } = classifyContent('fs.symlinkSync(target, link);');
    assert.equal(needsRealOs, true);
    assert.ok(signals.includes('symlink-keyword'));
  });

  test('flags hardcoded path literal vs path.* call', () => {
    const fixture = "const p = path.join(root, 'x');\nassert.equal(rendered, '/etc/passwd');";
    const { needsRealOs, signals } = classifyContent(fixture);
    assert.equal(needsRealOs, true);
    assert.ok(signals.includes('hardcoded-path-vs-path-call'));
  });
});

describe('classifyContent — negative / hostile inputs', () => {
  test('does not flag a clean in-process unit test', () => {
    const fixture = "const assert = require('node:assert/strict');\ntest('adds numbers', () => { assert.equal(1 + 1, 2); });";
    const { needsRealOs, signals } = classifyContent(fixture);
    assert.equal(needsRealOs, false);
    assert.deepEqual(signals, []);
  });

  test('does not flag incidental use of the word "path"', () => {
    const fixture = '// This test verifies the correct path through the state machine.\nassert.ok(true);';
    const { needsRealOs } = classifyContent(fixture);
    assert.equal(needsRealOs, false);
  });

  test('does not crash on empty content', () => {
    assert.doesNotThrow(() => classifyContent(''));
    const { needsRealOs, signals } = classifyContent('');
    assert.equal(needsRealOs, false);
    assert.deepEqual(signals, []);
  });

  test('does not flag an unrelated identifier containing "spawn"', () => {
    const fixture = 'const spawnResult = computeSomething();\nassert.ok(spawnResult);';
    const { needsRealOs, signals } = classifyContent(fixture);
    assert.equal(needsRealOs, false);
    assert.deepEqual(signals, []);
  });
});

// ─── Row 15 (#4592): NOISY_FOR_SOURCE_REACHABILITY drift guard ────────────────

describe('NOISY_FOR_SOURCE_REACHABILITY (#4592)', () => {
  test('NOISY_FOR_SOURCE_REACHABILITY exports exactly the two noisy categories', () => {
    assert.ok(NOISY_FOR_SOURCE_REACHABILITY instanceof Set,
      `expected a Set, got: ${typeof NOISY_FOR_SOURCE_REACHABILITY}`);
    assert.deepEqual(
      [...NOISY_FOR_SOURCE_REACHABILITY].sort(),
      ['hardcoded-path-vs-path-call', 'symlink-keyword'].sort(),
      `expected exactly the two named noisy categories, got: ${JSON.stringify([...NOISY_FOR_SOURCE_REACHABILITY])}`,
    );
  });
});

// ─── Rows 16-18: CLI --check/--write against a temp fixture tree ──────────────

/** Spawn the real generator CLI via the process seam. */
function runGen(args) {
  return runNode([SCRIPT, ...args]);
}

describe('gen-platform-conformance-tier.cjs CLI (temp fixture tree)', () => {
  test('--check passes when the generated file is fresh', () => {
    const tmpDir = createTempDir('gen-platform-conformance-tier-');
    try {
      const testsDir = path.join(tmpDir, 'tests');
      fs.mkdirSync(testsDir, { recursive: true });
      fs.writeFileSync(path.join(testsDir, 'flagged.test.cjs'), "if (process.platform === 'win32') {}\n");
      fs.writeFileSync(path.join(testsDir, 'clean.test.cjs'), "assert.equal(1 + 1, 2);\n");
      const outPath = path.join(tmpDir, 'platform-conformance-tier.generated.cjs');

      const write = runGen(['--write', '--tests-dir', testsDir, '--out', outPath]);
      assert.equal(write.exitCode, 0, write.stderr);
      assert.ok(fs.existsSync(outPath));

      const check = runGen(['--check', '--tests-dir', testsDir, '--out', outPath]);
      assert.equal(check.exitCode, 0, check.stderr);
      assert.match(check.stdout, /ok gen-platform-conformance-tier/);
    } finally {
      cleanup(tmpDir);
    }
  });

  test('--check fails and names the drift when the list is stale', () => {
    const tmpDir = createTempDir('gen-platform-conformance-tier-');
    try {
      const testsDir = path.join(tmpDir, 'tests');
      fs.mkdirSync(testsDir, { recursive: true });
      fs.writeFileSync(path.join(testsDir, 'flagged.test.cjs'), "if (process.platform === 'win32') {}\n");
      fs.writeFileSync(path.join(testsDir, 'clean.test.cjs'), "assert.equal(1 + 1, 2);\n");
      const outPath = path.join(tmpDir, 'platform-conformance-tier.generated.cjs');

      const write = runGen(['--write', '--tests-dir', testsDir, '--out', outPath]);
      assert.equal(write.exitCode, 0, write.stderr);

      // Introduce drift: a brand-new signal-bearing file the committed list
      // has never seen.
      fs.writeFileSync(path.join(testsDir, 'new-signal.test.cjs'), 'fs.symlinkSync(target, link);\n');

      const check = runGen(['--check', '--tests-dir', testsDir, '--out', outPath]);
      assert.equal(check.exitCode, 1);
      const combined = check.stdout + check.stderr;
      assert.match(combined, /tests\/new-signal\.test\.cjs/, 'the drift report must name the new file');
      assert.match(combined, /\+/, 'a newly-added file is reported with a + marker');
    } finally {
      cleanup(tmpDir);
    }
  });

  test('--write is deterministic across repeated runs', () => {
    const tmpDir = createTempDir('gen-platform-conformance-tier-');
    try {
      const testsDir = path.join(tmpDir, 'tests');
      fs.mkdirSync(testsDir, { recursive: true });
      fs.writeFileSync(path.join(testsDir, 'a.test.cjs'), "process.env.PATHEXT;\n");
      fs.writeFileSync(path.join(testsDir, 'b.test.cjs'), 'fs.symlinkSync(target, link);\n');
      const out1 = path.join(tmpDir, 'out1.generated.cjs');
      const out2 = path.join(tmpDir, 'out2.generated.cjs');

      assert.equal(runGen(['--write', '--tests-dir', testsDir, '--out', out1]).exitCode, 0);
      assert.equal(runGen(['--write', '--tests-dir', testsDir, '--out', out2]).exitCode, 0);

      const content1 = fs.readFileSync(out1, 'utf8');
      const content2 = fs.readFileSync(out2, 'utf8');
      assert.equal(content1, content2, '--write must be byte-identical across independent runs over the same input');
    } finally {
      cleanup(tmpDir);
    }
  });
});

// ─── Row 20: suite-tagged files are excluded even when their content qualifies

describe('gen-platform-conformance-tier.cjs CLI (temp fixture tree) — suite exclusion', () => {
  test('a suite-suffixed file is excluded even with a qualifying content signal', () => {
    const tmpDir = createTempDir('gen-platform-conformance-tier-suite-');
    try {
      const testsDir = path.join(tmpDir, 'tests');
      fs.mkdirSync(testsDir, { recursive: true });
      const signal = "if (process.platform === 'win32') {}\n";
      fs.writeFileSync(path.join(testsDir, 'foo.test.cjs'), signal);
      fs.writeFileSync(path.join(testsDir, 'foo.install.test.cjs'), signal);
      const outPath = path.join(tmpDir, 'platform-conformance-tier.generated.cjs');

      const write = runGen(['--write', '--tests-dir', testsDir, '--out', outPath]);
      assert.equal(write.exitCode, 0, write.stderr);

      delete require.cache[require.resolve(outPath)];
      const generated = require(outPath);

      assert.deepEqual(
        generated.CONFORMANCE_TIER_FILES,
        ['tests/foo.test.cjs'],
        'the install-suite file must be excluded even though its content would otherwise qualify',
      );
    } finally {
      cleanup(tmpDir);
    }
  });
});

// ─── Row 19: real tests/ tree, regression against the committed artifact ─────

describe('gen-platform-conformance-tier.cjs — real repo tree (regression)', () => {
  test('real tests/ tree classification matches the committed list', () => {
    const realTestsDir = path.join(ROOT, 'tests');

    let fresh;
    assert.doesNotThrow(() => {
      fresh = classifyTree(realTestsDir);
    }, 'a full sweep of the real tests/ tree must complete without throwing');

    // Measured 546/952 at authoring time (#4591, post suite-exclusion fix) —
    // the range below is a sanity ballpark with headroom for organic
    // test-suite growth in either direction, not a brittle exact-match on
    // that literal.
    assert.ok(
      fresh.files.length >= 450 && fresh.files.length <= 700,
      `expected a real, current, sanity-checked count in [450, 700], got ${fresh.files.length}`,
    );

    delete require.cache[require.resolve(GENERATED_PATH)];
    const committed = require(GENERATED_PATH);

    assert.equal(
      committed.CONFORMANCE_TIER_FILES.length,
      fresh.files.length,
      'the committed generated file must be fresh — run `node scripts/gen-platform-conformance-tier.cjs --write`',
    );
    assert.deepEqual(
      committed.CONFORMANCE_TIER_FILES.slice().sort(),
      fresh.files.slice().sort(),
      'the committed list must match a fresh sweep exactly, not just in length',
    );
  });

  // ─── Row 21: no suite-tagged file ever reaches the committed conformance
  // tier — the exact assertion that would have caught the CI incident before
  // it ever shipped.
  test('the committed conformance-tier list contains zero suite-tagged files', () => {
    delete require.cache[require.resolve(GENERATED_PATH)];
    const { CONFORMANCE_TIER_FILES } = require(GENERATED_PATH);

    const suiteTaggedPattern = /\.(install|security|slow|integration|qa)\.test\.cjs$/;
    const offenders = CONFORMANCE_TIER_FILES.filter((f) => suiteTaggedPattern.test(f));

    assert.deepEqual(
      offenders,
      [],
      'suite-tagged files (install/security/slow/integration/qa) must never appear in the ' +
        'conformance-tier list — install/slow are PR-excluded suites and integration/security ' +
        'already run via their own dedicated steps',
    );
  });
});
