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
const {
  classifyContent,
  classifyTree,
  NOISY_FOR_SOURCE_REACHABILITY,
  classifyMacosContent,
  classifyMacosTree,
  CATEGORIES,
  MACOS_CATEGORIES,
  walkTestFiles,
  ALWAYS_REAL_OS,
} = require('../scripts/gen-platform-conformance-tier.cjs');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'gen-platform-conformance-tier.cjs');
const GENERATED_PATH = path.join(ROOT, 'scripts', 'lib', 'platform-conformance-tier.generated.cjs');
const MACOS_GENERATED_PATH = path.join(ROOT, 'scripts', 'lib', 'macos-conformance-tier.generated.cjs');

// Policy ceilings, not derived facts — a bound like this has to be a number
// somewhere, so it is hoisted here once (module scope, shared by every case
// below that needs it) rather than left as a bare literal inside an
// assertion. Measured at authoring time (2026-09-11): the Windows tier sat at
// 264/931 eligible unit-suite files (~28.4%), the macOS tier at 197/931
// (~21.2%). Each ceiling below leaves headroom over that measurement — enough
// to absorb ordinary suite growth (new test files that happen to touch a real
// platform signal) without going so loose that a regression toward
// re-matching a removed house idiom (process-seam calls, path-call-plus-
// slash-literal) would slip back under the ceiling undetected. If the
// measured ratio moves, update the ratio in this comment and re-justify the
// ceiling — do not just raise the number to make a red test green.
const WINDOWS_TIER_RATIO_CEILING = 0.33;
const MACOS_TIER_RATIO_CEILING = 0.25;

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

  // Replaces the former 'flags process-seam subprocess helpers' case: that
  // category ('process-seam-subprocess') was removed outright from CATEGORIES
  // (#4641 — it matched the house test idiom of calling the process seam at
  // all, not a genuine platform signal). Its narrower, evidence-backed
  // replacement is 'shell-interpreter-spawn', which keys on a REAL shell
  // binary name passed as the process-seam helpers' `interpreter` option
  // (tests/helpers/process-seam.cjs's `runHook`/`runHookSeam`) — genuinely
  // platform-dependent (bash/zsh/cmd availability, quoting, output parsing
  // all differ across OSes), unlike the removed category's over-broad "any
  // process-seam call" signal.
  test('flags shell-interpreter-spawn (real interpreter option on a process-seam helper)', () => {
    for (const fixture of [
      "runHook(HOOK_PATH, [], { interpreter: 'bash' })",
      "runHookSeam(HOOK_PATH, [], { interpreter: 'zsh' })",
      "runHook(HOOK_PATH, [], { interpreter: 'cmd' })",
    ]) {
      const { needsRealOs, signals } = classifyContent(fixture);
      assert.equal(needsRealOs, true, fixture);
      assert.ok(signals.includes('shell-interpreter-spawn'), fixture);
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

  // The former 'flags hardcoded path literal vs path.* call' case asserted
  // the 'hardcoded-path-vs-path-call' category, which #4641 removed outright
  // from CATEGORIES (measured to be, alongside process-seam-subprocess, the
  // largest driver of Windows-tier over-inclusion — a universal Node
  // test-suite idiom, not a platform signal). Unlike process-seam-subprocess
  // above, this category has no narrower evidence-backed replacement: no
  // still-existing CATEGORIES entry keys on "a hardcoded path literal
  // alongside a path.* call". Every other CATEGORIES entry already has
  // dedicated happy-path coverage elsewhere in this describe block, so there
  // is genuinely nothing left for a rewritten fixture here to assert; the
  // case is retired rather than kept as dead weight around a deleted
  // detector.
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
  // #4641 removed 'hardcoded-path-vs-path-call' from CATEGORIES outright (it
  // was the single largest driver of Windows-tier over-inclusion, a house
  // test idiom rather than a genuine platform signal) — not merely from this
  // exemption set. NOISY_FOR_SOURCE_REACHABILITY therefore now holds exactly
  // one member, 'symlink-keyword': still precise enough for test-file
  // classification but too noisy for source reachability.
  test('NOISY_FOR_SOURCE_REACHABILITY exports exactly the one remaining noisy category', () => {
    assert.ok(NOISY_FOR_SOURCE_REACHABILITY instanceof Set,
      `expected a Set, got: ${typeof NOISY_FOR_SOURCE_REACHABILITY}`);
    assert.deepEqual(
      [...NOISY_FOR_SOURCE_REACHABILITY].sort(),
      ['symlink-keyword'],
      `expected exactly the one remaining noisy category, got: ${JSON.stringify([...NOISY_FOR_SOURCE_REACHABILITY])}`,
    );
    assert.ok(
      !CATEGORIES.map((c) => c.name).includes('hardcoded-path-vs-path-call'),
      'hardcoded-path-vs-path-call was removed from CATEGORIES outright (#4641), not merely exempted here',
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

    // Post-#4641 the tier is a ratio-bounded MINORITY of eligible unit-suite
    // files (WINDOWS_TIER_RATIO_CEILING, same policy ceiling the #4641 block
    // below enforces), not a brittle absolute-count range against a literal
    // that goes stale every time the category set or the suite's file count
    // changes (a hardcoded exact-count sanity range already broke once in
    // this PR). Derived from the live tree, not a hardcoded number.
    const { suiteOf } = require('../scripts/lib/suite-detection.cjs');
    const eligibleCount = walkTestFiles(realTestsDir).filter((absPath) => suiteOf(absPath) === null).length;
    const ratio = fresh.files.length / eligibleCount;
    assert.ok(
      ratio > 0 && ratio <= WINDOWS_TIER_RATIO_CEILING,
      `expected a nonzero conformance tier within the #4641 ratio ceiling (<=${WINDOWS_TIER_RATIO_CEILING * 100}%), ` +
        `got ${fresh.files.length}/${eligibleCount} (${(ratio * 100).toFixed(1)}%)`,
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

// ─── #4593: macOS-specific classifier (classifyMacosContent / MACOS_CATEGORIES)

describe('classifyMacosContent — happy-path signals', () => {
  test('flags darwin literal', () => {
    const { needsRealOs, signals } = classifyMacosContent("const platforms = ['darwin', 'linux'];");
    assert.equal(needsRealOs, true);
    assert.ok(signals.includes('darwin-literal'));
  });

  test('flags zsh dispatch', () => {
    const { needsRealOs, signals } = classifyMacosContent("shell: 'zsh {0}'");
    assert.equal(needsRealOs, true);
    assert.ok(signals.includes('zsh-dispatch'));
  });

  test('flags case-sensitivity phrasing', () => {
    for (const fixture of [
      '// verify the case-insensitive lookup',
      '// verify the case-sensitive lookup',
      '// verify case insensitivity',
    ]) {
      const { needsRealOs, signals } = classifyMacosContent(fixture);
      assert.equal(needsRealOs, true, fixture);
      assert.ok(signals.includes('case-sensitivity'), fixture);
    }
  });

  test('flags chmod mode-bit octal', () => {
    const { needsRealOs, signals } = classifyMacosContent('fs.chmodSync(target, 0o755);');
    assert.equal(needsRealOs, true);
    assert.ok(signals.includes('chmod-mode-bit'));
  });

  test('flags symlink keyword', () => {
    const { needsRealOs, signals } = classifyMacosContent('fs.symlinkSync(target, link);');
    assert.equal(needsRealOs, true);
    assert.ok(signals.includes('symlink-keyword'));
  });
});

describe('classifyMacosContent — negative case', () => {
  test('does not flag a clean file with none of the 5 macOS signals', () => {
    const fixture =
      "const assert = require('node:assert/strict');\n" +
      "if (process.platform === 'win32') { doThing(); }\n" +
      "test('adds numbers', () => { assert.equal(1 + 1, 2); });";
    const { needsRealOs, signals } = classifyMacosContent(fixture);
    assert.equal(needsRealOs, false);
    assert.deepEqual(signals, []);
  });

  test('does not crash on empty content', () => {
    assert.doesNotThrow(() => classifyMacosContent(''));
    const { needsRealOs, signals } = classifyMacosContent('');
    assert.equal(needsRealOs, false);
    assert.deepEqual(signals, []);
  });
});

// ─── #4593: CLI --target macos ─────────────────────────────────────────────

describe('gen-platform-conformance-tier.cjs CLI --target macos (temp fixture tree)', () => {
  test('--target macos --check passes when the generated file is fresh', () => {
    const tmpDir = createTempDir('gen-platform-conformance-tier-macos-');
    try {
      const testsDir = path.join(tmpDir, 'tests');
      fs.mkdirSync(testsDir, { recursive: true });
      fs.writeFileSync(path.join(testsDir, 'flagged.test.cjs'), 'fs.symlinkSync(target, link);\n');
      fs.writeFileSync(path.join(testsDir, 'clean.test.cjs'), "assert.equal(1 + 1, 2);\n");
      const outPath = path.join(tmpDir, 'macos-conformance-tier.generated.cjs');

      const write = runGen(['--target', 'macos', '--write', '--tests-dir', testsDir, '--out', outPath]);
      assert.equal(write.exitCode, 0, write.stderr);
      assert.ok(fs.existsSync(outPath));

      delete require.cache[require.resolve(outPath)];
      const generated = require(outPath);
      assert.deepEqual(generated.MACOS_CONFORMANCE_TIER_FILES, ['tests/flagged.test.cjs']);

      const check = runGen(['--target', 'macos', '--check', '--tests-dir', testsDir, '--out', outPath]);
      assert.equal(check.exitCode, 0, check.stderr);
      assert.match(check.stdout, /ok gen-platform-conformance-tier --target macos/);
    } finally {
      cleanup(tmpDir);
    }
  });

  test('--target macos --check fails and names the drift when the list is stale', () => {
    const tmpDir = createTempDir('gen-platform-conformance-tier-macos-');
    try {
      const testsDir = path.join(tmpDir, 'tests');
      fs.mkdirSync(testsDir, { recursive: true });
      fs.writeFileSync(path.join(testsDir, 'flagged.test.cjs'), 'fs.symlinkSync(target, link);\n');
      const outPath = path.join(tmpDir, 'macos-conformance-tier.generated.cjs');

      const write = runGen(['--target', 'macos', '--write', '--tests-dir', testsDir, '--out', outPath]);
      assert.equal(write.exitCode, 0, write.stderr);

      fs.writeFileSync(path.join(testsDir, 'new-signal.test.cjs'), "const platforms = ['darwin'];\n");

      const check = runGen(['--target', 'macos', '--check', '--tests-dir', testsDir, '--out', outPath]);
      assert.equal(check.exitCode, 1);
      const combined = check.stdout + check.stderr;
      assert.match(combined, /tests\/new-signal\.test\.cjs/, 'the drift report must name the new file');
    } finally {
      cleanup(tmpDir);
    }
  });

  test('a suite-suffixed file is excluded even with a qualifying macOS content signal', () => {
    const tmpDir = createTempDir('gen-platform-conformance-tier-macos-suite-');
    try {
      const testsDir = path.join(tmpDir, 'tests');
      fs.mkdirSync(testsDir, { recursive: true });
      const signal = 'fs.symlinkSync(target, link);\n';
      fs.writeFileSync(path.join(testsDir, 'foo.test.cjs'), signal);
      fs.writeFileSync(path.join(testsDir, 'foo.install.test.cjs'), signal);
      const outPath = path.join(tmpDir, 'macos-conformance-tier.generated.cjs');

      const write = runGen(['--target', 'macos', '--write', '--tests-dir', testsDir, '--out', outPath]);
      assert.equal(write.exitCode, 0, write.stderr);

      delete require.cache[require.resolve(outPath)];
      const generated = require(outPath);

      assert.deepEqual(
        generated.MACOS_CONFORMANCE_TIER_FILES,
        ['tests/foo.test.cjs'],
        'the install-suite file must be excluded even though its content would otherwise qualify',
      );
    } finally {
      cleanup(tmpDir);
    }
  });
});

// ─── #4593: real tests/ tree, regression against the committed macOS artifact

describe('gen-platform-conformance-tier.cjs — real repo tree, macOS target (regression)', () => {
  test('real tests/ tree macOS classification matches the committed list', () => {
    const realTestsDir = path.join(ROOT, 'tests');

    let fresh;
    assert.doesNotThrow(() => {
      fresh = classifyMacosTree(realTestsDir);
    }, 'a full sweep of the real tests/ tree must complete without throwing');

    // Post-#4641 the tier is a ratio-bounded MINORITY of eligible unit-suite
    // files (MACOS_TIER_RATIO_CEILING, same policy ceiling the #4641 block
    // below enforces), not a brittle absolute-count range against a literal
    // that goes stale every time the category set or the suite's file count
    // changes (a hardcoded exact-count sanity range already broke once in
    // this PR). Derived from the live tree, not a hardcoded number.
    const { suiteOf } = require('../scripts/lib/suite-detection.cjs');
    const eligibleCount = walkTestFiles(realTestsDir).filter((absPath) => suiteOf(absPath) === null).length;
    const ratio = fresh.files.length / eligibleCount;
    assert.ok(
      ratio > 0 && ratio <= MACOS_TIER_RATIO_CEILING,
      `expected a nonzero macOS conformance tier within the #4641 ratio ceiling (<=${MACOS_TIER_RATIO_CEILING * 100}%), ` +
        `got ${fresh.files.length}/${eligibleCount} (${(ratio * 100).toFixed(1)}%)`,
    );

    delete require.cache[require.resolve(MACOS_GENERATED_PATH)];
    const committed = require(MACOS_GENERATED_PATH);

    assert.equal(
      committed.MACOS_CONFORMANCE_TIER_FILES.length,
      fresh.files.length,
      'the committed macOS generated file must be fresh — run ' +
        '`node scripts/gen-platform-conformance-tier.cjs --target macos --write`',
    );
    assert.deepEqual(
      committed.MACOS_CONFORMANCE_TIER_FILES.slice().sort(),
      fresh.files.slice().sort(),
      'the committed macOS list must match a fresh sweep exactly, not just in length',
    );
  });

  test('the committed macOS conformance-tier list contains zero suite-tagged files', () => {
    delete require.cache[require.resolve(MACOS_GENERATED_PATH)];
    const { MACOS_CONFORMANCE_TIER_FILES } = require(MACOS_GENERATED_PATH);

    const suiteTaggedPattern = /\.(install|security|slow|integration|qa)\.test\.cjs$/;
    const offenders = MACOS_CONFORMANCE_TIER_FILES.filter((f) => suiteTaggedPattern.test(f));

    assert.deepEqual(
      offenders,
      [],
      'suite-tagged files must never appear in the macOS conformance-tier list either',
    );
  });
});

// ─── #4641: narrow the Windows conformance tier away from house-idiom noise ───

describe('conformance tier narrowing (#4641)', () => {
  // WINDOWS_TIER_RATIO_CEILING / MACOS_TIER_RATIO_CEILING are hoisted to
  // module scope above (shared with the real-repo-tree regression case
  // further down, which needs the same ceiling rather than a second
  // independently-drifting copy of it).

  test('conformance tier stays a tier, not the suite (#4641)', () => {
    const realTestsDir = path.join(ROOT, 'tests');
    const { suiteOf } = require('../scripts/lib/suite-detection.cjs');

    const absoluteFiles = walkTestFiles(realTestsDir);
    const eligibleFiles = absoluteFiles.filter((absPath) => suiteOf(absPath) === null);
    const eligibleCount = eligibleFiles.length;

    let tierCount = 0;
    for (const absPath of eligibleFiles) {
      const content = fs.readFileSync(absPath, 'utf8');
      const { needsRealOs } = classifyContent(content);
      if (needsRealOs) tierCount++;
    }

    const ratio = tierCount / eligibleCount;
    assert.ok(
      ratio <= WINDOWS_TIER_RATIO_CEILING,
      `expected the conformance tier to be at most ${WINDOWS_TIER_RATIO_CEILING * 100}% of eligible unit-suite files, ` +
        `got ${tierCount}/${eligibleCount} (${(ratio * 100).toFixed(1)}%)`,
    );
  });

  test('macos conformance tier stays within its evidence-backed ceiling (#4641)', () => {
    const realTestsDir = path.join(ROOT, 'tests');
    const { suiteOf } = require('../scripts/lib/suite-detection.cjs');

    const absoluteFiles = walkTestFiles(realTestsDir);
    const eligibleFiles = absoluteFiles.filter((absPath) => suiteOf(absPath) === null);
    const eligibleCount = eligibleFiles.length;

    let tierCount = 0;
    for (const absPath of eligibleFiles) {
      const content = fs.readFileSync(absPath, 'utf8');
      const { needsRealOs } = classifyMacosContent(content);
      if (needsRealOs) tierCount++;
    }

    const ratio = tierCount / eligibleCount;
    assert.ok(
      ratio <= MACOS_TIER_RATIO_CEILING,
      `expected the macOS conformance tier to be at most ${MACOS_TIER_RATIO_CEILING * 100}% of eligible unit-suite files, ` +
        `got ${tierCount}/${eligibleCount} (${(ratio * 100).toFixed(1)}%)`,
    );
  });

  test('seam-helper calls are not a platform signal (#4641)', () => {
    for (const call of ['runNode(', 'runGit(', 'runHook(', 'runGsdTools(', 'gitOrThrow(']) {
      const fixture = `${call}args);\nassert.equal(result.exitCode, 0);\n`;
      const { needsRealOs, signals } = classifyContent(fixture);
      assert.equal(needsRealOs, false, call);
      assert.deepEqual(signals, [], call);
    }
  });

  test('a path call plus a slash literal is not a platform signal (#4641)', () => {
    const fixture = "const p = path.join(dir, 'sub');\nassert.equal(p, '/tmp/fixture');\n";
    const { needsRealOs, signals } = classifyContent(fixture);
    assert.equal(needsRealOs, false);
    assert.deepEqual(signals, []);
  });

  test('the two house-idiom detectors are gone (#4641)', () => {
    const names = CATEGORIES.map((c) => c.name);
    assert.ok(!names.includes('process-seam-subprocess'), `CATEGORIES still contains process-seam-subprocess: ${JSON.stringify(names)}`);
    assert.ok(!names.includes('hardcoded-path-vs-path-call'), `CATEGORIES still contains hardcoded-path-vs-path-call: ${JSON.stringify(names)}`);
  });

  test('genuine platform-conditional content still classifies IN (#4641)', () => {
    const { needsRealOs, signals } = classifyContent("if (process.platform === 'win32') { doThing(); }");
    assert.equal(needsRealOs, true);
    assert.ok(signals.includes('process-platform'));
  });

  test('seam-BYPASSING spawn still classifies IN (#4641)', () => {
    const fixture = "const { spawnSync } = require('node:child_process');\nspawnSync('ls', []);";
    const { needsRealOs, signals } = classifyContent(fixture);
    assert.equal(needsRealOs, true);
    assert.ok(signals.includes('raw-child-process'));
  });

  test('chmodSync content still classifies IN via chmod-mode-bit (#4641)', () => {
    const { needsRealOs, signals } = classifyContent('fs.chmodSync(target, mode);');
    assert.equal(needsRealOs, true);
    assert.ok(signals.includes('chmod-mode-bit'));
  });

  test('symlinkSync content still classifies IN via symlink-keyword (#4641)', () => {
    const { needsRealOs, signals } = classifyContent('fs.symlinkSync(target, link);');
    assert.equal(needsRealOs, true);
    assert.ok(signals.includes('symlink-keyword'));
  });

  test('macOS signal set is untouched by the Windows narrowing (#4641)', () => {
    assert.deepEqual(
      MACOS_CATEGORIES.map((c) => c.name),
      ['darwin-literal', 'zsh-dispatch', 'case-sensitivity', 'chmod-mode-bit', 'symlink-keyword'],
    );
  });

  test('macOS generated tier matches a fresh classification of the live tests/ tree (#4641)', () => {
    const realTestsDir = path.join(ROOT, 'tests');
    const fresh = classifyMacosTree(realTestsDir);

    delete require.cache[require.resolve(MACOS_GENERATED_PATH)];
    const { MACOS_CONFORMANCE_TIER_FILES } = require(MACOS_GENERATED_PATH);

    assert.deepEqual(
      MACOS_CONFORMANCE_TIER_FILES.slice().sort(),
      fresh.files.slice().sort(),
      'the committed macOS generated file must be fresh — run ' +
        '`node scripts/gen-platform-conformance-tier.cjs --target macos --write`',
    );
  });

  test('named probe files still classify IN on a genuine platform signal, not by filename (#4641)', () => {
    // These three files are examples, not the assertion. Each was picked
    // because it probes a DIFFERENT genuine platform-signal family, so the
    // three together exercise the narrowed classifier's breadth, not just its
    // presence: shell-command-projection-dispatch pulls in raw
    // spawn/shell-dispatch signals, review-lane-windows-spawn-resolution pulls
    // in Windows path/spawn-resolution signals, and prohibition-enforcement
    // pulls in process.platform/os.platform conditionals. Asserting by
    // FILENAME membership is exactly the classifier bug #4641 fixes — a file
    // being in this literal list proves nothing about why it is in the tier.
    // So the assertion here is on the SIGNAL: each file must still classify
    // needsRealOs === true, and its surviving `signals` must be non-empty and
    // drawn from the real (non-house-idiom) category names still present in
    // CATEGORIES after the #4641 narrowing.
    const files = [
      'tests/shell-command-projection-dispatch.test.cjs',
      'tests/review-lane-windows-spawn-resolution.test.cjs',
      'tests/prohibition-enforcement.test.cjs',
    ];
    const validSignalNames = new Set(CATEGORIES.map((c) => c.name));
    for (const rel of files) {
      const absPath = path.join(ROOT, rel);
      const content = fs.readFileSync(absPath, 'utf8');
      const { needsRealOs, signals } = classifyContent(content);
      assert.equal(needsRealOs, true, rel);
      assert.ok(signals.length > 0, `${rel}: expected a non-empty signal set, got none`);
      for (const signal of signals) {
        assert.ok(
          validSignalNames.has(signal),
          `${rel}: signal "${signal}" is not a genuine platform category name (${JSON.stringify([...validSignalNames])})`,
        );
      }
    }
  });

  test('CATEGORIES contains the shell-interpreter-spawn detector (#4641)', () => {
    const names = CATEGORIES.map((c) => c.name);
    assert.ok(
      names.includes('shell-interpreter-spawn'),
      `CATEGORIES must contain shell-interpreter-spawn: ${JSON.stringify(names)}`,
    );
  });

  test('a real interpreter: bash spawn (the adversarial-review finding) still classifies IN (#4641)', () => {
    // tests/execute-phase-worktree-guard.test.cjs calls tests/helpers/
    // process-seam.cjs's runHook(..., { interpreter: 'bash', ... }), which
    // spawns a REAL bash binary via spawnSync. That is a genuine
    // platform-dependent signal (bash availability, quoting, git output
    // parsing all differ across OSes) that the removed
    // 'process-seam-subprocess' category used to catch incidentally, and
    // which silently dropped out of the tier when that category was removed
    // — an adversarial review caught this as a real false negative (#4641).
    // Assert directly against the real file's content so nobody can
    // "fix" a regression here by re-editing a hand-written fixture string.
    const absPath = path.join(ROOT, 'tests/execute-phase-worktree-guard.test.cjs');
    const content = fs.readFileSync(absPath, 'utf8');
    const { needsRealOs, signals } = classifyContent(content);
    assert.equal(needsRealOs, true, 'tests/execute-phase-worktree-guard.test.cjs');
    assert.ok(
      signals.includes('shell-interpreter-spawn'),
      `expected shell-interpreter-spawn among signals, got: ${JSON.stringify(signals)}`,
    );
  });

  test('runHook without an interpreter option does not match shell-interpreter-spawn (#4641)', () => {
    // The detector must key on a real shell name being passed as the
    // `interpreter` option, not on the mere presence of `runHook(...)` —
    // the default (no `interpreter:` option) spawns node, not a real shell,
    // and is not a platform signal.
    const fixture = "runHook(HOOK_PATH, [], { cwd: dir });\nassert.equal(result.exitCode, 0);\n";
    const { needsRealOs, signals } = classifyContent(fixture);
    assert.equal(needsRealOs, false);
    assert.ok(!signals.includes('shell-interpreter-spawn'), JSON.stringify(signals));
  });

  test('a source-text-analysis test drops out of the tier even when its filename says windows (#4641)', () => {
    // tests/windows-robustness.test.cjs carries `// allow-test-rule:
    // source-text-is-the-product` and only ever reads OTHER files' source
    // text and asserts on it (e.g. `assert.match(region, /windowsHide:\s*true/)`).
    // Its apparent `spawnSync(` / `execFileSync(` hits are string-literal
    // search anchors into other files' source, not real subprocess calls —
    // it spawns nothing itself and is fully Linux-runnable. Despite the
    // filename, it must classify OUT of the real-OS tier. Do not "fix" this
    // by re-adding the file to the four-named-files case above.
    const absPath = path.join(ROOT, 'tests/windows-robustness.test.cjs');
    const content = fs.readFileSync(absPath, 'utf8');
    const { needsRealOs } = classifyContent(content);
    assert.equal(needsRealOs, false, 'tests/windows-robustness.test.cjs');
  });
});

// ─── #4641: ALWAYS_REAL_OS escape hatch for code-under-test-only signals ───

describe('ALWAYS_REAL_OS escape hatch (#4641)', () => {
  test('is a Map, so every entry is forced to carry a reason', () => {
    assert.ok(ALWAYS_REAL_OS instanceof Map, 'ALWAYS_REAL_OS must be a Map');
  });

  test('every key is present in the committed Windows CONFORMANCE_TIER_FILES', () => {
    delete require.cache[require.resolve(GENERATED_PATH)];
    const { CONFORMANCE_TIER_FILES } = require(GENERATED_PATH);
    const committedSet = new Set(CONFORMANCE_TIER_FILES);
    for (const relPath of ALWAYS_REAL_OS.keys()) {
      assert.ok(
        committedSet.has(relPath),
        `${relPath} is in ALWAYS_REAL_OS but missing from the committed Windows tier — ` +
          'run `node scripts/gen-platform-conformance-tier.cjs --write`',
      );
    }
  });

  test('every entry has a non-empty recorded reason', () => {
    for (const [relPath, reason] of ALWAYS_REAL_OS.entries()) {
      assert.equal(typeof reason, 'string', `${relPath}: reason must be a string`);
      assert.ok(reason.trim().length > 0, `${relPath}: reason must be non-empty`);
    }
  });

  test('every key names a file that actually exists on disk', () => {
    for (const relPath of ALWAYS_REAL_OS.keys()) {
      const absPath = path.join(ROOT, relPath);
      assert.ok(
        fs.existsSync(absPath),
        `${relPath} is enumerated in ALWAYS_REAL_OS but does not exist on disk — stale allowlist entry ` +
          '(silent rot: the file was likely deleted or renamed)',
      );
    }
  });

  test('tests/external-descriptor-confinement.test.cjs is enumerated (#4641)', () => {
    // It exercises isPathConfined (src/external-descriptor-trust.cts:41-49),
    // which uses the AMBIENT path module (path.resolve/path.sep) with no
    // platform/path injection — its win32 branch (drive letters, UNC paths,
    // \ separator) is only reachable by actually running on Windows. A
    // security-relevant write-confinement gate; do not remove this entry to
    // "clean up" the allowlist.
    assert.ok(
      ALWAYS_REAL_OS.has('tests/external-descriptor-confinement.test.cjs'),
      'tests/external-descriptor-confinement.test.cjs must stay in ALWAYS_REAL_OS',
    );
  });

  test('does not leak into the macOS tier — macOS is POSIX, the win32 concern does not apply', () => {
    delete require.cache[require.resolve(MACOS_GENERATED_PATH)];
    const { MACOS_CONFORMANCE_TIER_FILES } = require(MACOS_GENERATED_PATH);
    const macosSet = new Set(MACOS_CONFORMANCE_TIER_FILES);
    assert.ok(
      !macosSet.has('tests/external-descriptor-confinement.test.cjs'),
      'tests/external-descriptor-confinement.test.cjs must be absent from MACOS_CONFORMANCE_TIER_FILES ' +
        '(the ALWAYS_REAL_OS entry is Windows-only)',
    );
  });
});
