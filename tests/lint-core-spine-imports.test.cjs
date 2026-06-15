'use strict';
process.env.GSD_TEST_MODE = '1';

/**
 * Tests for scripts/lint-core-spine-imports.cjs (issue #1268).
 *
 * Behavioural, no source-grep. Asserts on structured return values from the
 * exported pure functions and on process exit codes from the CLI.
 */

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { createTempDir, cleanup } = require('./helpers.cjs');

const ROOT = path.join(__dirname, '..');
const SCRIPT_PATH = path.join(ROOT, 'scripts', 'lint-core-spine-imports.cjs');
const ALLOWLIST_PATH = path.join(ROOT, 'scripts', 'lint-core-spine-imports.allowlist.json');

const { scanCoreSpineImports, loadAllowlist } = require(SCRIPT_PATH);

// ---------------------------------------------------------------------------
// Pure-function tests
// ---------------------------------------------------------------------------

describe('lint-core-spine-imports: scanCoreSpineImports (pure)', () => {
  let tmpDir;

  afterEach(() => {
    cleanup(tmpDir);
    tmpDir = undefined;
  });

  test('happy path: allowlisted importer is not a violation', () => {
    tmpDir = createTempDir('lint-spine-test-');

    // File that imports the core spine
    const importerPath = path.join(tmpDir, 'importer.cts');
    fs.writeFileSync(importerPath, [
      "import core = require('./core.cjs');",
      'export = { x: 1 };',
    ].join('\n'), 'utf8');

    // File that does NOT import the core spine
    const cleanPath = path.join(tmpDir, 'clean.cts');
    fs.writeFileSync(cleanPath, [
      "import io = require('./io.cjs');",
      'export = { y: 2 };',
    ].join('\n'), 'utf8');

    // Allowlist contains the importer's repo-relative path
    const importerRel = path.relative(ROOT, importerPath).replace(/\\/g, '/');
    const allowlistSet = new Set([importerRel]);

    const violations = scanCoreSpineImports([tmpDir], allowlistSet);
    assert.deepEqual(violations, []);
  });

  test('violation path: non-allowlisted importer is returned with correct file and 1-based line', () => {
    tmpDir = createTempDir('lint-spine-test-');

    // File with a blank first line, then the core import on line 2
    const importerPath = path.join(tmpDir, 'new-squatter.cts');
    fs.writeFileSync(importerPath, [
      '// a comment',
      "import core = require('./core.cjs');",
      'export = {};',
    ].join('\n'), 'utf8');

    // Empty allowlist — importer is NOT allowed
    const violations = scanCoreSpineImports([tmpDir], new Set());

    assert.equal(violations.length, 1, 'expected exactly one violation');
    const v = violations[0];
    // File path is repo-relative POSIX
    const expectedRel = path.relative(ROOT, importerPath).replace(/\\/g, '/');
    assert.equal(v.file, expectedRel);
    // Line 2 (1-based): the second line contains the require
    assert.equal(v.line, 2);
  });

  test('require("../lib/core.cjs") form is detected', () => {
    tmpDir = createTempDir('lint-spine-test-');

    const f = path.join(tmpDir, 'leaf.cjs');
    fs.writeFileSync(f, 'const core = require("../lib/core.cjs");\n', 'utf8');

    const violations = scanCoreSpineImports([tmpDir], new Set());
    assert.equal(violations.length, 1);
    assert.equal(violations[0].line, 1);
  });

  test('require("./lib/core.cjs") form is detected', () => {
    tmpDir = createTempDir('lint-spine-test-');

    const f = path.join(tmpDir, 'leaf.cjs');
    fs.writeFileSync(f, 'const core = require("./lib/core.cjs");\n', 'utf8');

    const violations = scanCoreSpineImports([tmpDir], new Set());
    assert.equal(violations.length, 1);
  });

  test('clean file (no spine import) is never a violation', () => {
    tmpDir = createTempDir('lint-spine-test-');

    const f = path.join(tmpDir, 'pure.cts');
    fs.writeFileSync(f, [
      "import io = require('./io.cjs');",
      "import roadmap = require('./roadmap-parser.cjs');",
    ].join('\n'), 'utf8');

    const violations = scanCoreSpineImports([tmpDir], new Set());
    assert.deepEqual(violations, []);
  });

  test('commented-out core require is NOT a violation', () => {
    tmpDir = createTempDir('lint-spine-test-');

    const f = path.join(tmpDir, 'commented.cts');
    fs.writeFileSync(f, [
      "// import core = require('./core.cjs');",
      "// const core = require('../lib/core.cjs');",
      "import io = require('./io.cjs');",
    ].join('\n'), 'utf8');

    const violations = scanCoreSpineImports([tmpDir], new Set());
    assert.deepEqual(violations, [], 'commented-out requires should not count as violations');
  });

  test('unconventional relative path ../lib/core.cjs IS detected', () => {
    tmpDir = createTempDir('lint-spine-test-');

    const f = path.join(tmpDir, 'deep-leaf.cjs');
    fs.writeFileSync(f, "const core = require('../lib/core.cjs');\n", 'utf8');

    const violations = scanCoreSpineImports([tmpDir], new Set());
    assert.equal(violations.length, 1, 'expected exactly one violation for ../lib/core.cjs');
    assert.equal(violations[0].line, 1);
  });

  test('core-utils.cjs and core-schema.cjs are NOT detected as core spine imports', () => {
    tmpDir = createTempDir('lint-spine-test-');

    const f = path.join(tmpDir, 'sibling.cts');
    fs.writeFileSync(f, [
      "import coreUtils = require('./core-utils.cjs');",
      "import coreSchema = require('./core-schema.cjs');",
    ].join('\n'), 'utf8');

    const violations = scanCoreSpineImports([tmpDir], new Set());
    assert.deepEqual(violations, [], 'core-utils.cjs and core-schema.cjs should not match');
  });

  test('dynamic import("./core.cjs") form is detected', () => {
    tmpDir = createTempDir('lint-spine-test-');

    const f = path.join(tmpDir, 'dyn-importer.cjs');
    fs.writeFileSync(f, [
      '// dynamic import form',
      "const core = await import('./core.cjs');",
    ].join('\n'), 'utf8');

    const violations = scanCoreSpineImports([tmpDir], new Set());
    assert.equal(violations.length, 1, 'expected exactly one violation for dynamic import');
    assert.equal(violations[0].line, 2);
  });

  test('bare side-effect import \'./core.cjs\' form is detected', () => {
    tmpDir = createTempDir('lint-spine-test-');

    const f = path.join(tmpDir, 'side-effect-importer.cjs');
    fs.writeFileSync(f, [
      '// bare side-effect import form',
      "import './core.cjs';",
    ].join('\n'), 'utf8');

    const violations = scanCoreSpineImports([tmpDir], new Set());
    assert.equal(violations.length, 1, 'expected exactly one violation for bare side-effect import');
    assert.equal(violations[0].line, 2);
  });

  test('TS import x = require("./core.cjs") form is still flagged', () => {
    tmpDir = createTempDir('lint-spine-test-');

    const f = path.join(tmpDir, 'ts-require.cts');
    fs.writeFileSync(f, "import core = require('./core.cjs');\n", 'utf8');

    const violations = scanCoreSpineImports([tmpDir], new Set());
    assert.equal(violations.length, 1, 'TS import = require() should still be flagged');
    assert.equal(violations[0].line, 1);
  });

  test('import of core-utils.cjs (sibling) is NOT flagged even with new alternations', () => {
    tmpDir = createTempDir('lint-spine-test-');

    const f = path.join(tmpDir, 'sibling-check.cjs');
    fs.writeFileSync(f, [
      "const u = require('./core-utils.cjs');",
      "const cu = await import('./core-utils.cjs');",
      "import './core-utils.cjs';",
    ].join('\n'), 'utf8');

    const violations = scanCoreSpineImports([tmpDir], new Set());
    assert.deepEqual(violations, [], 'core-utils.cjs imports should not match even with new alternations');
  });
});

// ---------------------------------------------------------------------------
// loadAllowlist
// ---------------------------------------------------------------------------

describe('lint-core-spine-imports: loadAllowlist', () => {
  let tmpDir;

  afterEach(() => {
    cleanup(tmpDir);
    tmpDir = undefined;
  });

  test('returns a Set of the allow entries', () => {
    tmpDir = createTempDir('lint-spine-al-');
    const jsonPath = path.join(tmpDir, 'allowlist.json');
    fs.writeFileSync(jsonPath, JSON.stringify({ allow: ['src/foo.cts', 'src/bar.cts'] }), 'utf8');

    const s = loadAllowlist(jsonPath);
    assert.ok(s instanceof Set);
    assert.ok(s.has('src/foo.cts'));
    assert.ok(s.has('src/bar.cts'));
    assert.equal(s.size, 2);
  });
});

// ---------------------------------------------------------------------------
// T0-green / allowlist-completeness guard (real repo)
// ---------------------------------------------------------------------------

describe('lint-core-spine-imports: T0 allowlist covers all current importers', () => {
  test('scanCoreSpineImports against real src/ + gsd-core/bin/ returns [] with the shipped allowlist', () => {
    const roots = [
      path.join(ROOT, 'src'),
      path.join(ROOT, 'gsd-core', 'bin'),
    ];
    const allowlistSet = loadAllowlist(ALLOWLIST_PATH);
    const violations = scanCoreSpineImports(roots, allowlistSet);

    assert.deepEqual(
      violations,
      [],
      'T0 allowlist is incomplete — new core-spine importers detected:\n' +
        violations.map((v) => `  ${v.file}:${v.line}`).join('\n'),
    );
  });
});

// ---------------------------------------------------------------------------
// CLI contract
// ---------------------------------------------------------------------------

describe('lint-core-spine-imports: CLI', () => {
  test('clean repo → exit 0 and stdout contains the structured ok line', () => {
    const result = spawnSync(process.execPath, [SCRIPT_PATH], {
      cwd: ROOT,
      encoding: 'utf8',
    });

    assert.equal(
      result.status,
      0,
      `expected exit 0 but got ${result.status}.\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );
    assert.ok(
      result.stdout.includes('ok core-spine-imports:'),
      `stdout should contain "ok core-spine-imports:", got: ${result.stdout}`,
    );
  });
});
