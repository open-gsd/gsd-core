'use strict';

// Regression guard for #1864 — settings-advanced.md had an orphan </step>
// (6 closes / 5 opens) because §8 Model Policy lacked an opening <step>.
// Asserts EVERY top-level workflow .md has balanced <step>/</step> tags so an
// unbalanced workflow can never land again. Fenced code blocks are stripped
// first so legitimate <step> examples inside ``` fences don't false-positive.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { stripFencedCode } = require('../gsd-core/bin/lib/markdown-sectionizer.cjs');

const WORKFLOWS_DIR = path.join(__dirname, '..', 'gsd-core', 'workflows');

function topLevelWorkflowFiles() {
  return fs.readdirSync(WORKFLOWS_DIR)
    .filter((f) => f.endsWith('.md'))
    .map((f) => path.join(WORKFLOWS_DIR, f));
}

function countTags(text, re) {
  // matchAll requires the global flag; force it so the iterator terminates.
  const flags = re.flags.includes('g') ? re.flags : re.flags + 'g';
  return [...text.matchAll(new RegExp(re.source, flags))].length;
}

describe('workflow <step> tag balance (#1864)', () => {
  test('every top-level workflow has equal <step> opens and </step> closes (code fences stripped)', () => {
    const offenders = [];
    for (const file of topLevelWorkflowFiles()) {
      const raw = fs.readFileSync(file, 'utf8');
      const stripped = stripFencedCode(raw).text;
      const opens = countTags(stripped, /<step(\s|>)/);
      const closes = countTags(stripped, /<\/step>/);
      if (opens !== closes) offenders.push(`${path.basename(file)}: ${opens} opens / ${closes} closes`);
    }
    assert.deepEqual(offenders, [], `unbalanced <step> tags:\n${offenders.join('\n')}`);
  });

  test('settings-advanced.md §8 Model Policy is wrapped in a model_policy step (#1864)', () => {
    const file = path.join(WORKFLOWS_DIR, 'settings-advanced.md');
    const raw = fs.readFileSync(file, 'utf8');
    const stripped = stripFencedCode(raw).text;
    assert.match(stripped, /<step name="model_policy">[\s\S]*?### Section 8 — Model Policy[\s\S]*?<\/step>/,
      '§8 must be wrapped in <step name="model_policy">…</step>');
  });
});
