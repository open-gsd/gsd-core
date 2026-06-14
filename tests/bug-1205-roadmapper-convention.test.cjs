// allow-test-rule: runtime-contract-is-the-product agent .md instruction surface
// agents/gsd-roadmapper.md is the deployed instruction. The phase-ID convention
// logic IS the production behavior — asserting on its prose asserts what runs.
'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const AGENT_PATH = path.join(__dirname, '..', 'agents', 'gsd-roadmapper.md');

function readAgent() {
  return fs.readFileSync(AGENT_PATH, 'utf8');
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

describe('gsd-roadmapper phase_id_convention support (#1205)', () => {
  const content = readAgent();

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
    // The milestone-prefixed format uses a milestone prefix + two-digit phase index
    // e.g. "### Phase 1-01: Name" or "### Phase M-NN: Name"
    assert.ok(
      /###\s+Phase\s+\d+-\d{2}:/.test(section),
      'output_formats must show a milestone-prefixed header example like "### Phase 1-01: Name"'
    );
  });

  test('output_formats shows both sequential and milestone-prefixed summary checklist forms', () => {
    const section = extractBlock(content, 'output_formats');
    // Sequential checklist still works unchanged
    assert.ok(
      /- \[ \] \*\*Phase \d+:/.test(section),
      'output_formats must still show sequential summary checklist form "- [ ] **Phase N:"'
    );
    // Milestone-prefixed checklist form
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
