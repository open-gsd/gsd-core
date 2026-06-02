// allow-test-rule: source-text-is-the-product
// agents/gsd-roadmapper.md is the installed agent — the Granularity Calibration
// table IS the deployed instruction. Asserting on its text asserts what runs in
// production. Locks the tightened phase-count buckets from #163.
'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const AGENTS_DIR = path.join(__dirname, '..', 'agents');

function readAgent(name) {
  return fs.readFileSync(path.join(AGENTS_DIR, `${name}.md`), 'utf8');
}

// Extract the "## Granularity Calibration" section (up to the next "## " heading)
// so number-range assertions are scoped and cannot be satisfied by unrelated text
// elsewhere in the agent file.
function granularitySection(content) {
  const start = content.indexOf('## Granularity Calibration');
  assert.ok(start !== -1, 'Granularity Calibration section must exist');
  const rest = content.slice(start + '## Granularity Calibration'.length);
  const nextHeading = rest.indexOf('\n## ');
  return nextHeading === -1 ? rest : rest.slice(0, nextHeading);
}

describe('gsd-roadmapper granularity calibration (#163)', () => {
  const section = granularitySection(readAgent('gsd-roadmapper'));

  test('Coarse bucket is tightened to 2-4', () => {
    assert.ok(/\|\s*Coarse\s*\|\s*2-4\s*\|/.test(section), 'Coarse must be 2-4');
  });

  test('Standard bucket is tightened to 4-6', () => {
    assert.ok(/\|\s*Standard\s*\|\s*4-6\b/.test(section), 'Standard must be 4-6');
  });

  test('Fine bucket is tightened to 6-10', () => {
    assert.ok(/\|\s*Fine\s*\|\s*6-10\s*\|/.test(section), 'Fine must be 6-10');
  });

  test('no granularity row maps to an old bucket (3-5 / 5-8 / 8-12)', () => {
    // Scope to the second ("Typical Phases") column of each row so the approved
    // explanatory footnote mentioning "5-8" in the third column does not false-fail.
    assert.ok(!/\|\s*Coarse\s*\|\s*3-5\b/.test(section), 'Coarse must not map to 3-5');
    assert.ok(!/\|\s*Standard\s*\|\s*5-8\b/.test(section), 'Standard must not map to 5-8');
    assert.ok(!/\|\s*Fine\s*\|\s*8-12\b/.test(section), 'Fine must not map to 8-12');
  });

  test('Key paragraph names the thin-phase pattern and prefers folding into a neighbor', () => {
    assert.ok(
      section.includes('fold it into the most-related neighbor'),
      'Key guidance must instruct folding thin phases into the most-related neighbor'
    );
  });
});
