// allow-test-rule: source-text-is-the-product
'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const RESEARCHER_PATH = path.join(REPO_ROOT, 'agents', 'gsd-phase-researcher.md');

function readResearcherPrompt() {
  return fs.readFileSync(RESEARCHER_PATH, 'utf8');
}

describe('bug #214: phase researcher must survive OpenCode write-tool truncation', () => {
  test('Step 6 documents the large-file / truncation fallback write contract', () => {
    const prompt = readResearcherPrompt();

    assert.match(
      prompt,
      /truncat/i,
      'Step 6 must name the truncation failure mode.'
    );
    assert.match(
      prompt,
      /incrementa/i,
      'Step 6 must instruct incremental construction on large files.'
    );
    assert.match(
      prompt,
      /<!-- gsd:write-continue -->/,
      'Step 6 must define the continuation sentinel for incremental writes.'
    );
    assert.match(
      prompt,
      /do NOT retry the same oversized call/i,
      'Step 6 must forbid identical retry of the oversized write (doom-loop guard).'
    );
    assert.match(
      prompt,
      /do NOT silently fall back to returning content/i,
      'Step 6 must forbid silent fallback to returning content.'
    );
    assert.match(
      prompt,
      /`Read` the file, then `Edit`/i,
      'Step 6 must require Read before Edit (OpenCode edit requires a prior Read).'
    );
    assert.match(
      prompt,
      /no trailing sentinel/i,
      'Step 6 must instruct removing the sentinel on the final section.'
    );
    assert.match(
      prompt,
      /write the whole file in a single `Write` call/i,
      'Step 6 must keep single-Write as the default path (no regression for non-truncating runtimes).'
    );
  });
});
