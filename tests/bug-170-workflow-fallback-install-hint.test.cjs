'use strict';
// allow-test-rule: workflow markdown is shipped product text; this test validates fallback hint literals across all workflow files

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WORKFLOWS_DIR = path.join(__dirname, '..', 'get-shit-done', 'workflows');
const LEGACY_HINT = 'npx get-shit-done-cc@latest --claude --local';
const CURRENT_HINT = 'npx -y @opengsd/get-shit-done-redux@latest --claude --local';

function findMarkdownFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findMarkdownFiles(full));
    else if (entry.isFile() && full.endsWith('.md')) out.push(full);
  }
  return out;
}

test('bug #170: workflow fallback hints do not reference get-shit-done-cc', () => {
  const files = findMarkdownFiles(WORKFLOWS_DIR);
  let legacyCount = 0;
  let currentCount = 0;

  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    if (src.includes(LEGACY_HINT)) legacyCount += 1;
    if (src.includes(CURRENT_HINT)) currentCount += 1;
  }

  assert.equal(
    legacyCount,
    0,
    `workflow fallback hints must not reference legacy package (${LEGACY_HINT})`
  );
  assert.ok(
    currentCount > 0,
    `expected at least one workflow fallback hint to use current package (${CURRENT_HINT})`
  );
});
