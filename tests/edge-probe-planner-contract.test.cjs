// allow-test-rule: source-text-is-the-product
// plan-phase.md is the deployed planning workflow contract; these checks lock
// the SPEC path wiring and quality-gate that the edge-probe review (RR-01/02/03)
// requires — assertions scope to extracted sub-blocks to avoid false positives.

'use strict';

process.env.GSD_TEST_MODE = '1';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PLAN_PHASE_PATH = path.join(__dirname, '..', 'gsd-core', 'workflows', 'plan-phase.md');
const PROMPT_PATH = path.join(__dirname, '..', 'gsd-core', 'templates', 'planner-subagent-prompt.md');

function readPlanPhase() {
  return fs.readFileSync(PLAN_PHASE_PATH, 'utf8');
}

function readPrompt() {
  return fs.readFileSync(PROMPT_PATH, 'utf8');
}

// Extract the planner <files_to_read> block that contains {UI_SPEC_PATH}
// There are multiple <files_to_read> blocks in plan-phase.md; we need the one
// at ~line 890-912 inside the planning_context markdown block.
function extractPlannerFilesBlock(content) {
  let pos = 0;
  while (true) {
    const start = content.indexOf('<files_to_read>', pos);
    if (start === -1) return '';
    const end = content.indexOf('</files_to_read>', start);
    if (end === -1) return '';
    const block = content.slice(start, end + '</files_to_read>'.length);
    if (block.includes('{UI_SPEC_PATH}')) {
      return block;
    }
    pos = end + 1;
  }
}

// Extract the planner <quality_gate> block (the last one in plan-phase.md,
// inside the planner prompt template)
function extractQualityGateBlock(content) {
  const start = content.lastIndexOf('<quality_gate>');
  if (start === -1) return '';
  const end = content.indexOf('</quality_gate>', start);
  if (end === -1) return '';
  return content.slice(start, end + '</quality_gate>'.length);
}

// Test A (RR-01): plan-phase.md resolves a phase *-SPEC.md into SPEC_FILE/SPEC_PATH
// Uses new RegExp to correctly match literal $ and ( characters in bash snippets.
// This MUST FAIL before the RR-01 fix (no SPEC_PATH resolution exists today)
test('RR-01: plan-phase.md resolves phase *-SPEC.md (excluding AI/UI variants) into SPEC_FILE/SPEC_PATH', () => {
  const content = readPlanPhase();

  // Assert the canonical SPEC_FILE resolution form is present.
  // new RegExp used so that \$ and \( are treated as literal dollar-sign and open-paren
  // (JS regex literals interpret \$ as end-anchor and \( as group open).
  assert.match(
    content,
    new RegExp('SPEC_FILE=\\$\\(ls "\\$\\{[A-Z_]*PHASE_DIR[A-Z_]*\\}"[/][*]-SPEC\\.md'),
    'plan-phase.md must resolve SPEC_FILE using ls "${...PHASE_DIR...}"/*-SPEC.md pattern'
  );

  // Assert {SPEC_PATH} token appears in the planner files_to_read block
  const filesBlock = extractPlannerFilesBlock(content);
  assert.match(
    filesBlock,
    /[{]SPEC_PATH[}]/,
    'The planner <files_to_read> block (containing {UI_SPEC_PATH}) must also contain {SPEC_PATH}'
  );
});

// Test B (RR-01): The {SPEC_PATH} entry is labelled as carrying the ## Edge Coverage section
// This MUST FAIL before the RR-01 fix (no {SPEC_PATH} entry exists today)
test('RR-01: {SPEC_PATH} entry in files_to_read is labelled with Edge Coverage', () => {
  const content = readPlanPhase();
  const filesBlock = extractPlannerFilesBlock(content);

  assert.match(
    filesBlock,
    /[{]SPEC_PATH[}][^\n]*Edge Coverage/,
    '{SPEC_PATH} entry in planner files_to_read must be labelled as carrying the ## Edge Coverage section'
  );
});

// Extract a "## " section from its heading until the next "## " heading (or EOF).
function extractSection(content, heading) {
  const start = content.indexOf(heading);
  if (start === -1) return '';
  const next = content.indexOf('\n## ', start + heading.length);
  return content.slice(start, next === -1 ? content.length : next);
}

// Test E (RR-01 REACHABILITY — the assertion that catches the original no-op):
// Token presence is not enough. The SPEC resolution must live on an UN-GATED path. §4.5
// "Check AI-SPEC" is skipped on every non-AI phase (ai_integration_phase_enabled false /
// --skip-ai-spec), so a resolution placed there leaves SPEC_PATH unbound and the planner
// never receives the SPEC — exactly the #550 silent no-op. Assert it is NOT in §4.5.
test('RR-01 reachability: SPEC_FILE resolution is NOT gated inside the skippable "## 4.5 Check AI-SPEC" section', () => {
  const content = readPlanPhase();
  const aiSpecSection = extractSection(content, '## 4.5. Check AI-SPEC');
  const specResolution = new RegExp('SPEC_FILE=\\$\\(ls "\\$\\{[A-Z_]*PHASE_DIR[A-Z_]*\\}"[/][*]-SPEC\\.md');
  assert.ok(aiSpecSection.length > 0, 'sanity: the §4.5 Check AI-SPEC section must exist to scope this test');
  assert.doesNotMatch(
    aiSpecSection,
    specResolution,
    'SPEC_FILE resolution must NOT live inside the skippable §4.5 "Check AI-SPEC" block — gating it there silently starves the planner of the SPEC on non-AI phases (the original #550 no-op)'
  );
  assert.match(content, specResolution, 'SPEC_FILE resolution must still exist on an un-gated path elsewhere in plan-phase.md');
});

// Test C (consumer end): planner-subagent-prompt.md lift instruction references ## Edge Coverage
// and must_haves.truths — guards that the consumer contract is intact
// This PASSES today and must continue to pass after the fix
test('RR-02 consumer: planner-subagent-prompt.md instructs lifting covered/backstop edges into must_haves.truths', () => {
  const content = readPrompt();

  assert.match(
    content,
    /##\s*Edge Coverage/,
    'planner-subagent-prompt.md must reference ## Edge Coverage'
  );
  assert.match(
    content,
    /must_haves\.truths/,
    'planner-subagent-prompt.md must reference must_haves.truths as the lift target'
  );
});

// Test D (RR-03): plan-phase.md <quality_gate> contains a covered/backstop ↔ must_haves item
// This MUST FAIL before the RR-03 fix (no such quality_gate item exists today)
test('RR-03: planner quality_gate requires covered/backstop edges represented in must_haves', () => {
  const content = readPlanPhase();
  const qgBlock = extractQualityGateBlock(content);

  assert.match(
    qgBlock,
    /covered.*backstop.*must_haves|backstop.*covered.*must_haves/i,
    'planner quality_gate must contain a checklist item tying covered/backstop edges to must_haves'
  );
});
