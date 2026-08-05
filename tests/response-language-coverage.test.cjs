'use strict';

const { afterEach, describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cleanup } = require('./helpers.cjs');

const {
  EXACT_INLINE_DIRECTIVE_WORKFLOWS,
  INLINE_RESPONSE_LANGUAGE_DIRECTIVE,
  PARENT_INJECTED_WORKFLOWS,
  WORKFLOWS_DIR,
  findMarkdownFilesRecursive,
  findViolations,
  hasResponseLanguageCoverage,
  inheritsParentCoverage,
  main,
} = require('../scripts/lint-response-language-coverage.cjs');

describe('response-language workflow coverage lint (#2529)', () => {
  const tempDirs = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) cleanup(dir);
  });

  function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-response-language-'));
    tempDirs.push(root);
    fs.mkdirSync(path.join(root, 'nested', 'modes'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'covered-by-reference.md'),
      '@~/.claude/gsd-core/references/response-language-directive.md\n',
    );
    fs.writeFileSync(
      path.join(root, 'nested', 'covered-inline.md'),
      'Use config.response_language for all prose.\n',
    );
    fs.writeFileSync(
      path.join(root, 'nested', 'mere-field-mention.md'),
      'Parse JSON for: phase_number, response_language.\n',
    );
    fs.writeFileSync(path.join(root, 'nested', 'modes', 'uncovered.md'), '# English-only mode\n');
    fs.writeFileSync(path.join(root, 'nested', 'ignored.txt'), 'not a workflow');
    return root;
  }

  test('walks nested workflow directories recursively and ignores non-Markdown files', () => {
    const root = fixture();
    const relative = findMarkdownFilesRecursive(root)
      .map((file) => path.relative(root, file).replaceAll(path.sep, '/'));

    assert.deepStrictEqual(relative, [
      'covered-by-reference.md',
      'nested/covered-inline.md',
      'nested/mere-field-mention.md',
      'nested/modes/uncovered.md',
    ]);
  });

  test('reports an uncovered nested workflow while accepting both coverage forms', () => {
    const root = fixture();
    const violations = findViolations(root)
      .map((file) => path.relative(root, file).replaceAll(path.sep, '/'));

    assert.deepStrictEqual(violations, [
      'nested/mere-field-mention.md',
      'nested/modes/uncovered.md',
    ]);
  });

  test('accepts verify-phase only through its documented parent-injected contract', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-response-language-parent-'));
    tempDirs.push(root);
    fs.writeFileSync(path.join(root, 'verify-phase.md'), '# Loaded by execute-phase\n');
    fs.writeFileSync(
      path.join(root, 'execute-phase.md'),
      'Use response_language {response_language} for all user-facing prose; preserve code and paths.\n',
    );
    fs.writeFileSync(path.join(root, 'ordinary.md'), '# No directive\n');

    assert.deepStrictEqual(
      findViolations(root).map((file) => path.basename(file)),
      ['ordinary.md'],
    );

    fs.writeFileSync(path.join(root, 'execute-phase.md'), '# Injection removed\n');
    assert.deepStrictEqual(
      findViolations(root).map((file) => path.basename(file)),
      ['execute-phase.md', 'ordinary.md', 'verify-phase.md'],
    );
  });

  test('pins every shared inline directive site to one exact canonical line', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-response-language-parity-'));
    tempDirs.push(root);
    for (const relative of EXACT_INLINE_DIRECTIVE_WORKFLOWS) {
      const file = path.join(root, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${INLINE_RESPONSE_LANGUAGE_DIRECTIVE}\n`);
    }

    assert.strictEqual(EXACT_INLINE_DIRECTIVE_WORKFLOWS.size, 35);
    assert.deepStrictEqual(findViolations(root), []);

    const drifted = path.join(root, 'discuss-phase', 'modes', 'advisor.md');
    fs.writeFileSync(
      drifted,
      'Apply response_language to all user-facing prose; preserve code and paths.\n',
    );
    assert.deepStrictEqual(findViolations(root), [drifted]);
  });

  // #1671 keeps extracting workflow prose into fragments. A fragment carries no
  // directive of its own, so without inheritance every extraction reds this lint
  // for prose that was already covered where it used to live.
  function fragmentFixture({ parentCovered = true, parentNamesFragment = true } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-response-language-fragment-'));
    tempDirs.push(root);
    fs.mkdirSync(path.join(root, 'autonomous', 'steps'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'autonomous.md'),
      [
        parentCovered
          ? '@~/.claude/gsd-core/references/response-language-directive.md'
          : '# No directive here',
        parentNamesFragment
          ? 'read and execute `gsd-core/workflows/autonomous/steps/converge-banner.md`'
          : 'read and execute `gsd-core/workflows/autonomous/steps/something-else.md`',
      ].join('\n') + '\n',
    );
    fs.writeFileSync(
      path.join(root, 'autonomous', 'steps', 'converge-banner.md'),
      'Display: `Planning: convergence enabled`\n',
    );
    return root;
  }

  test('a fragment inherits coverage from the parent that names it', () => {
    const root = fragmentFixture();

    assert.strictEqual(
      inheritsParentCoverage(root, 'autonomous/steps/converge-banner.md'),
      true,
    );
    assert.deepStrictEqual(findViolations(root), []);
  });

  test('inheritance is refused when the parent is uncovered or does not name the fragment', () => {
    const uncoveredParent = fragmentFixture({ parentCovered: false });
    assert.deepStrictEqual(
      findViolations(uncoveredParent).map((file) => path.relative(uncoveredParent, file).replaceAll(path.sep, '/')),
      ['autonomous.md', 'autonomous/steps/converge-banner.md'],
    );

    const unreferenced = fragmentFixture({ parentNamesFragment: false });
    assert.deepStrictEqual(
      findViolations(unreferenced).map((file) => path.relative(unreferenced, file).replaceAll(path.sep, '/')),
      ['autonomous/steps/converge-banner.md'],
    );
  });

  test('inheritance reaches fragment directories only, never a nested workflow tree', () => {
    const root = fragmentFixture();
    // Depth and directory name are both load-bearing: a two-segment path has no
    // parent workflow, and a directory outside the fragment set is not a section.
    assert.strictEqual(inheritsParentCoverage(root, 'autonomous.md'), false);
    assert.strictEqual(
      inheritsParentCoverage(root, 'autonomous/steps/nested/converge-banner.md'),
      false,
    );
    assert.strictEqual(
      inheritsParentCoverage(root, 'autonomous/references/converge-banner.md'),
      false,
    );
  });

  test('rejects a bare config mention and accepts an actionable inline directive', () => {
    assert.strictEqual(hasResponseLanguageCoverage('response_language\n'), false);
    assert.strictEqual(
      hasResponseLanguageCoverage('Apply response_language to all user-facing prose.\n'),
      true,
    );
  });

  test('main returns a failure code and reports each violation', () => {
    const root = fixture();
    const errors = [];
    const logs = [];
    const exitCode = main(root, {
      error: (message) => errors.push(message),
      log: (message) => logs.push(message),
    });

    assert.strictEqual(exitCode, 1);
    assert.strictEqual(logs.length, 0);
    assert.match(errors[0], /2 workflow\(s\) have no response-language coverage/);
    assert.match(errors[0], /nested\/mere-field-mention\.md/);
    assert.match(errors[0], /nested\/modes\/uncovered\.md/);
  });

  test('main returns success and emits the covered workflow count', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-response-language-ok-'));
    tempDirs.push(root);
    fs.writeFileSync(
      path.join(root, 'covered.md'),
      'Apply response_language to all user-facing prose.\n',
    );
    const errors = [];
    const logs = [];

    assert.strictEqual(main(root, {
      error: (message) => errors.push(message),
      log: (message) => logs.push(message),
    }), 0);
    assert.deepStrictEqual(errors, []);
    assert.deepStrictEqual(logs, [
      'lint-response-language-coverage: OK (1 workflows covered)',
    ]);
  });

  test('main fails instead of passing vacuously when discovery finds no workflow', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-response-language-empty-'));
    tempDirs.push(root);
    fs.mkdirSync(path.join(root, 'not-a-workflow'), { recursive: true });
    fs.writeFileSync(path.join(root, 'not-a-workflow', 'notes.txt'), 'not Markdown');
    const errors = [];
    const logs = [];

    assert.strictEqual(main(root, {
      error: (message) => errors.push(message),
      log: (message) => logs.push(message),
    }), 1);
    assert.deepStrictEqual(logs, []);
    assert.match(errors[0], /no workflow files found/);
  });

  test('main fails closed on an unreadable workflow directory rather than throwing', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-response-language-absent-'));
    tempDirs.push(root);
    fs.writeFileSync(path.join(root, 'file-not-dir.md'), 'Apply response_language to all prose.\n');
    const errors = [];
    const logs = [];
    const io = {
      error: (message) => errors.push(message),
      log: (message) => logs.push(message),
    };

    assert.strictEqual(main(path.join(root, 'does-not-exist'), io), 1);
    assert.match(errors[0], /cannot read the workflow directory/);
    assert.match(errors[0], /ENOENT/);

    assert.strictEqual(main(path.join(root, 'file-not-dir.md'), io), 1);
    assert.match(errors[1], /cannot read the workflow directory/);
    assert.deepStrictEqual(logs, []);
  });

  test('every pinned workflow path is live in the real catalog', () => {
    // The pinned sets are enforced by exact path. A rename that leaves a stale
    // entry behind does not fail the lint — the moved file quietly falls back
    // to the loose coverage check, so the exact-line pin stops being enforced
    // without anything going red. Assert the pins still resolve.
    const discovered = new Set(
      findMarkdownFilesRecursive(WORKFLOWS_DIR)
        .map((file) => path.relative(WORKFLOWS_DIR, file).replaceAll(path.sep, '/')),
    );
    const pinned = [
      ...EXACT_INLINE_DIRECTIVE_WORKFLOWS,
      ...PARENT_INJECTED_WORKFLOWS.keys(),
      ...[...PARENT_INJECTED_WORKFLOWS.values()].map((injection) => injection.parent),
    ].sort();

    assert.deepStrictEqual(pinned.filter((relative) => !discovered.has(relative)), []);
  });
});
