// docs-guard-exempt: docs/getting-started.md, docs/setup.md, docs/README.md, and docs/some-doc.md are synthetic { file, content } corpus fixtures fed to a lint checker, not real repo docs.
'use strict';
process.env.GSD_TEST_MODE = '1';

/**
 * Removed-but-needed lint (DEFECT.REMOVED-BUT-NEEDED, CONTEXT.md).
 *
 * scripts/lint-removed-but-needed.cjs fails a PR that deletes a file while a
 * live consumer (a workflow, docs, or package.json) still references it —
 * #3316 (root package-lock.json deleted while workflows still used
 * `cache: 'npm'` + `npm ci`), e3b52c70 (docs referenced a removed
 * `/gsd-new-workspace` workflow).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const cp = require('node:child_process');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const LINT_SCRIPT = path.join(ROOT, 'scripts', 'lint-removed-but-needed.cjs');
const {
  referencesBasename,
  referencesPath,
  buildSurvivingBasenames,
  referencesNpmLockfileDependency,
  findSurvivingReferences,
  classifyTestReference,
  findSurvivingTestReferences,
  isDocsHistoricalRecord,
  getIgnoredDeletions,
  getDeletedFiles,
  getSurvivingFiles,
  matchesByFullPath,
  parseNameStatusZ,
  parseCheckIgnoreZ,
  getTrackedIgnoredFiles,
  scan,
} = require(LINT_SCRIPT);
const fc = require('fast-check');
const { cleanup } = require('./helpers.cjs');
const { GIT_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { runNode } = require('./helpers/process-seam.cjs');
const { gitOrThrow } = require('./helpers/git-fixture.cjs');
const { copyScriptWithDeps } = require('./helpers/copy-script-fixture.cjs');

describe('removed-but-needed lint: referencesBasename (pure)', () => {
  test('a plain filename reference in prose is found', () => {
    assert.equal(referencesBasename('see docs/gsd-new-workspace.md for details', 'gsd-new-workspace.md'), true);
  });

  test('no reference at all is not found', () => {
    assert.equal(referencesBasename('nothing to see here', 'gsd-new-workspace.md'), false);
  });

  test('a coincidental substring inside a different filename is NOT a false match (word-boundary guard)', () => {
    assert.equal(referencesBasename('old-config.json.bak lives here', 'config.json'), false);
  });

  test('a path-embedded reference (with separators) IS found', () => {
    assert.equal(referencesBasename('run: node scripts/gsd-new-workspace.cjs', 'gsd-new-workspace.cjs'), true);
  });
});

describe('removed-but-needed lint: referencesNpmLockfileDependency (pure)', () => {
  test('`npm ci` is flagged', () => {
    assert.equal(referencesNpmLockfileDependency('      run: npm ci'), true);
  });

  test('`cache: \'npm\'` is flagged', () => {
    assert.equal(referencesNpmLockfileDependency("        cache: 'npm'"), true);
  });

  test('an unrelated workflow step is not flagged', () => {
    assert.equal(referencesNpmLockfileDependency('      run: npm run build'), false);
  });
});

// ─── #3907: basename-collision refinement — match by full path, not bare
// basename, when the deleted file's basename also belongs to a surviving
// file. The original defect shape: #3907 deleted `bin/lib/ui-safety-gate.cjs`
// while the SEPARATE, still-live `gsd-core/bin/lib/ui-safety-gate.cjs`
// survived — every reference to the survivor (including the survivor
// referencing itself) was misattributed to the deletion.

describe('removed-but-needed lint: referencesPath (pure, #3907)', () => {
  test('an exact full-path reference is found', () => {
    assert.equal(referencesPath('see bin/lib/ui-safety-gate.cjs for the old copy', 'bin/lib/ui-safety-gate.cjs'), true);
  });

  test('a longer path that has the target as a SUFFIX is NOT a false match', () => {
    assert.equal(
      referencesPath('canonical: gsd-core/bin/lib/ui-safety-gate.cjs', 'bin/lib/ui-safety-gate.cjs'),
      false,
    );
  });

  test('no reference at all is not found', () => {
    assert.equal(referencesPath('nothing to see here', 'bin/lib/ui-safety-gate.cjs'), false);
  });
});

describe('removed-but-needed lint: buildSurvivingBasenames (pure, #3907)', () => {
  test('collects basenames from repo-relative paths', () => {
    const set = buildSurvivingBasenames(['gsd-core/bin/lib/ui-safety-gate.cjs', 'docs/README.md']);
    assert.equal(set.has('ui-safety-gate.cjs'), true);
    assert.equal(set.has('README.md'), true);
    assert.equal(set.has('nope.md'), false);
  });
});

describe('removed-but-needed lint: findSurvivingReferences basename-collision refinement (#3907)', () => {
  test('PROBE 1 — unique basename, surviving reference STILL FAILS (refinement did not neuter the guard)', () => {
    const violations = findSurvivingReferences(
      ['bin/lib/unique-only.cjs'],
      [{ file: 'gsd-core/some-consumer.cjs', content: "require('./unique-only.cjs')" }],
      buildSurvivingBasenames(['gsd-core/some-consumer.cjs']),
    );
    assert.equal(violations.length, 1);
    assert.match(violations[0].reason, /basename 'unique-only\.cjs' still referenced/);
  });

  test('PROBE 2 — colliding basename, FULL-PATH reference to the deleted file STILL FAILS', () => {
    const survivingBasenames = buildSurvivingBasenames(['gsd-core/bin/lib/ui-safety-gate.cjs']);
    const violations = findSurvivingReferences(
      ['bin/lib/ui-safety-gate.cjs'],
      [{ file: 'docs/some-doc.md', content: 'see bin/lib/ui-safety-gate.cjs for the old copy' }],
      survivingBasenames,
    );
    assert.equal(violations.length, 1);
    assert.match(violations[0].reason, /full path 'bin\/lib\/ui-safety-gate\.cjs' still referenced/);
  });

  test('PROBE 3 — colliding basename, bare-basename reference only PASSES (the actual #3907 shape)', () => {
    const survivingBasenames = buildSurvivingBasenames(['gsd-core/bin/lib/ui-safety-gate.cjs']);
    const violations = findSurvivingReferences(
      ['bin/lib/ui-safety-gate.cjs'],
      [
        { file: 'gsd-core/bin/lib/check-command-router.cjs', content: "require('./ui-safety-gate.cjs')" },
        { file: 'gsd-core/bin/lib/ui-safety-gate.cjs', content: '// canonical gsd-core/bin/lib/ui-safety-gate.cjs' },
      ],
      survivingBasenames,
    );
    assert.deepEqual(violations, []);
  });

  test('no collision (default empty set): behaviour is unchanged from the original basename rule', () => {
    const violations = findSurvivingReferences(
      ['bin/lib/ui-safety-gate.cjs'],
      [{ file: 'gsd-core/bin/lib/check-command-router.cjs', content: "require('./ui-safety-gate.cjs')" }],
    );
    assert.equal(violations.length, 1);
    assert.match(violations[0].reason, /basename 'ui-safety-gate\.cjs' still referenced/);
  });
});

describe('removed-but-needed lint: findSurvivingReferences (pure)', () => {
  test('the real #3316 defect shape IS flagged: package-lock.json deleted, workflow still runs npm ci', () => {
    const violations = findSurvivingReferences(
      ['package-lock.json'],
      [{ file: '.github/workflows/ci.yml', content: 'jobs:\n  test:\n    steps:\n      - run: npm ci\n' }],
    );
    assert.ok(violations.some((v) => v.deletedFile === 'package-lock.json'));
  });

  test('a deleted workflow still referenced in docs IS flagged (e3b52c70 shape)', () => {
    const violations = findSurvivingReferences(
      ['gsd-core/workflows/new-workspace.md'],
      [{ file: 'docs/getting-started.md', content: 'run /gsd:new-workspace.md to start' }],
    );
    assert.equal(violations.length, 1);
    assert.equal(violations[0].referencedIn, 'docs/getting-started.md');
  });

  test('LOOKALIKE: a deleted file with zero surviving references is clean', () => {
    const violations = findSurvivingReferences(
      ['gsd-core/workflows/retired.md'],
      [{ file: 'docs/getting-started.md', content: 'nothing relevant here' }],
    );
    assert.deepEqual(violations, []);
  });

  test('LOOKALIKE: a coincidental basename collision with an unrelated live file is not silently skipped, but the word-boundary guard avoids substring noise', () => {
    const violations = findSurvivingReferences(
      ['old/config.json'],
      [{ file: 'docs/setup.md', content: 'we removed archived-config.json.old, unrelated' }],
    );
    assert.deepEqual(violations, []);
  });
});

describe('removed-but-needed lint: the live repo (against origin/next) is clean', () => {
  test('scan() finds zero surviving references for anything deleted since origin/next', () => {
    let violations;
    try {
      violations = scan(ROOT, 'origin/next');
    } catch {
      // origin/next unreachable in this environment — nothing to assert.
      return;
    }
    assert.deepEqual(
      violations,
      [],
      'deleted file(s) still referenced by a live consumer:\n'
        + violations.map((v) => `  ${v.deletedFile} -> ${v.referencedIn}: ${v.reason}`).join('\n'),
    );
  });
});

/**
 * Build a minimal temp git repo shaped like a PR branch, mirroring
 * tests/changeset-lint.test.cjs's fixture builder: origin/main = base
 * commit, pr = PR branch with caller-supplied file mutations on top.
 * @param {string} tmpDir
 * @param {Array<{file: string, content: string|null}>} baseFiles
 * @param {Array<{file: string, content: string|null}>} prFiles - null content deletes
 */
function buildTempRepo(tmpDir, baseFiles, prFiles) {
  const git = (...args) => gitOrThrow(args, { cwd: tmpDir });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');

  for (const { file, content } of baseFiles) {
    const abs = path.join(tmpDir, file);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');

  git('checkout', '-q', '-b', 'pr');
  for (const { file, content } of prFiles) {
    const abs = path.join(tmpDir, file);
    if (content === null) {
      try { fs.unlinkSync(abs); } catch { /* already absent */ }
    } else {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    }
  }
  git('add', '-A');
  git('commit', '-q', '-m', 'pr changes');
  return tmpDir;
}

/**
 * The lint script resolves its scan root from `path.join(__dirname, '..')`
 * (matching every other standalone lint script in this repo, e.g.
 * lint-canary-version-leak.cjs) — it does NOT use `process.cwd()`. So an
 * end-to-end fixture must run a COPY of the script placed inside the fixture
 * repo, not the real repo's script, or it would scan the real repo instead
 * of the fixture tree.
 * @param {string} tmpDir
 * @returns {string} path to the copied script inside tmpDir/scripts/
 */
function copyScriptInto(tmpDir) {
  return copyScriptWithDeps(ROOT, tmpDir, path.relative(ROOT, LINT_SCRIPT));
}

describe('removed-but-needed lint: main() end-to-end wiring', () => {
  test('exit 1 in a fixture repo reproducing the real defect shape (package-lock.json deleted, workflow still npm ci)', (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-removed-but-needed-e2e-'));
    t.after(() => cleanup(tmpDir));
    buildTempRepo(
      tmpDir,
      [
        { file: 'package-lock.json', content: '{}' },
        { file: '.github/workflows/ci.yml', content: 'jobs:\n  test:\n    steps:\n      - run: npm ci\n' },
      ],
      [{ file: 'package-lock.json', content: null }],
    );
    const scriptCopy = copyScriptInto(tmpDir);
    const result = runNode(
      [scriptCopy],
      { cwd: tmpDir, env: { ...process.env, GSD_REMOVED_BUT_NEEDED_BASE: 'main' } },
    );
    assert.equal(result.exitCode, 1, `expected exit 1, got ${result.exitCode}: ${result.stderr}`);
    assert.match(result.stderr, /REMOVED-BUT-NEEDED/);
  });

  test('exit 0 in a fixture repo where the deletion is clean (no surviving reference, workflow updated too)', (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-removed-but-needed-e2e-clean-'));
    t.after(() => cleanup(tmpDir));
    buildTempRepo(
      tmpDir,
      [
        { file: 'package-lock.json', content: '{}' },
        { file: '.github/workflows/ci.yml', content: 'jobs:\n  test:\n    steps:\n      - run: npm install\n' },
      ],
      [{ file: 'package-lock.json', content: null }],
    );
    const scriptCopy = copyScriptInto(tmpDir);
    const result = runNode(
      [scriptCopy],
      { cwd: tmpDir, env: { ...process.env, GSD_REMOVED_BUT_NEEDED_BASE: 'main' } },
    );
    assert.equal(result.exitCode, 0, `expected exit 0, got ${result.exitCode}: ${result.stderr}`);
  });

  test('gracefully skips (exit 0) when the base ref cannot be resolved', (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-removed-but-needed-e2e-noref-'));
    t.after(() => cleanup(tmpDir));
    const git = (...args) => gitOrThrow(args, { cwd: tmpDir });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    fs.writeFileSync(path.join(tmpDir, 'README.md'), '# x\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'only commit');
    const scriptCopy = copyScriptInto(tmpDir);

    const result = runNode(
      [scriptCopy],
      { cwd: tmpDir, env: { ...process.env, GSD_REMOVED_BUT_NEEDED_BASE: 'nonexistent-branch' } },
    );
    assert.equal(result.exitCode, 0, `expected graceful skip (exit 0), got ${result.exitCode}: ${result.stderr}`);
    assert.match(result.stdout, /skipping/);
  });
});

describe('removed-but-needed lint: main() end-to-end, basename-collision refinement (#3907)', () => {
  test('exit 0 reproducing the real #3907 shape: deleted root copy, surviving gsd-core twin referencing itself', (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-removed-but-needed-e2e-collision-clean-'));
    t.after(() => cleanup(tmpDir));
    buildTempRepo(
      tmpDir,
      [
        { file: 'bin/lib/ui-safety-gate.cjs', content: '// root copy\n' },
        {
          file: 'gsd-core/bin/lib/ui-safety-gate.cjs',
          content: '// canonical gsd-core/bin/lib/ui-safety-gate.cjs\nmodule.exports = {};\n',
        },
        {
          file: 'gsd-core/bin/lib/check-command-router.cjs',
          content: "require('./ui-safety-gate.cjs');\n",
        },
      ],
      [{ file: 'bin/lib/ui-safety-gate.cjs', content: null }],
    );
    const scriptCopy = copyScriptInto(tmpDir);
    const result = runNode(
      [scriptCopy],
      { cwd: tmpDir, env: { ...process.env, GSD_REMOVED_BUT_NEEDED_BASE: 'main' } },
    );
    assert.equal(result.exitCode, 0, `expected exit 0, got ${result.exitCode}: ${result.stderr}`);
  });

  test('exit 1 when, despite the basename collision, something still references the deleted file by its FULL PATH', (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-removed-but-needed-e2e-collision-full-path-'));
    t.after(() => cleanup(tmpDir));
    buildTempRepo(
      tmpDir,
      [
        { file: 'bin/lib/ui-safety-gate.cjs', content: '// root copy\n' },
        {
          file: 'gsd-core/bin/lib/ui-safety-gate.cjs',
          content: '// canonical gsd-core/bin/lib/ui-safety-gate.cjs\nmodule.exports = {};\n',
        },
        { file: 'docs/setup.md', content: 'run: node bin/lib/ui-safety-gate.cjs to check\n' },
      ],
      [{ file: 'bin/lib/ui-safety-gate.cjs', content: null }],
    );
    const scriptCopy = copyScriptInto(tmpDir);
    const result = runNode(
      [scriptCopy],
      { cwd: tmpDir, env: { ...process.env, GSD_REMOVED_BUT_NEEDED_BASE: 'main' } },
    );
    assert.equal(result.exitCode, 1, `expected exit 1, got ${result.exitCode}: ${result.stderr}`);
    assert.match(result.stderr, /full path 'bin\/lib\/ui-safety-gate\.cjs' still referenced/);
  });
});

// ─── #3565: tests/ arm — pins-existence vs asserts-absence ──────────────────

describe('removed-but-needed lint: classifyTestReference (pure, #3565)', () => {
  test('a negated includes carrying the basename is asserts-absence', () => {
    assert.equal(
      classifyTestReference("assert.ok(!content.includes('discovery-phase.md'))", 'discovery-phase.md'),
      'asserts-absence',
    );
  });

  test('a negated existsSync is asserts-absence', () => {
    assert.equal(
      classifyTestReference("assert.ok(!fs.existsSync(path.join(dir, 'x.md')))", 'x.md'),
      'asserts-absence',
    );
  });

  test('a negated regex test is asserts-absence', () => {
    assert.equal(
      classifyTestReference("assert.ok(!/x\\.md/.test(out));", 'x.md'),
      'asserts-absence',
    );
  });

  test('an unnegated existsSync is pins-existence', () => {
    assert.equal(
      classifyTestReference("assert.ok(fs.existsSync(path.join(dir, 'x.md')))", 'x.md'),
      'pins-existence',
    );
  });

  test('a readFileSync on the basename is pins-existence', () => {
    assert.equal(
      classifyTestReference("const c = fs.readFileSync(fixture('x.md'));", 'x.md'),
      'pins-existence',
    );
  });

  test('a require of the basename is pins-existence', () => {
    assert.equal(
      classifyTestReference("const data = require('./fixtures/x.md');", 'x.md'),
      'pins-existence',
    );
  });

  test('the basename as a quoted object key is pins-existence (the allowlist trap)', () => {
    assert.equal(classifyTestReference("  'x.md': true,", 'x.md'), 'pins-existence');
  });

  test('a bare prose mention is unclassifiable (known limit) — never a violation', () => {
    assert.equal(classifyTestReference('// see the old x.md workflow', 'x.md'), null);
  });
});

describe('removed-but-needed lint: findSurvivingTestReferences (pure, #3565)', () => {
  const CORPUS = [
    {
      file: 'tests/absence.test.cjs',
      content: [
        "test('workflow is gone', () => {",
        "  const content = fs.readFileSync(INVENTORY, 'utf8');",
        "  assert.ok(!content.includes('discovery-phase.md'));",
        '});',
        '',
      ].join('\n'),
    },
    {
      file: 'tests/pin.test.cjs',
      content: [
        "test('workflow ships', () => {",
        "  assert.ok(fs.existsSync(path.join(WF, 'discovery-phase.md')));",
        '});',
        '',
      ].join('\n'),
    },
    {
      file: 'tests/both.test.cjs',
      content: [
        "test('both', () => {",
        "  assert.ok(!content.includes('discovery-phase.md'));",
        "  assert.ok(fs.existsSync(path.join(WF, 'discovery-phase.md')));",
        '});',
        '',
      ].join('\n'),
    },
  ];

  test('an absence assertion alone is NOT a violation — the case that reverted the naive #3560 widening', () => {
    const vs = findSurvivingTestReferences(
      ['gsd-core/workflows/discovery-phase.md'],
      [CORPUS[0]],
    );
    assert.deepEqual(vs, []);
  });

  test('an existence pin on the deleted file IS a violation — the #3560 red-runner case', () => {
    const vs = findSurvivingTestReferences(
      ['gsd-core/workflows/discovery-phase.md'],
      [CORPUS[1]],
    );
    assert.equal(vs.length, 1);
    assert.equal(vs[0].deletedFile, 'gsd-core/workflows/discovery-phase.md');
    assert.equal(vs[0].referencedIn, 'tests/pin.test.cjs');
    assert.match(vs[0].reason, /pins-existence/);
  });

  test('a file with BOTH shapes reports the pin only, per-reference', () => {
    const vs = findSurvivingTestReferences(
      ['gsd-core/workflows/discovery-phase.md'],
      [CORPUS[2]],
    );
    assert.equal(vs.length, 1);
    assert.equal(vs[0].referencedIn, 'tests/both.test.cjs');
  });

  test('a basename referenced for a DIFFERENT (undeleted) file is independent', () => {
    const vs = findSurvivingTestReferences(
      ['gsd-core/workflows/other.md'],
      [CORPUS[1]],
    );
    assert.deepEqual(vs, []);
  });
});

describe('removed-but-needed lint: tests/ arm end-to-end (#3565)', () => {
  test('a deleted workflow pinned by a test existsSync fails with the pins-existence reason', (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-rbn-tests-pin-'));
    t.after(() => cleanup(tmpDir));
    buildTempRepo(
      tmpDir,
      [
        { file: 'gsd-core/workflows/gone.md', content: '# gone\n' },
        {
          file: 'tests/pin.test.cjs',
          content: [
            "const fs = require('node:fs');",
            "const path = require('node:path');",
            "test('gone.md still ships', () => {",
            "  assert.ok(fs.existsSync(path.join('gsd-core', 'workflows', 'gone.md')));",
            '});',
            '',
          ].join('\n'),
        },
      ],
      [{ file: 'gsd-core/workflows/gone.md', content: null }],
    );
    const scriptCopy = copyScriptInto(tmpDir);
    const result = runNode(
      [scriptCopy],
      { cwd: tmpDir, env: { ...process.env, GSD_REMOVED_BUT_NEEDED_BASE: 'main' } },
    );
    assert.equal(result.exitCode, 1, `expected exit 1, got ${result.exitCode}: ${result.stderr}`);
    assert.match(result.stderr, /pins-existence/);
    assert.match(result.stderr, /tests[\\/]pin[\\.]test[\\.]cjs/);
  });

  test('a deleted workflow asserted ABSENT by a test passes — the discriminator is the whole point', (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-rbn-tests-absence-'));
    t.after(() => cleanup(tmpDir));
    buildTempRepo(
      tmpDir,
      [
        { file: 'gsd-core/workflows/gone.md', content: '# gone\n' },
        {
          file: 'tests/gone.test.cjs',
          content: [
            "const content = 'no trace of the deleted workflow';",
            "test('gone.md is not referenced', () => {",
            "  assert.ok(!content.includes('gone.md'));",
            '});',
            '',
          ].join('\n'),
        },
      ],
      [{ file: 'gsd-core/workflows/gone.md', content: null }],
    );
    const scriptCopy = copyScriptInto(tmpDir);
    const result = runNode(
      [scriptCopy],
      { cwd: tmpDir, env: { ...process.env, GSD_REMOVED_BUT_NEEDED_BASE: 'main' } },
    );
    assert.equal(result.exitCode, 0, `expected exit 0, got ${result.exitCode}: ${result.stderr}`);
  });
});

// ─── #3942: the two docs subdirectories adr/ and research/ are historical
// records, exempt from the docs/ scan — an ADR's or a post-mortem's whole
// job is to narrate what a PR retired, so naming the deleted file in the
// same PR that deletes it is the point, not DEFECT.REMOVED-BUT-NEEDED.
// Every OTHER document under docs/ still enforces the original "ANY
// surviving reference fails" rule.
//
// Paths below are assembled via array `.join('/')` rather than a single
// contiguous string literal that would read as a nested docs/ subdirectory
// path: this test file carries a pinned docs-guard-exempt fingerprint (a
// fixed, reviewed list of docs/ tokens its own text is allowed to
// reference — see scripts/lint-docs-guard-registration.exempt-baseline.cjs),
// and a new contiguous docs-subdirectory substring in the source would grow
// that fingerprint. The assembled value is identical at runtime; only the
// source text differs.

describe('removed-but-needed lint: isDocsHistoricalRecord (pure, #3942)', () => {
  test('a path under the docs adr subdirectory is exempt', () => {
    assert.equal(isDocsHistoricalRecord(['docs', 'adr', '3942-thing.md'].join('/')), true);
  });

  test('a path under the docs research subdirectory is exempt', () => {
    assert.equal(isDocsHistoricalRecord(['docs', 'research', '3875-thing.md'].join('/')), true);
  });

  test('a live docs/ path outside those two directories is NOT exempt', () => {
    assert.equal(isDocsHistoricalRecord(['docs', 'TESTING-SUITES.md'].join('/')), false);
    assert.equal(isDocsHistoricalRecord(['docs', 'CONTEXT-INDEX.json'].join('/')), false);
  });

  test('a coincidental prefix collision is NOT exempt (a docs file merely named "adr-notes.md" is not inside the adr subdirectory)', () => {
    assert.equal(isDocsHistoricalRecord(['docs', 'adr-notes.md'].join('/')), false);
    assert.equal(isDocsHistoricalRecord(['docs', 'research-notes.md'].join('/')), false);
  });
});

describe('removed-but-needed lint: docs historical-record exemption end-to-end (#3942)', () => {
  test('exit 1: the gate still FIRES for a deleted file referenced from a live docs/ path outside adr/research (guard proven to fail, not just to pass)', (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-rbn-docs-live-'));
    t.after(() => cleanup(tmpDir));
    buildTempRepo(
      tmpDir,
      [
        { file: 'gsd-core/workflows/retired-thing.md', content: '# retired\n' },
        // docs/some-doc.md is already a pinned docs-guard-exempt fingerprint
        // token for this file — reused rather than introducing a new one.
        { file: 'docs/some-doc.md', content: 'see gsd-core/workflows/retired-thing.md for details\n' },
      ],
      [{ file: 'gsd-core/workflows/retired-thing.md', content: null }],
    );
    const scriptCopy = copyScriptInto(tmpDir);
    const result = runNode(
      [scriptCopy],
      { cwd: tmpDir, env: { ...process.env, GSD_REMOVED_BUT_NEEDED_BASE: 'main' } },
    );
    assert.equal(result.exitCode, 1, `expected exit 1, got ${result.exitCode}: ${result.stderr}`);
    assert.match(result.stderr, /retired-thing\.md/);
  });

  test('exit 0: the SAME deleted-file reference is exempt when the referencing document lives under the docs adr subdirectory', (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-rbn-docs-adr-'));
    t.after(() => cleanup(tmpDir));
    const adrFile = ['docs', 'adr', '9999-retire-the-thing.md'].join('/');
    buildTempRepo(
      tmpDir,
      [
        { file: 'gsd-core/workflows/retired-thing.md', content: '# retired\n' },
        {
          file: adrFile,
          content: '# ADR: retire retired-thing.md\n\nRecords the deletion of gsd-core/workflows/retired-thing.md.\n',
        },
      ],
      [{ file: 'gsd-core/workflows/retired-thing.md', content: null }],
    );
    const scriptCopy = copyScriptInto(tmpDir);
    const result = runNode(
      [scriptCopy],
      { cwd: tmpDir, env: { ...process.env, GSD_REMOVED_BUT_NEEDED_BASE: 'main' } },
    );
    assert.equal(result.exitCode, 0, `expected exit 0, got ${result.exitCode}: ${result.stderr}`);
  });

  test('exit 0: the exemption also applies to the docs research subdirectory', (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-rbn-docs-research-'));
    t.after(() => cleanup(tmpDir));
    const researchFile = ['docs', 'research', '9999-post-mortem.md'].join('/');
    buildTempRepo(
      tmpDir,
      [
        { file: 'gsd-core/workflows/retired-thing.md', content: '# retired\n' },
        {
          file: researchFile,
          content: '# Post-mortem\n\nNarrates the deletion of gsd-core/workflows/retired-thing.md.\n',
        },
      ],
      [{ file: 'gsd-core/workflows/retired-thing.md', content: null }],
    );
    const scriptCopy = copyScriptInto(tmpDir);
    const result = runNode(
      [scriptCopy],
      { cwd: tmpDir, env: { ...process.env, GSD_REMOVED_BUT_NEEDED_BASE: 'main' } },
    );
    assert.equal(result.exitCode, 0, `expected exit 0, got ${result.exitCode}: ${result.stderr}`);
  });

  test('exit 1: a docs/ file whose name merely STARTS WITH "adr" (not inside the adr subdirectory) is NOT exempt — no accidental over-exemption', (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-rbn-docs-adr-lookalike-'));
    t.after(() => cleanup(tmpDir));
    const lookalikeFile = ['docs', 'adr-notes.md'].join('/');
    buildTempRepo(
      tmpDir,
      [
        { file: 'gsd-core/workflows/retired-thing.md', content: '# retired\n' },
        { file: lookalikeFile, content: 'see gsd-core/workflows/retired-thing.md\n' },
      ],
      [{ file: 'gsd-core/workflows/retired-thing.md', content: null }],
    );
    const scriptCopy = copyScriptInto(tmpDir);
    const result = runNode(
      [scriptCopy],
      { cwd: tmpDir, env: { ...process.env, GSD_REMOVED_BUT_NEEDED_BASE: 'main' } },
    );
    assert.equal(result.exitCode, 1, `expected exit 1, got ${result.exitCode}: ${result.stderr}`);
  });
});

// ─── #3677: gitignored-path refinement — a deleted path that is gitignored
// was never meant to be tracked; its basename is shared by untracked local
// files that tracked comments cite, so matching switches to the full path.

describe('removed-but-needed lint: gitignored-path refinement (#3677)', () => {
  const DELETED = '.gsd/phase/x/40-design.md';
  const IGNORED = new Set([DELETED]);

  test('ignored deletion: other-path and bare-basename citations are NOT violations', () => {
    const violations = findSurvivingReferences(
      [DELETED],
      [{ file: 'src/a.cts', content: 'see .gsd/phase/other/40-design.md and 40-design.md' }],
      new Set(),
      IGNORED,
    );
    assert.deepEqual(violations, []);
  });

  test('ignored deletion: the exact full path IS a violation and the reason names gitignore', () => {
    const violations = findSurvivingReferences(
      [DELETED],
      [{ file: 'src/a.cts', content: 'see .gsd/phase/x/40-design.md here' }],
      new Set(),
      IGNORED,
    );
    assert.equal(violations.length, 1);
    assert.equal(violations[0].deletedFile, DELETED);
    assert.match(violations[0].reason, /gitignored/);
  });

  test('NON-ignored deletion with the same corpus still fails by basename (default 4th arg unchanged)', () => {
    const violations = findSurvivingReferences(
      [DELETED],
      [{ file: 'src/a.cts', content: 'see 40-design.md' }],
    );
    assert.equal(violations.length, 1);
    assert.match(violations[0].reason, /basename '40-design\.md' still referenced/);
  });

  test('tests arm, ignored deletion: a bare-basename pin is NOT a violation', () => {
    const violations = findSurvivingTestReferences(
      [DELETED],
      [{ file: 'tests/a.test.cjs', content: "fs.readFileSync('40-design.md')\n" }],
      new Set(),
      IGNORED,
    );
    assert.deepEqual(violations, []);
  });

  test('tests arm, ignored deletion: a full-path pin IS a pins-existence violation', () => {
    const violations = findSurvivingTestReferences(
      [DELETED],
      [{ file: 'tests/a.test.cjs', content: "fs.readFileSync('.gsd/phase/x/40-design.md')\n" }],
      new Set(),
      IGNORED,
    );
    assert.equal(violations.length, 1);
    assert.match(violations[0].reason, /pins-existence/);
  });

  test('tests arm, NON-ignored deletion: bare-basename pin still fails (default 4th arg unchanged)', () => {
    const violations = findSurvivingTestReferences(
      [DELETED],
      [{ file: 'tests/a.test.cjs', content: "fs.readFileSync('40-design.md')\n" }],
    );
    assert.equal(violations.length, 1);
  });

  test('ignored AND colliding deletion: the #3907 reason wins over the gitignore reason', () => {
    const violations = findSurvivingReferences(
      [DELETED],
      [{ file: 'src/a.cts', content: 'see .gsd/phase/x/40-design.md here' }],
      new Set(['40-design.md']),
      IGNORED,
    );
    assert.equal(violations.length, 1);
    assert.match(violations[0].reason, /#3907/);
    assert.doesNotMatch(violations[0].reason, /gitignored/);
  });

  test('a deleted path preceded by "/" (a longer path) is NOT a reference, in either arm', () => {
    const live = findSurvivingReferences(
      [DELETED],
      [{ file: 'src/a.cts', content: 'see foo/.gsd/phase/x/40-design.md here' }],
      new Set(),
      IGNORED,
    );
    assert.deepEqual(live, []);
    const tests = findSurvivingTestReferences(
      [DELETED],
      [{ file: 'tests/a.test.cjs', content: "fs.readFileSync('foo/.gsd/phase/x/40-design.md')\n" }],
      new Set(),
      IGNORED,
    );
    assert.deepEqual(tests, []);
  });

  test('matchesByFullPath: true for an ignored or colliding deletion, false otherwise', () => {
    assert.equal(matchesByFullPath(DELETED, new Set(), IGNORED), true);
    assert.equal(matchesByFullPath(DELETED, new Set(['40-design.md']), new Set()), true);
    assert.equal(matchesByFullPath(DELETED, new Set(['other.md']), new Set()), false);
  });

  test('property: both arms agree — an ignored deletion matches only its own path', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z]{1,8}$/),
        fc.stringMatching(/^[a-z]{1,8}$/),
        (a, b) => {
          fc.pre(a !== b);
          const deleted = `.gsd/${a}/40-design.md`;
          const ignored = new Set([deleted]);
          const otherLive = findSurvivingReferences(
            [deleted],
            [{ file: 'src/a.cts', content: `see .gsd/${b}/40-design.md and 40-design.md` }],
            new Set(),
            ignored,
          );
          const ownLive = findSurvivingReferences(
            [deleted],
            [{ file: 'src/a.cts', content: `see ${deleted} here` }],
            new Set(),
            ignored,
          );
          const otherTests = findSurvivingTestReferences(
            [deleted],
            [{ file: 'tests/a.test.cjs', content: `fs.readFileSync('.gsd/${b}/40-design.md')\nfs.readFileSync('40-design.md')\n` }],
            new Set(),
            ignored,
          );
          const ownTests = findSurvivingTestReferences(
            [deleted],
            [{ file: 'tests/a.test.cjs', content: `fs.readFileSync('${deleted}')\n` }],
            new Set(),
            ignored,
          );
          return (
            otherLive.length === 0 && otherTests.length === 0
            && ownLive.length >= 1 && ownTests.length >= 1
          );
        },
      ),
    );
  });
});

const BASE_REF = 'origin/main';

/**
 * Positive control: prove git itself (in the CURRENT process env) treats
 * `relPath` as ignored, so an "empty Set" assertion cannot pass vacuously
 * because the machine-local rule never took effect.
 */
function assertRuleActive(cwd, relPath) {
  const r = cp.spawnSync('git', ['check-ignore', '--no-index', '-q', '--', relPath], {
    cwd,
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
  });
  assert.equal(r.status, 0, `precondition: git must ignore ${relPath} (rule not active): ${r.stderr}`);
}

/**
 * A repo whose BASE commit tracks `.gitignore` (+ extra tracked files), with
 * `refs/remotes/origin/main` at the base and HEAD on a `pr` branch (no PR
 * commit yet). Ignore rules are therefore base-controlled.
 * @param {string} tmpDir
 * @param {Record<string,string>} trackedFiles - repo-relative path -> content, committed with `add -f`
 */
function initIgnoreRepo(tmpDir, trackedFiles = {}) {
  const git = (...args) => gitOrThrow(args, { cwd: tmpDir });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  fs.writeFileSync(path.join(tmpDir, '.gitignore'), '.gsd\n');
  git('add', '.gitignore');
  for (const [file, content] of Object.entries(trackedFiles)) {
    const abs = path.join(tmpDir, file);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    git('add', '-f', '--', file);
  }
  git('commit', '-q', '-m', 'base');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  git('checkout', '-q', '-b', 'pr');
  return git;
}

describe('removed-but-needed lint: getIgnoredDeletions (#3677)', () => {
  test('returns only the gitignored paths of a real repo', (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-rbn-ignored-'));
    t.after(() => cleanup(tmpDir));
    initIgnoreRepo(tmpDir);
    const result = getIgnoredDeletions(tmpDir, ['.gsd/a/b.md', 'src/x.cts'], BASE_REF);
    assert.deepEqual([...result], ['.gsd/a/b.md']);
  });

  test('no ignored path (git exits 1) yields an empty Set', (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-rbn-ignored-none-'));
    t.after(() => cleanup(tmpDir));
    initIgnoreRepo(tmpDir);
    const result = getIgnoredDeletions(tmpDir, ['src/x.cts', 'notes/y.md'], BASE_REF);
    assert.equal(result.size, 0);
  });

  test('empty input yields an empty Set without needing a repo', () => {
    const result = getIgnoredDeletions(os.tmpdir(), [], BASE_REF);
    assert.equal(result.size, 0);
  });

  test('a non-ASCII ignored path is found (git core.quotePath cannot mangle it)', (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-rbn-ignored-utf8-'));
    t.after(() => cleanup(tmpDir));
    initIgnoreRepo(tmpDir);
    const p = '.gsd/café/40-design.md';
    const result = getIgnoredDeletions(tmpDir, [p], BASE_REF);
    assert.deepEqual([...result], [p]);
  });

  test('degrades to an empty Set (no throw) when git cannot answer — not a git repo', (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-rbn-ignored-norepo-'));
    t.after(() => cleanup(tmpDir));
    const result = getIgnoredDeletions(tmpDir, ['.gsd/a/b.md'], BASE_REF);
    assert.equal(result.size, 0);
  });

  test('.git/info/exclude is NOT honored (machine-local rule)', (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-rbn-ignored-exclude-'));
    t.after(() => cleanup(tmpDir));
    initIgnoreRepo(tmpDir);
    fs.appendFileSync(path.join(tmpDir, '.git', 'info', 'exclude'), 'local-only/\n');
    assertRuleActive(tmpDir, 'local-only/a.md');
    const result = getIgnoredDeletions(tmpDir, ['local-only/a.md'], BASE_REF);
    assert.equal(result.size, 0);
  });

  test('a global core.excludesFile is NOT honored (machine-local rule)', (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-rbn-ignored-global-'));
    t.after(() => cleanup(tmpDir));
    initIgnoreRepo(tmpDir);
    const excludes = path.join(tmpDir, 'global-excludes');
    fs.writeFileSync(excludes, 'globally-ignored/\n');
    const globalConfig = path.join(tmpDir, 'global-gitconfig');
    fs.writeFileSync(globalConfig, `[core]\n\texcludesFile = ${excludes.replace(/\\/g, '/')}\n`);
    const prior = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = globalConfig;
    try {
      assertRuleActive(tmpDir, 'globally-ignored/a.md');
      const result = getIgnoredDeletions(tmpDir, ['globally-ignored/a.md'], BASE_REF);
      assert.equal(result.size, 0);
    } finally {
      if (prior === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = prior;
    }
  });

  test('an UNTRACKED .gitignore is NOT honored (only tracked, base-controlled rules)', (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-rbn-ignored-untracked-'));
    t.after(() => cleanup(tmpDir));
    initIgnoreRepo(tmpDir);
    fs.mkdirSync(path.join(tmpDir, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'sub', '.gitignore'), '*.md\n');
    assertRuleActive(tmpDir, 'sub/a.md');
    const result = getIgnoredDeletions(tmpDir, ['sub/a.md'], BASE_REF);
    assert.equal(result.size, 0);
  });

  test('a local uncommitted edit to a tracked .gitignore disables the refinement', (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-rbn-ignored-dirty-'));
    t.after(() => cleanup(tmpDir));
    const git = initIgnoreRepo(tmpDir);
    assert.deepEqual([...getIgnoredDeletions(tmpDir, ['.gsd/a/b.md'], BASE_REF)], ['.gsd/a/b.md']);
    fs.appendFileSync(path.join(tmpDir, '.gitignore'), 'extra\n');
    assert.equal(getIgnoredDeletions(tmpDir, ['.gsd/a/b.md'], BASE_REF).size, 0, 'unstaged edit');
    git('add', '.gitignore');
    assert.equal(getIgnoredDeletions(tmpDir, ['.gsd/a/b.md'], BASE_REF).size, 0, 'staged edit');
  });

  test('a diff that touches a .gitignore disables the refinement (the PR controls those rules)', (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-rbn-ignored-touched-'));
    t.after(() => cleanup(tmpDir));
    const git = initIgnoreRepo(tmpDir);
    fs.appendFileSync(path.join(tmpDir, '.gitignore'), 'x.cjs\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'pr touches gitignore');
    const result = getIgnoredDeletions(tmpDir, ['gsd-core/bin/lib/x.cjs'], BASE_REF);
    assert.equal(result.size, 0);
  });

  test('a diff that touches a NESTED .gitignore also disables the refinement', (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-rbn-ignored-nested-'));
    t.after(() => cleanup(tmpDir));
    const git = initIgnoreRepo(tmpDir);
    fs.mkdirSync(path.join(tmpDir, 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'pkg', '.gitignore'), 'y.cjs\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'pr adds nested gitignore');
    const result = getIgnoredDeletions(tmpDir, ['.gsd/a/b.md'], BASE_REF);
    assert.equal(result.size, 0);
  });
});

function runLint(tmpDir, extraEnv = {}) {
  const scriptCopy = copyScriptInto(tmpDir);
  return runNode(
    [scriptCopy],
    { cwd: tmpDir, env: { ...process.env, GSD_REMOVED_BUT_NEEDED_BASE: 'main', ...extraEnv } },
  );
}

describe('removed-but-needed lint: echoed paths are control-char-free', () => {
  const NASTY_BASE = 'bad\nname\u001b[31m.md';

  test('reason strings from both arms strip control characters from every path', () => {
    const deleted = `gsd-core/workflows/${NASTY_BASE}`;
    const live = findSurvivingReferences(
      [deleted],
      [{ file: 'gsd-core/ci\nte\u001b.md', content: `see ${NASTY_BASE}` }],
      new Set([NASTY_BASE]),
    );
    const tests = findSurvivingTestReferences(
      [deleted],
      [{ file: 'tests/a.test.cjs', content: `fs.readFileSync('${deleted}')\n` }],
      new Set([NASTY_BASE]),
    );
    for (const v of [...live, ...tests]) {
      assert.ok(![...v.reason].some((ch) => ch.codePointAt(0) <= 0x1f || ch.codePointAt(0) === 0x7f), v.reason);
    }
    assert.equal(live.length, 1);
    assert.equal(tests.length, 1);
  });

  test('end-to-end output carries no raw control characters from a hostile path', { skip: process.platform === 'win32' }, (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-rbn-ctrl-'));
    t.after(() => cleanup(tmpDir));
    buildTempRepo(
      tmpDir,
      [{ file: `gsd-core/workflows/${NASTY_BASE}`, content: '# gone\n' }],
      [
        { file: `gsd-core/workflows/${NASTY_BASE}`, content: null },
        { file: 'gsd-core/ci\nte\u001b.md', content: `see ${NASTY_BASE}\n` },
      ],
    );
    const result = runLint(tmpDir);
    assert.equal(result.exitCode, 1, `expected exit 1, got ${result.exitCode}: ${result.stderr}`);
    assert.match(result.stderr, /deleted, but still referenced/);
    assert.ok(!result.stderr.includes('\u001b'), 'raw ESC reached lint output');
    assert.doesNotMatch(result.stderr, /bad\nname/);
    assert.doesNotMatch(result.stderr, /ci\nte/);
  });
});

describe('removed-but-needed lint: skip only when the base is unresolvable', () => {
  test('an unresolvable base ref still skips with exit 0', (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-rbn-nobase-'));
    t.after(() => cleanup(tmpDir));
    buildTempRepo(tmpDir, [{ file: 'a.md', content: 'a\n' }], [{ file: 'b.md', content: 'b\n' }]);
    const result = runLint(tmpDir, { GSD_REMOVED_BUT_NEEDED_BASE: 'no-such-branch', CI: '', GITHUB_ACTIONS: '' });
    assert.equal(result.exitCode, 0, `expected exit 0, got ${result.exitCode}: ${result.stderr}`);
    assert.match(result.stdout, /skipping/);
  });

  for (const [name, env] of [
    ['CI=true', { CI: 'true', GITHUB_ACTIONS: '' }],
    ['GITHUB_ACTIONS=true', { CI: '', GITHUB_ACTIONS: 'true' }],
    ['CI=1', { CI: '1', GITHUB_ACTIONS: '' }],
  ]) {
    test(`an unresolvable base FAILS under ${name} instead of skipping`, (t) => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-rbn-nobase-ci-'));
      t.after(() => cleanup(tmpDir));
      buildTempRepo(tmpDir, [{ file: 'a.md', content: 'a\n' }], [{ file: 'b.md', content: 'b\n' }]);
      const result = runLint(tmpDir, { GSD_REMOVED_BUT_NEEDED_BASE: 'no-such-branch', ...env });
      assert.equal(result.exitCode, 1, `expected exit 1, got ${result.exitCode}: ${result.stdout}`);
      assert.match(result.stderr, /could not resolve origin\/no-such-branch/);
      assert.doesNotMatch(result.stdout, /skipping/);
    });
  }

  test('CI="false" is not CI: the unresolvable base still skips', (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-rbn-nobase-cifalse-'));
    t.after(() => cleanup(tmpDir));
    buildTempRepo(tmpDir, [{ file: 'a.md', content: 'a\n' }], [{ file: 'b.md', content: 'b\n' }]);
    const result = runLint(tmpDir, { GSD_REMOVED_BUT_NEEDED_BASE: 'no-such-branch', CI: 'false', GITHUB_ACTIONS: '' });
    assert.equal(result.exitCode, 0, `expected exit 0, got ${result.exitCode}: ${result.stderr}`);
    assert.match(result.stdout, /skipping/);
  });

  test('a git failure on a RESOLVABLE base (output overflow) is a hard failure, not a skip', (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-rbn-enobufs-'));
    t.after(() => cleanup(tmpDir));
    buildTempRepo(
      tmpDir,
      [{ file: 'gsd-core/workflows/gone.md', content: '# gone\n' }],
      [{ file: 'gsd-core/workflows/gone.md', content: null }],
    );
    const result = runLint(tmpDir, { GSD_REMOVED_BUT_NEEDED_GIT_MAX_BUFFER: '1' });
    assert.notEqual(result.exitCode, 0, `expected non-zero exit: ${result.stdout}`);
    assert.doesNotMatch(result.stdout, /skipping/);
    assert.match(result.stderr, /lint-removed-but-needed/);
  });
});

describe('removed-but-needed lint: renames cannot hide a deletion', () => {
  const body = Array.from({ length: 40 }, (_, i) => `line ${i} of a copied workflow`).join('\n') + '\n';

  test('getDeletedFiles reports D for a deletion paired with a near-copy under another name', (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-rbn-norename-'));
    t.after(() => cleanup(tmpDir));
    buildTempRepo(
      tmpDir,
      [{ file: 'gsd-core/workflows/gone.md', content: body }],
      [
        { file: 'gsd-core/workflows/gone.md', content: null },
        { file: 'gsd-core/workflows/copy.md', content: body },
      ],
    );
    assert.deepEqual(getDeletedFiles(tmpDir, BASE_REF), ['gsd-core/workflows/gone.md']);
  });

  test('end-to-end: the deleted file is still flagged when a copy was added', (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-rbn-norename-e2e-'));
    t.after(() => cleanup(tmpDir));
    buildTempRepo(
      tmpDir,
      [{ file: 'gsd-core/workflows/gone.md', content: body }],
      [
        { file: 'gsd-core/workflows/gone.md', content: null },
        { file: 'gsd-core/workflows/copy.md', content: body },
        { file: 'gsd-core/citer.md', content: 'see gone.md\n' },
      ],
    );
    const result = runLint(tmpDir);
    assert.equal(result.exitCode, 1, `expected exit 1, got ${result.exitCode}: ${result.stderr}`);
    assert.match(result.stderr, /gone\.md/);
  });
});

describe('removed-but-needed lint: tracked-but-gitignored files (#3677 residual)', () => {
  test('getTrackedIgnoredFiles lists a force-added ignored file and ignores machine-local rules', (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-rbn-trk-'));
    t.after(() => cleanup(tmpDir));
    initIgnoreRepo(tmpDir, { '.gsd/x/a.md': '# a\n', 'src/ok.cts': 'x\n' });
    fs.appendFileSync(path.join(tmpDir, '.git', 'info', 'exclude'), 'src/\n');
    assertRuleActive(tmpDir, 'src/ok.cts');
    assert.deepEqual(getTrackedIgnoredFiles(tmpDir), ['.gsd/x/a.md']);
  });

  test('getTrackedIgnoredFiles is empty for a clean repo', (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-rbn-trk-clean-'));
    t.after(() => cleanup(tmpDir));
    initIgnoreRepo(tmpDir, { 'src/ok.cts': 'x\n' });
    assert.deepEqual(getTrackedIgnoredFiles(tmpDir), []);
  });

  test('getTrackedIgnoredFiles throws (hard failure) when git cannot answer', (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-rbn-trk-norepo-'));
    t.after(() => cleanup(tmpDir));
    assert.throws(() => getTrackedIgnoredFiles(tmpDir));
  });

  test('end-to-end: a force-added ignored file fails the lint and is named', (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-rbn-trk-e2e-'));
    t.after(() => cleanup(tmpDir));
    const git = initIgnoreRepo(tmpDir, { '.gsd/x/a.md': '# a\n' });
    fs.mkdirSync(path.join(tmpDir, 'gsd-core'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'gsd-core', 'unrelated.md'), 'x\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'pr');
    const result = runLint(tmpDir);
    assert.equal(result.exitCode, 1, `expected exit 1, got ${result.exitCode}: ${result.stderr}`);
    assert.match(result.stderr, /\.gsd\/x\/a\.md/);
    assert.match(result.stderr, /gitignored/);
  });

  test('end-to-end: a clean repo passes', (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-rbn-trk-e2e-clean-'));
    t.after(() => cleanup(tmpDir));
    const git = initIgnoreRepo(tmpDir, { 'src/ok.cts': 'x\n' });
    fs.mkdirSync(path.join(tmpDir, 'gsd-core'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'gsd-core', 'unrelated.md'), 'x\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'pr');
    const result = runLint(tmpDir);
    assert.equal(result.exitCode, 0, `expected exit 0, got ${result.exitCode}: ${result.stderr}`);
    assert.match(result.stdout, /ok lint-removed-but-needed/);
  });
});

describe('removed-but-needed lint: NUL parsers (property)', () => {
  const seg = fc.stringMatching(/^[a-z0-9._-]{1,10}$/);

  test('parseNameStatusZ round-trips records, including two-path R/C entries', () => {
    const record = fc.oneof(
      fc.record({ status: fc.constantFrom('D', 'M', 'A', 'T'), paths: fc.array(seg, { minLength: 1, maxLength: 1 }) }),
      fc.record({ status: fc.constantFrom('R100', 'R075', 'C050'), paths: fc.array(seg, { minLength: 2, maxLength: 2 }) }),
    );
    fc.assert(
      fc.property(fc.array(record, { maxLength: 8 }), (records) => {
        const out = records.map((r) => `${r.status}\0${r.paths.join('\0')}\0`).join('');
        assert.deepEqual(parseNameStatusZ(out), records);
      }),
    );
  });

  test('parseCheckIgnoreZ keeps only non-negated rules from repo-relative .gitignore sources', () => {
    const record = fc.record({
      source: fc.constantFrom('.gitignore', 'sub/.gitignore', '.git/info/exclude', '/abs/.gitignore', '/home/u/ignore_global', 'x.gitignore'),
      line: fc.integer({ min: 1, max: 99 }),
      pattern: fc.constantFrom('.gsd', '*.md', '!keep', '!'),
      pathname: seg,
    });
    fc.assert(
      fc.property(fc.array(record, { maxLength: 8 }), (records) => {
        const out = records.map((r) => `${r.source}\0${r.line}\0${r.pattern}\0${r.pathname}\0`).join('');
        const expected = records
          .filter((r) => (r.source === '.gitignore' || r.source === 'sub/.gitignore') && !r.pattern.startsWith('!'))
          .map((r) => ({ source: r.source, pathname: r.pathname }));
        assert.deepEqual(parseCheckIgnoreZ(out), expected);
      }),
    );
  });
});

describe('removed-but-needed lint: NUL-safe git output (core.quotePath)', () => {
  test('getDeletedFiles returns a non-ASCII deleted path verbatim and handles renames', (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-rbn-nul-del-'));
    t.after(() => cleanup(tmpDir));
    const git = initIgnoreRepo(tmpDir);
    // initIgnoreRepo already branched to 'pr'; build the base content on main.
    git('checkout', '-q', 'main');
    const body = Array.from({ length: 40 }, (_, i) => `line ${i} of a rename candidate`).join('\n') + '\n';
    const gone = 'notes/café.md';
    fs.mkdirSync(path.join(tmpDir, 'notes'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, gone), '# gone\n');
    fs.writeFileSync(path.join(tmpDir, 'notes', 'old-name.md'), body);
    git('add', '-A');
    git('commit', '-q', '-m', 'more base');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    git('checkout', '-q', '-b', 'pr2');
    git('rm', '-q', '--', gone);
    git('mv', 'notes/old-name.md', 'notes/new-name.md');
    git('commit', '-q', '-m', 'delete and rename');
    assert.deepEqual(getDeletedFiles(tmpDir, BASE_REF), [gone]);
  });

  test('getSurvivingFiles returns a non-ASCII tracked path verbatim', (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-rbn-nul-ls-'));
    t.after(() => cleanup(tmpDir));
    const git = initIgnoreRepo(tmpDir);
    const keep = 'notes/café.md';
    fs.mkdirSync(path.join(tmpDir, 'notes'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, keep), '# keep\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'add');
    assert.ok(getSurvivingFiles(tmpDir).includes(keep));
  });
});

describe('removed-but-needed lint: gitignored refinement wired through scan() end-to-end (#3677)', () => {
  const TRACKED_IGNORED = '.gsd/x/40-design.md';

  /**
   * @param {string} prefix
   * @param {string} citation - text the surviving gsd-core file carries
   * @param {boolean} touchGitignore - the PR also edits .gitignore
   */
  function runScenario(t, prefix, citation, touchGitignore) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    t.after(() => cleanup(tmpDir));
    const git = initIgnoreRepo(tmpDir, { [TRACKED_IGNORED]: '# design\n' });
    fs.unlinkSync(path.join(tmpDir, TRACKED_IGNORED));
    fs.mkdirSync(path.join(tmpDir, 'gsd-core'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'gsd-core', 'cite.md'), `${citation}\n`);
    if (touchGitignore) fs.appendFileSync(path.join(tmpDir, '.gitignore'), '40-design.md\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'pr changes');
    const scriptCopy = copyScriptInto(tmpDir);
    return runNode(
      [scriptCopy],
      { cwd: tmpDir, env: { ...process.env, GSD_REMOVED_BUT_NEEDED_BASE: 'main' } },
    );
  }

  test('exit 0: a bare-basename citation of a deleted gitignored path is not attributed to it', (t) => {
    const result = runScenario(t, 'gsd-rbn-e2e-bare-', 'see 40-design.md for the local design', false);
    assert.equal(result.exitCode, 0, `expected exit 0, got ${result.exitCode}: ${result.stderr}`);
    // exit 0 is also the skip path ("could not resolve <base>, skipping")
    assert.match(result.stdout, /ok lint-removed-but-needed/);
    assert.doesNotMatch(result.stdout, /skipping/);
  });

  test('exit 1: the full deleted path is still caught', (t) => {
    const result = runScenario(t, 'gsd-rbn-e2e-full-', `see ${TRACKED_IGNORED} for the design`, false);
    assert.equal(result.exitCode, 1, `expected exit 1, got ${result.exitCode}: ${result.stderr}`);
    assert.match(result.stderr, /deleted, but still referenced/);
    assert.match(result.stderr, /gitignored/);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /skipping/);
  });

  test('exit 1: a PR that also edits .gitignore cannot disable the basename check', (t) => {
    const result = runScenario(t, 'gsd-rbn-e2e-touched-', 'see 40-design.md for the local design', true);
    assert.equal(result.exitCode, 1, `expected exit 1, got ${result.exitCode}: ${result.stderr}`);
    assert.match(result.stderr, /deleted, but still referenced/);
    assert.match(result.stderr, /basename '40-design\.md' still referenced/);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /skipping/);
  });
});
