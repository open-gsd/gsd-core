// allow-test-rule: source-text-is-the-product
// The GitHub Actions YAML is the deployed runtime contract. These tests assert
// on the parsed matrix structure to lock the Windows smoke gate without testing
// GHA execution semantics.

'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WORKFLOW_PATH = path.join(__dirname, '..', '.github', 'workflows', 'install-smoke.yml');

/**
 * Minimal structural extractor for the matrix.include section.
 * Parses the `jobs.smoke.strategy.matrix.include` entries from the YAML
 * by scanning indented list entries. Returns an array of objects like:
 *   { os: string, 'node-version': number, full_only: boolean }
 *
 * Strategy: scan for the `include:` key inside the matrix block and collect
 * consecutive `- os:` / `node-version:` / `full_only:` items. This is a
 * targeted structural parse — not source-grep — because we assert on the
 * parsed IR fields, not on byte offsets or string literals in the file.
 *
 * Actual indentation in install-smoke.yml:
 *   strategy:          (4 spaces)
 *     matrix:          (6 spaces)
 *       include:       (8 spaces)
 *         - os: ...    (10 spaces, with `- ` prefix)
 *           node-version: ... (12 spaces)
 *           full_only: ...    (12 spaces)
 */
function parseMatrixIncludes(src) {
  const lines = src.split('\n');
  const entries = [];
  let inMatrix = false;
  let inInclude = false;
  let current = null;

  for (const line of lines) {
    // Detect the matrix: block (6-space indent inside strategy:)
    if (/^      matrix:/.test(line)) {
      inMatrix = true;
      continue;
    }
    // Detect the include: key inside matrix (8-space indent)
    if (inMatrix && /^        include:/.test(line)) {
      inInclude = true;
      continue;
    }
    // End of include block: another key at 8-space indent that is not a list item
    if (inInclude && /^        [a-zA-Z]/.test(line) && !/^        - /.test(line)) {
      inInclude = false;
      if (current) { entries.push(current); current = null; }
      continue;
    }
    // End of matrix block: de-indent back to strategy or job level
    if (inMatrix && /^      [a-zA-Z]/.test(line) && !/^        /.test(line)) {
      inMatrix = false;
      inInclude = false;
      if (current) { entries.push(current); current = null; }
      continue;
    }

    if (inInclude) {
      // New entry starts with `        - os:` (10 spaces: 8 indent + `- `)
      const newEntry = line.match(/^          - os:\s+(.+)/);
      if (newEntry) {
        if (current) entries.push(current);
        current = { os: newEntry[1].trim() };
        continue;
      }
      // `node-version:` field of current entry (12-space indent)
      const nvMatch = line.match(/^            node-version:\s+(.+)/);
      if (nvMatch && current) {
        current['node-version'] = Number(nvMatch[1].trim());
        continue;
      }
      // `full_only:` field of current entry (12-space indent)
      const foMatch = line.match(/^            full_only:\s+(.+)/);
      if (foMatch && current) {
        current.full_only = foMatch[1].trim() === 'true';
        continue;
      }
    }
  }
  // Flush final entry
  if (current) entries.push(current);

  return entries;
}

describe('bug-428: install-smoke matrix must include windows-latest', () => {
  const src = fs.readFileSync(WORKFLOW_PATH, 'utf-8');
  const includes = parseMatrixIncludes(src);

  test('matrix.include parses at least one entry (parser sanity check)', () => {
    assert.ok(
      includes.length > 0,
      `Expected matrix.include to have entries but got 0. ` +
      `Check that parseMatrixIncludes targets the correct indent level.`
    );
  });

  test('matrix includes a windows-latest entry with Node 24', () => {
    const windowsEntry = includes.find(
      e => e.os === 'windows-latest' && e['node-version'] === 24
    );
    assert.ok(
      windowsEntry !== undefined,
      `Expected a matrix entry with os='windows-latest' and node-version=24 but none found. ` +
      `Current entries: ${JSON.stringify(includes, null, 2)}`
    );
  });

  test('windows-latest entry has full_only: true (so PR-minimal runs skip it)', () => {
    const windowsEntry = includes.find(
      e => e.os === 'windows-latest' && e['node-version'] === 24
    );
    // This test only runs meaningfully if the previous test passed.
    // If no windows entry exists, provide a helpful message.
    if (!windowsEntry) {
      assert.fail(
        `No windows-latest × Node 24 entry found in matrix. ` +
        `Cannot assert full_only. Entries: ${JSON.stringify(includes)}`
      );
    }
    assert.strictEqual(
      windowsEntry.full_only,
      true,
      `Expected windows-latest entry to have full_only: true so it is skipped on PR triggers. ` +
      `Got: ${JSON.stringify(windowsEntry)}`
    );
  });
});
