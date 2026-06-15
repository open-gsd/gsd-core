// allow-test-rule: runtime-contract-is-the-product agent .md instruction surface see #1205
// agents/gsd-roadmapper.md is the deployed agent — the Granularity Calibration table
// AND the phase_id_convention instructions ARE the deployed behavior. Asserting on
// their prose asserts what runs in production (#163, #1205).
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

// Extract a named XML-tag block (e.g. <phase_identification>…</phase_identification>)
function extractBlock(content, tag) {
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  const start = content.indexOf(open);
  const end = content.indexOf(close);
  assert.ok(start !== -1, `<${tag}> block must exist in agent`);
  assert.ok(end !== -1, `</${tag}> must close the block`);
  return content.slice(start + open.length, end);
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

describe('gsd-roadmapper phase_id_convention support (#1205)', () => {
  const content = readAgent('gsd-roadmapper');

  test('phase_identification section reads phase_id_convention from config', () => {
    const section = extractBlock(content, 'phase_identification');
    assert.ok(
      section.includes('phase_id_convention'),
      'phase_identification block must reference phase_id_convention config key'
    );
  });

  test('output_formats documents milestone-prefixed header format', () => {
    const section = extractBlock(content, 'output_formats');
    assert.ok(
      section.includes('milestone-prefixed'),
      'output_formats block must document the milestone-prefixed convention'
    );
  });

  test('output_formats shows milestone-prefixed phase header example (e.g. ### Phase 1-01:)', () => {
    const section = extractBlock(content, 'output_formats');
    assert.ok(
      /###\s+Phase\s+\d+-\d{2}:/.test(section),
      'output_formats must show a milestone-prefixed header example like "### Phase 1-01: Name"'
    );
  });

  test('output_formats shows both sequential and milestone-prefixed summary checklist forms', () => {
    const section = extractBlock(content, 'output_formats');
    assert.ok(
      /- \[ \] \*\*Phase \d+:/.test(section),
      'output_formats must still show sequential summary checklist form "- [ ] **Phase N:"'
    );
    assert.ok(
      /- \[ \] \*\*Phase \d+-\d{2}:/.test(section),
      'output_formats must show milestone-prefixed checklist form "- [ ] **Phase N-NN:"'
    );
  });

  test('phase_identification section falls back to sequential when convention absent or "sequential"', () => {
    const section = extractBlock(content, 'phase_identification');
    assert.ok(
      section.includes('sequential'),
      'phase_identification block must document that sequential is the default/fallback'
    );
  });
});
