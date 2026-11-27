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
 *
 * #5074's `.platform` sibling rule (design:
 * .gsd/phase/chore-5074-test-run-only-platform-sensitive-tests-o/40-design.md,
 * matrix: .gsd/phase/chore-5074-test-run-only-platform-sensitive-tests-o/
 * 50-test-matrix.md) adds rows 1-15 of that matrix in the
 * `#5074 platform split — .platform sibling rule` describe block below.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createTempDir, cleanup } = require('./helpers.cjs');
const { runNode } = require('./helpers/process-seam.cjs');
const {
  classifyContent,
  classifyUnstrippedContent,
  classifyTree,
  NOISY_FOR_SOURCE_REACHABILITY,
  classifyMacosContent,
  classifyMacosTree,
  CATEGORIES,
  MACOS_CATEGORIES,
  walkTestFiles,
  readTestFile,
  ALWAYS_REAL_OS,
  PLATFORM_SIBLING_SUFFIX,
  findPlatformSplitViolations,
} = require('../scripts/gen-platform-conformance-tier.cjs');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'gen-platform-conformance-tier.cjs');
const GENERATED_PATH = path.join(ROOT, 'scripts', 'lib', 'platform-conformance-tier.generated.cjs');
const MACOS_GENERATED_PATH = path.join(ROOT, 'scripts', 'lib', 'macos-conformance-tier.generated.cjs');

// Size baselines, not derived facts: each tier is bounded by its own file count (ADR-4641, amended by #6551;
// they replace the ratios of that ADR's section 3, which moved whenever unrelated tests were deleted). A file
// joining a tier is a deliberate edit of the constant, with the reason in review; a tier that shrank lowers the
// constant in the same change, so the bound only tightens. Do not raise a number to make a red test green.
// The count is a fresh sweep of the live tree, the same one the committed generated lists carry. An equal-count
// swap (one signal-bearing file in, one tier file out) is caught by the list-equality assertions below, not here.
const WINDOWS_TIER_SIZE_BASELINE = 357; // +1 (#6719): tests/project-skills-manifest.test.cjs joins the tier: it lists a skill directory that is a symlink or junction, a behavior only a real Windows lane can prove; +1 (#4696): tests/tdd-gate-split-dispatch.test.cjs runs the shipped execute-phase split-decision block under a real `bash` (runHook interpreter); +1 (#4647): tests/seed-close.test.cjs runs the shipped plant-seed parse-idea block under a real `bash` (runHook interpreter), the signal the tier exists for; +1: tests/6451-tdd-deviation-acceptance.test.cjs joins the tier (#6451); -2 (#6039): wave 4 moved 2 files off the lane (env literal only); +1: tests/6503-api-coverage-probe-install-lookup.test.cjs joins the tier (#6503): spawns POSIX sh through the process seam, carries the win32 skip; +1 (#5249): tests/health-diagnostic-rules/project-skills-budget.test.cjs joins the tier: its symlinked-skill-directory case is real Windows signal (symlink creation needs privilege there and the case skips itself when it fails)
const MACOS_TIER_SIZE_BASELINE = 304; // +1 (#6719): tests/project-skills-manifest.test.cjs joins the tier: it lists a symlinked skill directory on the macOS lane; +1 (#4696): tests/tdd-gate-split-dispatch.test.cjs runs the shipped execute-phase split-decision block under a real `bash` (runHook interpreter); +1: tests/6420-plan-document-linear.test.cjs joins the tier (#6420); -2: contributor-standards and verification-overrides became text contracts (#6577); -1 earlier: debugger-semantic-recall (#6566); +1: tests/6503-api-coverage-probe-install-lookup.test.cjs joins the tier (#6503): spawns POSIX sh through the process seam, carries the win32 skip; +1 (#5249): tests/health-diagnostic-rules/project-skills-budget.test.cjs joins the tier: its symlinked-skill-directory case is real Windows signal (symlink creation needs privilege there and the case skips itself when it fails); +1 (#5681): tests/config.platform.test.cjs joins the tier: its defaults-store rows create symlinks, resolve a realpath and check mode bits

// A tier of `count` files against its committed baseline: nonzero, not above, not below.
function assertTierAtBaseline(count, baseline, label, constantName) {
  assert.ok(count > 0, `expected a nonzero ${label} conformance tier`);
  assert.ok(
    count <= baseline,
    `the ${label} conformance tier grew to ${count} files, above its baseline of ${baseline} (ADR-4641 amended by #6551). ` +
      `A file joining the tier is a deliberate change: raise ${constantName} to ${count} in this PR and say why.`,
  );
  assert.ok(
    count >= baseline,
    `the ${label} conformance tier shrank to ${count} files, below its baseline of ${baseline}. ` +
      `Lower ${constantName} to ${count} in this PR so the bound keeps tightening.`,
  );
}

// Classify each listed test file and count the ones that need a real OS. The
// tree is walked once and each file read afterwards, so a sibling test that
// writes and unlinks a probe file in tests/ (run-tests-temp-root.test.cjs,
// #4020) can remove a listed file before its read (#6544). A file that is gone
// is not a test file and is not counted; any other read error is a real fault.
function countTierFiles(absPaths, classify, forced = () => false) {
  let tierCount = 0;
  let readCount = 0;
  for (const absPath of absPaths) {
    let content;
    try {
      content = fs.readFileSync(absPath, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      throw err;
    }
    readCount++;
    if (classify(content).needsRealOs || forced(absPath)) tierCount++;
  }
  return { tierCount, readCount };
}

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

    // The tier is bounded by its own size (WINDOWS_TIER_SIZE_BASELINE, the same
    // ratchet the #4641 block below enforces), not by a ratio against the live
    // count of unit-suite files, which moves whenever tests are added or removed.
    assertTierAtBaseline(fresh.files.length, WINDOWS_TIER_SIZE_BASELINE, 'Windows', 'WINDOWS_TIER_SIZE_BASELINE');

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

  // ─── #5074 row 14: every real .platform sibling is in the tier and its base
  // is not — the split-pair invariant checked against the actual committed
  // list, not a fixture.
  test('every real .platform sibling is in the tier and its base is not', () => {
    const realTestsDir = path.join(ROOT, 'tests');
    const absoluteFiles = walkTestFiles(realTestsDir);
    const siblingRels = absoluteFiles
      .map((absPath) => 'tests/' + path.relative(realTestsDir, absPath).replace(/\\/g, '/'))
      .filter((rel) => rel.endsWith(PLATFORM_SIBLING_SUFFIX))
      .filter((rel) => {
        const stem = path.posix.basename(rel).slice(0, -PLATFORM_SIBLING_SUFFIX.length);
        return stem.length > 0;
      });

    assert.ok(
      siblingRels.length > 0,
      'expected at least one real tests/**/*.platform.test.cjs — the split files this PR introduces',
    );

    delete require.cache[require.resolve(GENERATED_PATH)];
    const { CONFORMANCE_TIER_FILES } = require(GENERATED_PATH);
    const tierSet = new Set(CONFORMANCE_TIER_FILES);

    for (const siblingRel of siblingRels) {
      assert.ok(tierSet.has(siblingRel), `expected ${siblingRel} in CONFORMANCE_TIER_FILES`);
      const dir = path.posix.dirname(siblingRel);
      const stem = path.posix.basename(siblingRel).slice(0, -PLATFORM_SIBLING_SUFFIX.length);
      const baseRel = (dir === '.' ? '' : dir + '/') + stem + '.test.cjs';
      if (tierSet.has(baseRel) === false) continue;
      assert.fail(`base ${baseRel} of split sibling ${siblingRel} must not be in the tier`);
    }
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
    // #6002: the phrasing must appear in CODE (identifier or string literal);
    // the same words inside a comment are prose, not behavior, and are pinned
    // as non-signals by the sibling test below.
    for (const fixture of [
      'assert.ok(isCaseInsensitiveFs());',
      "test('verify the case-sensitive lookup', () => {});",
      'const caseInsensitivity = probeFs();',
    ]) {
      const { needsRealOs, signals } = classifyMacosContent(fixture);
      assert.equal(needsRealOs, true, fixture);
      assert.ok(signals.includes('case-sensitivity'), fixture);
    }
  });

  test('does not flag case-sensitivity phrasing that appears only in a comment (#6002)', () => {
    for (const fixture of [
      '// verify the case-insensitive lookup',
      '// verify the case-sensitive lookup',
      '/* verify case insensitivity */',
    ]) {
      const { needsRealOs, signals } = classifyMacosContent(fixture);
      assert.equal(needsRealOs, false, fixture);
      assert.ok(!signals.includes('case-sensitivity'), fixture);
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

    // Bounded by its own size (MACOS_TIER_SIZE_BASELINE), as the Windows tier is above.
    assertTierAtBaseline(fresh.files.length, MACOS_TIER_SIZE_BASELINE, 'macOS', 'MACOS_TIER_SIZE_BASELINE');

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
  // WINDOWS_TIER_SIZE_BASELINE / MACOS_TIER_SIZE_BASELINE are hoisted to
  // module scope above (shared with the real-repo-tree regression case
  // further down, which needs the same baseline rather than a second
  // independently-drifting copy of it).

  test('a test file that vanishes between the walk and its read is not counted and does not throw (#6544)', (t) => {
    // tests/run-tests-temp-root.test.cjs writes tests/helpers-4020-probe.test.cjs
    // into the real tests tree and unlinks it afterwards. A sibling that walked
    // the tree in between lists a file whose read then fails with ENOENT.
    const dir = createTempDir('gsd-6544-');
    t.after(() => cleanup(dir));
    const present = path.join(dir, 'present.test.cjs');
    const vanished = path.join(dir, 'vanished.test.cjs');
    fs.writeFileSync(present, "const os = require('node:os');\nos.platform();\n");

    const { tierCount, readCount } = countTierFiles([present, vanished], classifyContent);

    assert.equal(readCount, 1, 'only the file that exists is counted');
    assert.equal(tierCount, 1, 'the surviving file is classified');
  });

  test('a read failure other than ENOENT still throws (#6544)', (t) => {
    const dir = createTempDir('gsd-6544-');
    t.after(() => cleanup(dir));
    // A directory path reads as EISDIR: a real fault, not a vanished file.
    assert.throws(() => countTierFiles([dir], classifyContent), { code: 'EISDIR' });
  });

  test('a file forced into the tier counts without a content signal; a forced file that vanished does not (#6551)', (t) => {
    const dir = createTempDir('gsd-6551-');
    t.after(() => cleanup(dir));
    const plain = path.join(dir, 'plain.test.cjs');
    const vanished = path.join(dir, 'vanished.test.cjs');
    fs.writeFileSync(plain, "const x = 1;\n");

    assert.equal(countTierFiles([plain], classifyContent).tierCount, 0, 'no signal, not forced');
    assert.equal(countTierFiles([plain], classifyContent, () => true).tierCount, 1, 'forced in');
    assert.equal(countTierFiles([plain, vanished], classifyContent, () => true).tierCount, 1, 'a vanished file is not counted even when forced');
  });

  // The tier is the files a fresh sweep of the live tree puts in the list: the classifier's hits plus the
  // always-real-OS map entries (Windows only), the same count the committed generated files carry. Each file is read
  // through countTierFiles, so one that vanishes after the walk is skipped (#6544).
  const tierSize = (classify, forced) => {
    const realTestsDir = path.join(ROOT, 'tests');
    const { suiteOf } = require('../scripts/lib/suite-detection.cjs');
    const eligibleFiles = walkTestFiles(realTestsDir).filter((absPath) => suiteOf(absPath) === null);
    return countTierFiles(eligibleFiles, classify, (absPath) => forced(`tests/${path.relative(realTestsDir, absPath).replace(/\\/g, '/')}`)).tierCount;
  };

  test('conformance tier stays a tier, not the suite (#4641)', () => {
    assertTierAtBaseline(tierSize(classifyContent, (rel) => ALWAYS_REAL_OS.has(rel)), WINDOWS_TIER_SIZE_BASELINE, 'Windows', 'WINDOWS_TIER_SIZE_BASELINE');
  });

  test('macos conformance tier stays within its size baseline (#4641)', () => {
    assertTierAtBaseline(tierSize(classifyMacosContent, () => false), MACOS_TIER_SIZE_BASELINE, 'macOS', 'MACOS_TIER_SIZE_BASELINE');
  });

  // The ratchet itself: a tier above its baseline, below it, or empty fails, and the message names the constant to edit.
  describe('assertTierAtBaseline', () => {
    test('a tier at its baseline passes', () => {
      assert.doesNotThrow(() => assertTierAtBaseline(301, 301, 'macOS', 'X'));
    });
    test('a tier one file above its baseline fails and says to raise the baseline', () => {
      assert.throws(() => assertTierAtBaseline(302, 301, 'macOS', 'MACOS_TIER_SIZE_BASELINE'), /grew to 302 files, above its baseline of 301[\s\S]*raise MACOS_TIER_SIZE_BASELINE to 302/);
    });
    test('a tier one file below its baseline fails and says to lower the baseline', () => {
      assert.throws(() => assertTierAtBaseline(300, 301, 'macOS', 'MACOS_TIER_SIZE_BASELINE'), /shrank to 300 files, below its baseline of 301[\s\S]*Lower MACOS_TIER_SIZE_BASELINE to 300/);
    });
    test('an empty tier fails', () => {
      assert.throws(() => assertTierAtBaseline(0, 0, 'macOS', 'X'), /nonzero macOS conformance tier/);
    });
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
      ['darwin-literal', 'zsh-dispatch', 'case-sensitivity', 'chmod-mode-bit', 'symlink-keyword', 'realpath'],
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

// ─── #5074: the .platform sibling rule ─────────────────────────────────────
//
// Rows 1-15, .gsd/phase/chore-5074-test-run-only-platform-sensitive-tests-o/
// 50-test-matrix.md. `classifyTree`/`classifyMacosTree` are called the same
// way `main()` calls them (bare `testsDir`) per that matrix's shape note.

describe('#5074 platform split — .platform sibling rule', () => {
  test('PLATFORM_SIBLING_SUFFIX is the .platform.test.cjs suffix', () => {
    assert.equal(PLATFORM_SIBLING_SUFFIX, '.platform.test.cjs');
  });

  // ─── Rows 1-2: unchanged behavior for a file with no sibling ─────────────
  test('a file with no .platform sibling is classified exactly as before', () => {
    const tmpDir = createTempDir('gen-platform-split-nosib-');
    try {
      const testsDir = path.join(tmpDir, 'tests');
      fs.mkdirSync(testsDir, { recursive: true });
      fs.writeFileSync(path.join(testsDir, 'flagged.test.cjs'), "if (process.platform === 'win32') {}\n");
      fs.writeFileSync(path.join(testsDir, 'clean.test.cjs'), 'assert.equal(1 + 1, 2);\n');

      const { files } = classifyTree(testsDir);
      assert.deepEqual(files, ['tests/flagged.test.cjs']);
    } finally {
      cleanup(tmpDir);
    }
  });

  // ─── Row 3: clean base + signal-bearing sibling — only the sibling is IN ──
  test('a clean base with a signal-bearing .platform sibling: only the sibling is in the tier', () => {
    const tmpDir = createTempDir('gen-platform-split-clean-sib-');
    try {
      const testsDir = path.join(tmpDir, 'tests');
      fs.mkdirSync(testsDir, { recursive: true });
      fs.writeFileSync(path.join(testsDir, 'x.test.cjs'), 'assert.equal(1 + 1, 2);\n');
      fs.writeFileSync(path.join(testsDir, 'x.platform.test.cjs'), "if (process.platform === 'win32') {}\n");

      const { files } = classifyTree(testsDir);
      assert.deepEqual(files, ['tests/x.platform.test.cjs']);
    } finally {
      cleanup(tmpDir);
    }
  });

  // ─── Row 4: split base that still carries a residual signal — throws ─────
  test('a split base that still carries a Windows signal fails classification and names the residual signal', () => {
    const tmpDir = createTempDir('gen-platform-split-residual-');
    try {
      const testsDir = path.join(tmpDir, 'tests');
      fs.mkdirSync(testsDir, { recursive: true });
      fs.writeFileSync(path.join(testsDir, 'x.test.cjs'), 'fs.symlinkSync(target, link);\n');
      fs.writeFileSync(path.join(testsDir, 'x.platform.test.cjs'), "if (process.platform === 'win32') {}\n");

      assert.throws(
        () => classifyTree(testsDir),
        (err) => {
          assert.match(err.message, /platform split/);
          assert.match(err.message, /tests\/x\.test\.cjs/);
          assert.match(err.message, /symlink-keyword/);
          assert.match(err.message, /tests\/x\.platform\.test\.cjs/);
          return true;
        },
      );
    } finally {
      cleanup(tmpDir);
    }
  });

  // ─── Row 4b: same violation, driven through the real CLI --check path ────
  test('--check fails loudly on a split-invariant violation', () => {
    const tmpDir = createTempDir('gen-platform-split-cli-');
    try {
      const testsDir = path.join(tmpDir, 'tests');
      fs.mkdirSync(testsDir, { recursive: true });
      fs.writeFileSync(path.join(testsDir, 'x.test.cjs'), 'fs.symlinkSync(target, link);\n');
      fs.writeFileSync(path.join(testsDir, 'x.platform.test.cjs'), "if (process.platform === 'win32') {}\n");
      const outPath = path.join(tmpDir, 'platform-conformance-tier.generated.cjs');

      const check = runGen(['--check', '--tests-dir', testsDir, '--out', outPath]);
      assert.equal(check.exitCode, 1);
      assert.match(check.stderr, /platform split/);
      assert.match(check.stderr, /tests\/x\.test\.cjs/);
    } finally {
      cleanup(tmpDir);
    }
  });

  // ─── Row 5/5b: a .platform sibling with no signal always fails, base present or not
  test('a .platform sibling that carries no Windows signal fails classification', () => {
    const tmpDir = createTempDir('gen-platform-split-sib-clean-');
    try {
      const testsDir = path.join(tmpDir, 'tests');
      fs.mkdirSync(testsDir, { recursive: true });
      fs.writeFileSync(path.join(testsDir, 'x.test.cjs'), 'assert.equal(1 + 1, 2);\n');
      fs.writeFileSync(path.join(testsDir, 'x.platform.test.cjs'), 'assert.equal(2 + 2, 4);\n');

      assert.throws(
        () => classifyTree(testsDir),
        (err) => {
          assert.match(err.message, /platform split/);
          assert.match(err.message, /tests\/x\.platform\.test\.cjs/);
          return true;
        },
      );
    } finally {
      cleanup(tmpDir);
    }

    const tmpDir2 = createTempDir('gen-platform-split-sib-clean-orphan-');
    try {
      const testsDir2 = path.join(tmpDir2, 'tests');
      fs.mkdirSync(testsDir2, { recursive: true });
      fs.writeFileSync(path.join(testsDir2, 'y.platform.test.cjs'), 'assert.equal(2 + 2, 4);\n');

      assert.throws(
        () => classifyTree(testsDir2),
        (err) => {
          assert.match(err.message, /platform split/);
          assert.match(err.message, /tests\/y\.platform\.test\.cjs/);
          return true;
        },
      );
    } finally {
      cleanup(tmpDir2);
    }
  });

  // ─── #6638: a .platform sibling declared in ALWAYS_REAL_OS needs no signal of its own.
  // Pure-function row with an injected map, like row 7.
  test('a .platform sibling declared in ALWAYS_REAL_OS satisfies the signal requirement (#6638)', () => {
    const entries = [
      { rel: 'tests/fake-declared.test.cjs', content: 'assert.equal(1 + 1, 2);\n' },
      { rel: 'tests/fake-declared.platform.test.cjs', content: 'assert.equal(2 + 2, 4);\n' },
    ];
    const siblingRel = 'tests/fake-declared.platform.test.cjs';
    const baseRel = 'tests/fake-declared.test.cjs';

    assert.deepEqual(findPlatformSplitViolations(entries, new Map()), [
      { file: siblingRel, kind: 'sibling-without-signal', signals: [] },
    ]);
    assert.deepEqual(findPlatformSplitViolations(entries, new Map([[siblingRel, 'fixture reason']])), []);
    assert.deepEqual(
      findPlatformSplitViolations(entries, new Map([[baseRel, 'fixture reason']])),
      [
        { file: siblingRel, kind: 'sibling-without-signal', signals: [] },
        { file: baseRel, kind: 'base-always-real-os', signals: [] },
      ],
    );
    assert.deepEqual(
      findPlatformSplitViolations(entries, new Map([[siblingRel, 'a'], [baseRel, 'b']])),
      [{ file: baseRel, kind: 'base-always-real-os', signals: [] }],
    );
  });

  // ─── Row 6: an orphan .platform file (no base) with a genuine signal ─────
  test('an orphan .platform file is classified on its own content', () => {
    const tmpDir = createTempDir('gen-platform-split-orphan-');
    try {
      const testsDir = path.join(tmpDir, 'tests');
      fs.mkdirSync(testsDir, { recursive: true });
      fs.writeFileSync(path.join(testsDir, 'y.platform.test.cjs'), 'fs.symlinkSync(target, link);\n');

      const { files } = classifyTree(testsDir);
      assert.deepEqual(files, ['tests/y.platform.test.cjs']);
    } finally {
      cleanup(tmpDir);
    }
  });

  // ─── Row 7: ALWAYS_REAL_OS base + sibling — throws. A fixture tree cannot
  // contain a real ALWAYS_REAL_OS key, so this drives the pure helper
  // directly with an injected map, per the matrix's "pure-function row" note.
  test('a base in ALWAYS_REAL_OS paired with a .platform sibling fails classification', () => {
    const entries = [
      { rel: 'tests/fake-always-real.test.cjs', content: 'assert.equal(1 + 1, 2);\n' },
      { rel: 'tests/fake-always-real.platform.test.cjs', content: 'fs.symlinkSync(target, link);\n' },
    ];
    const injectedAlwaysRealOs = new Map([['tests/fake-always-real.test.cjs', 'fixture reason']]);

    const violations = findPlatformSplitViolations(entries, injectedAlwaysRealOs);
    assert.deepEqual(violations, [
      { file: 'tests/fake-always-real.test.cjs', kind: 'base-always-real-os', signals: [] },
    ]);
  });

  // ─── Rows 8-9: hostile filenames that are NOT a sibling ──────────────────
  test('a bare platform.test.cjs is not a sibling', () => {
    const tmpDir = createTempDir('gen-platform-split-bare-');
    try {
      const testsDir = path.join(tmpDir, 'tests');
      fs.mkdirSync(testsDir, { recursive: true });
      fs.writeFileSync(path.join(testsDir, 'platform.test.cjs'), 'assert.equal(1 + 1, 2);\n');

      const { files } = classifyTree(testsDir);
      assert.deepEqual(files, [], 'platform.test.cjs has an empty stem, so it is not a sibling and stays clean');
    } finally {
      cleanup(tmpDir);
    }
  });

  test('platform-conformance-tier.test.cjs-shaped filenames (hyphen, not dot) are not a sibling', () => {
    const tmpDir = createTempDir('gen-platform-split-hyphen-');
    try {
      const testsDir = path.join(tmpDir, 'tests');
      fs.mkdirSync(testsDir, { recursive: true });
      fs.writeFileSync(path.join(testsDir, 'x-platform.test.cjs'), 'assert.equal(1 + 1, 2);\n');
      fs.writeFileSync(
        path.join(testsDir, 'platform-conformance-tier.test.cjs'),
        'assert.equal(1 + 1, 2);\n',
      );

      assert.doesNotThrow(() => classifyTree(testsDir));
      const { files } = classifyTree(testsDir);
      assert.deepEqual(files, []);
    } finally {
      cleanup(tmpDir);
    }
  });

  // ─── Row 10: siblings resolve per directory, not flattened ───────────────
  test('siblings are resolved per directory', () => {
    const tmpDir = createTempDir('gen-platform-split-subdir-');
    try {
      const testsDir = path.join(tmpDir, 'tests');
      const subDir = path.join(testsDir, 'sub');
      fs.mkdirSync(subDir, { recursive: true });
      fs.writeFileSync(path.join(subDir, 'x.test.cjs'), 'assert.equal(1 + 1, 2);\n');
      fs.writeFileSync(path.join(subDir, 'x.platform.test.cjs'), "if (process.platform === 'win32') {}\n");

      const { files } = classifyTree(testsDir);
      assert.deepEqual(files, ['tests/sub/x.platform.test.cjs']);
    } finally {
      cleanup(tmpDir);
    }
  });

  // ─── Row 11: a suite-tagged base is ineligible before this rule runs ─────
  test('a suite-tagged base is not paired with a .platform sibling', () => {
    const tmpDir = createTempDir('gen-platform-split-suite-');
    try {
      const testsDir = path.join(tmpDir, 'tests');
      fs.mkdirSync(testsDir, { recursive: true });
      // x.install.test.cjs is suite-tagged (suiteOf -> 'install') and never
      // eligible, even though it carries a genuine signal.
      fs.writeFileSync(path.join(testsDir, 'x.install.test.cjs'), 'fs.symlinkSync(target, link);\n');
      // x.install.platform.test.cjs is a unit-suite file (suiteOf reads only
      // the last dot-segment, 'platform') and IS a sibling of x.install.test.cjs;
      // its own content carries a signal, so rule 5 does not fire either.
      fs.writeFileSync(path.join(testsDir, 'x.install.platform.test.cjs'), 'fs.symlinkSync(target, link);\n');

      assert.doesNotThrow(() => classifyTree(testsDir));
      const { files } = classifyTree(testsDir);
      assert.deepEqual(files, ['tests/x.install.platform.test.cjs']);
    } finally {
      cleanup(tmpDir);
    }
  });

  // ─── Row 12: CRLF independence — same outcome as LF, both line endings ───
  for (const eol of ['\n', '\r\n']) {
    test(`a clean base with a signal-bearing .platform sibling under ${JSON.stringify(eol)} line endings`, () => {
      const tmpDir = createTempDir('gen-platform-split-crlf-');
      try {
        const testsDir = path.join(tmpDir, 'tests');
        fs.mkdirSync(testsDir, { recursive: true });
        fs.writeFileSync(path.join(testsDir, 'x.test.cjs'), `assert.equal(1 + 1, 2);${eol}`);
        fs.writeFileSync(
          path.join(testsDir, 'x.platform.test.cjs'),
          `if (process.platform === 'win32') {}${eol}`,
        );

        const { files } = classifyTree(testsDir);
        assert.deepEqual(files, ['tests/x.platform.test.cjs']);
      } finally {
        cleanup(tmpDir);
      }
    });
  }

  // ─── Row 13: the macOS tier ignores the Windows-only split invariant ─────
  test('the macOS tier is unaffected by the Windows split invariant', () => {
    const tmpDir = createTempDir('gen-platform-split-macos-');
    try {
      const testsDir = path.join(tmpDir, 'tests');
      fs.mkdirSync(testsDir, { recursive: true });
      // The base's residual signal (process.env.PATHEXT) is Windows-only —
      // not a MACOS_CATEGORIES member — so classifyMacosTree must not throw
      // even though classifyTree (Windows) would.
      fs.writeFileSync(path.join(testsDir, 'x.test.cjs'), 'const p = process.env.PATHEXT;\n');
      fs.writeFileSync(path.join(testsDir, 'x.platform.test.cjs'), 'fs.symlinkSync(target, link);\n');

      assert.doesNotThrow(() => classifyMacosTree(testsDir));
    } finally {
      cleanup(tmpDir);
    }
  });
});

// ─── #6002: detectors match platform behavior, not text ──────────────────────

describe('#6002: detectors match platform behavior, not text', () => {
  const fc = require('fast-check');

  // Comments and node-only children carry no real-OS signal.
  test('node-only child via process.execPath is not a real-OS signal (#6002)', () => {
    const src =
      "const {execFileSync}=require('child_process');execFileSync(process.execPath,['x'])";
    assert.equal(classifyContent(src).needsRealOs, false);
  });

  test('node-only child via literal "node" is not a real-OS signal (#6002)', () => {
    const src = "const {spawnSync}=require('child_process');spawnSync('node',['x'])";
    assert.equal(classifyContent(src).needsRealOs, false);
  });

  test('a line comment naming a shell spawn is not a signal (#6002)', () => {
    assert.equal(classifyContent("// require('child_process'); spawnSync('bash')").needsRealOs, false);
  });

  test('a block comment naming process.platform is not a signal (#6002)', () => {
    assert.equal(classifyContent('/* process.platform */').needsRealOs, false);
  });

  // Real shell spawns, non-node children and string-literal platform checks stay flagged.
  test('a real shell spawn stays flagged as raw-child-process (#6002)', () => {
    const { needsRealOs, signals } = classifyContent(
      "const { spawnSync, execFileSync } = require('child_process');\nspawnSync('bash',['-c',s])",
    );
    assert.equal(needsRealOs, true);
    assert.ok(signals.includes('raw-child-process'), `signals: ${signals.join(',')}`);
  });

  test('a non-node child process stays flagged as raw-child-process (#6002)', () => {
    const { needsRealOs, signals } = classifyContent(
      "const { spawnSync, execFileSync } = require('child_process');\nexecFileSync('git',['status'])",
    );
    assert.equal(needsRealOs, true);
    assert.ok(signals.includes('raw-child-process'), `signals: ${signals.join(',')}`);
  });

  test('a string-literal platform check stays flagged (#6002)', () => {
    assert.equal(classifyContent("if (process.platform === 'win32') {}").needsRealOs, true);
  });

  // `//` inside a string is not a comment start.
  test('a URL inside a string does not start a comment that swallows the spawn (#6002)', () => {
    const { needsRealOs, signals } = classifyContent(
      "const { spawnSync, execFileSync } = require('child_process');\nconst u = 'http://example.test'; spawnSync('bash', [])",
    );
    assert.equal(needsRealOs, true);
    assert.ok(signals.includes('raw-child-process'), `signals: ${signals.join(',')}`);
  });

  // Regex literals must not corrupt string/comment tracking.
  test('a regex literal containing // does not hide a later platform check (#6002)', () => {
    const src = "const r=/https?:\\/\\//; if (process.platform==='win32'){}";
    assert.ok(classifyContent(src).signals.includes('process-platform'));
  });

  test('a regex literal containing a quote does not hide a later spawn (#6002)', () => {
    const src =
      "const cp=require('child_process');\n/'/.test(x); const y='a // b'; execFileSync('git',[])";
    assert.ok(classifyContent(src).signals.includes('raw-child-process'));
  });

  // Async spawn forms, fork, shell:true, aliased usage.
  test("async spawn('git') is flagged (#6002)", () => {
    assert.ok(classifyContent("require('child_process');spawn('git',[])").signals.includes('raw-child-process'));
  });

  test("exec of a cmd /c string is flagged (#6002)", () => {
    assert.ok(classifyContent("require('child_process');const c='cmd /c x';exec(c)").signals.includes('raw-child-process'));
  });

  test("fork('./w.js') runs node and is node-only: not flagged (#6002)", () => {
    assert.equal(classifyContent("require('child_process');fork('./w.js')").needsRealOs, false);
  });

  test('shell:true on a node child is flagged (#6002)', () => {
    const src = "require('child_process');spawnSync(process.execPath,['x'],{shell:true})";
    assert.ok(classifyContent(src).signals.includes('raw-child-process'));
  });

  test('aliased child_process usage with unidentifiable call sites is flagged (#6002)', () => {
    assert.ok(classifyContent("const cp=require('child_process');cp.run(x)").signals.includes('raw-child-process'));
  });

  test('a node-only child in a file exercising lock/rename/EBUSY is flagged fs-lock-or-install-child (#6002)', () => {
    const src = "require('child_process');spawnSync(process.execPath,['x']);fs.renameSync(a,b)";
    const { signals } = classifyContent(src);
    assert.ok(signals.includes('fs-lock-or-install-child'), signals.join(','));
    assert.ok(!signals.includes('raw-child-process'));
  });

  test('a node-only child with the word lock only in prose is not fs-lock-or-install-child (#6002)', () => {
    const src = "require('child_process');spawnSync(process.execPath,['x']); const msg = 'unlock the lock screen';";
    assert.ok(!classifyContent(src).signals.includes('fs-lock-or-install-child'));
  });

  test('classifyUnstrippedContent keeps pre-#6002 behavior (comments and bare require count) (#6002)', () => {
    assert.ok(classifyUnstrippedContent("// process.platform").signals.includes('process-platform'));
    assert.ok(classifyUnstrippedContent("require('child_process')").signals.includes('raw-child-process'));
  });

  test('member cp.spawn(non-node) is flagged even after a node-only spawnSync (#6002)', () => {
    const src = "const cp=require('child_process');spawnSync(process.execPath,[]);cp.spawn('bash')";
    assert.ok(classifyContent(src).signals.includes('raw-child-process'));
  });

  test('promisify(cp.execFile) is an unidentifiable counted call site (#6002)', () => {
    const src =
      "const cp=require('child_process');const ex = promisify(cp.execFile); ex('git'); spawnSync('node',[])";
    assert.ok(classifyContent(src).signals.includes('raw-child-process'));
  });

  test('regex .exec( receivers are not spawn call sites (#6002)', () => {
    const src = "require('child_process');spawnSync(process.execPath,[]);const m = nameRe.exec(s); /x/g.exec(s);";
    assert.ok(!classifyContent(src).signals.includes('raw-child-process'));
  });

  test('member cp.spawn(process.execPath) is node-only (#6002)', () => {
    const src = "const cp=require('child_process');cp.spawn(process.execPath,['x'])";
    assert.equal(classifyContent(src).needsRealOs, false);
  });

  test('shell : true with whitespace before the colon is flagged (#6002)', () => {
    const src = "require('child_process');spawnSync(process.execPath,['x'],{shell : true})";
    assert.ok(classifyContent(src).signals.includes('raw-child-process'));
  });

  test('a nested template containing // inside ${} does not start a comment (#6002)', () => {
    const src = 'const a = `x ${ `http://y` } z`; if (process.platform === "win32") {}';
    assert.ok(classifyContent(src).signals.includes('process-platform'));
  });

  test('realpath in code is a macOS signal; in a comment it is not (#6002)', () => {
    assert.ok(classifyMacosContent('fs.realpathSync(os.tmpdir())').signals.includes('realpath'));
    assert.equal(classifyMacosContent('// realpathSync on the tmpdir').needsRealOs, false);
  });

  // Property: comments never add or remove signals.
  test('property: comment-only content has no signals (#6002)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('process.platform', 'win32', 'chmod(', 'symlink', "spawnSync('bash'"),
        fc.string(),
        (token, s) => {
          const line = '// ' + token + s.replace(/[\r\n]/g, '');
          assert.deepEqual(classifyContent(line).signals, []);
        },
      ),
    );
  });

  test('property: appending a comment never removes a real signal (#6002)', () => {
    const prefix = "const { spawnSync, execFileSync } = require('child_process');\n";
    const snippets = [
      prefix + "spawnSync('bash',['-c',s])",
      prefix + "execFileSync('git',['status'])",
      "if (process.platform === 'win32') {}",
    ];
    fc.assert(
      fc.property(fc.constantFrom(...snippets), fc.string(), (c, s) => {
        const comment = s.replace(/[\r\n]/g, ' ');
        const before = classifyContent(c).signals;
        const after = classifyContent(c + '\n// ' + comment).signals;
        for (const sig of before) assert.ok(after.includes(sig), `lost ${sig}`);
      }),
    );
  });
});

// ─── #6166: a test file that vanishes between the walk and the read ─────────

describe('#6166 tree classifiers skip a test file deleted after enumeration', () => {
  // Make reading `gone.test.cjs` (or each of `goneNames`) throw an error with
  // `code` (none when `code` is null), as a file deleted between walkTestFiles
  // and the read does; every other read goes through.
  function withFailingRead(t, testsDir, code, { goneNames = ['gone.test.cjs'], message } = {}) {
    const gone = new Set(goneNames.map((name) => path.join(testsDir, name)));
    const readFileSync = fs.readFileSync;
    t.mock.method(fs, 'readFileSync', (file, ...rest) => {
      if (gone.has(file)) {
        const err = new Error(message ?? `${code}: ${file}`);
        throw code === null ? err : Object.assign(err, { code });
      }
      return readFileSync(file, ...rest);
    });
  }

  function withTestsDir(prefix, files, body) {
    const tmpDir = createTempDir(prefix);
    try {
      const testsDir = path.join(tmpDir, 'tests');
      fs.mkdirSync(testsDir, { recursive: true });
      for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(testsDir, name), content);
      body(testsDir);
    } finally {
      cleanup(tmpDir);
    }
  }

  const DARWIN = "if (process.platform === 'darwin') {}\n";
  const PLAIN = 'assert.equal(1 + 1, 2);\n';

  test('readTestFile answers null for ENOENT and rethrows every other error', (t) => {
    withTestsDir('gen-platform-read-', { 'gone.test.cjs': PLAIN }, (testsDir) => {
      const gone = path.join(testsDir, 'gone.test.cjs');
      assert.equal(readTestFile(gone), PLAIN);
      assert.equal(readTestFile(path.join(testsDir, 'never-there.test.cjs')), null);
      assert.throws(() => readTestFile(testsDir), { code: 'EISDIR' });

      withFailingRead(t, testsDir, 'EIO', { message: 'ENOENT: looks gone, but the code says otherwise' });
      assert.throws(() => readTestFile(gone), { code: 'EIO' });
      assert.equal(readTestFile(path.join(testsDir, 'never-there.test.cjs')), null);
    });
  });

  for (const [name, classify] of [
    ['classifyTree', classifyTree],
    ['classifyMacosTree', classifyMacosTree],
  ]) {
    test(`${name}: an ENOENT file is left out of files and total`, (t) => {
      withTestsDir('gen-platform-vanished-', { 'gone.test.cjs': DARWIN, 'kept.test.cjs': DARWIN }, (testsDir) => {
        assert.deepEqual(classify(testsDir), { total: 2, files: ['tests/gone.test.cjs', 'tests/kept.test.cjs'] });

        withFailingRead(t, testsDir, 'ENOENT');
        assert.deepEqual(classify(testsDir), { total: 1, files: ['tests/kept.test.cjs'] });
      });
    });

    test(`${name}: the files left after a skip are the same, in the same order, as with the file deleted`, (t) => {
      const files = { 'c.test.cjs': DARWIN, 'gone.test.cjs': DARWIN, 'a.test.cjs': DARWIN, 'b.test.cjs': PLAIN };
      withTestsDir('gen-platform-order-', files, (testsDir) => {
        withFailingRead(t, testsDir, 'ENOENT');
        const skipped = classify(testsDir);
        t.mock.restoreAll();

        fs.unlinkSync(path.join(testsDir, 'gone.test.cjs'));
        assert.deepEqual(skipped, classify(testsDir));
        assert.deepEqual(skipped, { total: 3, files: ['tests/a.test.cjs', 'tests/c.test.cjs'] });
      });
    });

    for (const code of ['EACCES', 'EISDIR', 'EIO', 'EMFILE', 'ENOTDIR', 'EBUSY']) {
      test(`${name}: a ${code} read error still throws`, (t) => {
        withTestsDir('gen-platform-unreadable-', { 'gone.test.cjs': PLAIN }, (testsDir) => {
          withFailingRead(t, testsDir, code);
          assert.throws(() => classify(testsDir), { code });
        });
      });
    }

    test(`${name}: two files that vanish in one run are both left out of total`, (t) => {
      const files = { 'a.test.cjs': DARWIN, 'gone.test.cjs': DARWIN, 'gone-too.test.cjs': PLAIN };
      withTestsDir('gen-platform-two-vanished-', files, (testsDir) => {
        withFailingRead(t, testsDir, 'ENOENT', { goneNames: ['gone.test.cjs', 'gone-too.test.cjs'] });
        assert.deepEqual(classify(testsDir), { total: 1, files: ['tests/a.test.cjs'] });
      });
    });

    test(`${name}: an empty file is read, counted in total and not flagged`, () => {
      withTestsDir('gen-platform-empty-', { 'empty.test.cjs': '', 'a.test.cjs': DARWIN }, (testsDir) => {
        assert.deepEqual(classify(testsDir), { total: 2, files: ['tests/a.test.cjs'] });
      });
    });

    test(`${name}: an error with no code still throws`, (t) => {
      withTestsDir('gen-platform-codeless-', { 'gone.test.cjs': PLAIN }, (testsDir) => {
        withFailingRead(t, testsDir, null, { message: 'read failed' });
        assert.throws(() => classify(testsDir), { message: 'read failed' });
      });
    });

    test(`${name}: a suite-tagged file is counted in total but never read or flagged`, (t) => {
      // Suite files are filtered out before the read, so a vanished one stays in
      // total, as on next; only unit-suite files are read and can be skipped.
      withTestsDir('gen-platform-suite-', { 'x.install.test.cjs': DARWIN, 'a.test.cjs': DARWIN }, (testsDir) => {
        withFailingRead(t, testsDir, 'ENOENT', { goneNames: ['x.install.test.cjs'] });
        assert.deepEqual(classify(testsDir), { total: 2, files: ['tests/a.test.cjs'] });
      });
    });

    test(`${name}: an error whose message says ENOENT but whose code does not still throws`, (t) => {
      withTestsDir('gen-platform-message-', { 'gone.test.cjs': PLAIN }, (testsDir) => {
        withFailingRead(t, testsDir, 'EIO', { message: 'ENOENT: looks gone, but the code says otherwise' });
        assert.throws(() => classify(testsDir), { code: 'EIO' });
      });
    });
  }

  test('classifyTree: a .platform sibling that vanished never reaches the #5074 split check', (t) => {
    // Base without signal + sibling with one is a valid split. With the sibling
    // gone, only the base is left: no split to check, nothing flagged.
    const files = { 'a.test.cjs': PLAIN, 'a.platform.test.cjs': DARWIN };
    withTestsDir('gen-platform-split-', files, (testsDir) => {
      assert.deepEqual(classifyTree(testsDir), { total: 2, files: ['tests/a.platform.test.cjs'] });

      withFailingRead(t, testsDir, 'ENOENT', { goneNames: ['a.platform.test.cjs'] });
      assert.deepEqual(classifyTree(testsDir), { total: 1, files: [] });
    });
  });
});
