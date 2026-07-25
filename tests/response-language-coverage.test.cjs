'use strict';

const { afterEach, describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cleanup } = require('./helpers.cjs');

const {
  findMarkdownFilesRecursive,
  findViolations,
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
      'nested/modes/uncovered.md',
    ]);
  });

  test('reports an uncovered nested workflow while accepting both coverage forms', () => {
    const root = fixture();
    const violations = findViolations(root)
      .map((file) => path.relative(root, file).replaceAll(path.sep, '/'));

    assert.deepStrictEqual(violations, ['nested/modes/uncovered.md']);
  });
});
