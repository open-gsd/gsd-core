// allow-test-rule: docs-parity
// Verifies that issue #22 drift-guard surfacing changes are present:
//   - new-project workflow mentions plan_review.source_grounding
//   - CONFIGURATION.md documents both new config keys
//   - COMMANDS.md mentions gsd-tools intel api-surface

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

const NEW_PROJECT_PATH = path.join(ROOT, 'gsd-core', 'workflows', 'new-project.md');
const SETTINGS_PATH = path.join(ROOT, 'gsd-core', 'workflows', 'settings.md');
const CONFIGURATION_PATH = path.join(ROOT, 'docs', 'CONFIGURATION.md');
const COMMANDS_PATH = path.join(ROOT, 'docs', 'COMMANDS.md');
const USER_GUIDE_PATH = path.join(ROOT, 'docs', 'USER-GUIDE.md');
const ARCHITECTURE_PATH = path.join(ROOT, 'docs', 'ARCHITECTURE.md');

describe('feat-22-surfacing-docs', () => {
  // ── A1: new-project workflow ─────────────────────────────────────────────

  test('new-project workflow mentions source_grounding', () => {
    const content = fs.readFileSync(NEW_PROJECT_PATH, 'utf-8');
    assert.ok(
      content.includes('source_grounding'),
      'new-project.md must mention source_grounding'
    );
  });

  test('new-project workflow has Drift Guard question', () => {
    const content = fs.readFileSync(NEW_PROJECT_PATH, 'utf-8');
    assert.ok(
      content.includes('Drift Guard'),
      'new-project.md must include a "Drift Guard" question header'
    );
  });

  test('new-project workflow wires source_grounding into config-new-project call', () => {
    const content = fs.readFileSync(NEW_PROJECT_PATH, 'utf-8');
    assert.ok(
      content.includes('"plan_review":{"source_grounding":'),
      'new-project.md config-new-project call must include plan_review.source_grounding'
    );
  });

  test('new-project workflow has Drift Guard default-yes option', () => {
    const content = fs.readFileSync(NEW_PROJECT_PATH, 'utf-8');
    // Both question blocks (auto and interactive) should have the yes option
    const count = (content.match(/Yes \(Recommended\).*catches hallucinated names/g) || []).length;
    assert.ok(
      count >= 1,
      'new-project.md must have at least one Drift Guard "Yes (Recommended)" option'
    );
  });

  // ── A2: settings workflow ────────────────────────────────────────────────

  test('settings workflow mentions source_grounding in read_current step', () => {
    const content = fs.readFileSync(SETTINGS_PATH, 'utf-8');
    assert.ok(
      content.includes('plan_review.source_grounding'),
      'settings.md must mention plan_review.source_grounding in the read_current step'
    );
  });

  test('settings workflow has Drift Guard AskUserQuestion toggle', () => {
    const content = fs.readFileSync(SETTINGS_PATH, 'utf-8');
    assert.ok(
      content.includes('Drift Guard'),
      'settings.md must include a "Drift Guard" question header'
    );
  });

  test('settings workflow update_config includes plan_review.source_grounding', () => {
    const content = fs.readFileSync(SETTINGS_PATH, 'utf-8');
    assert.ok(
      content.includes('"source_grounding": true/false'),
      'settings.md update_config block must include source_grounding: true/false'
    );
  });

  test('settings workflow mentions source_grounding_authority', () => {
    const content = fs.readFileSync(SETTINGS_PATH, 'utf-8');
    assert.ok(
      content.includes('source_grounding_authority'),
      'settings.md must mention source_grounding_authority'
    );
  });

  test('settings confirm table includes Plan Drift Guard row', () => {
    const content = fs.readFileSync(SETTINGS_PATH, 'utf-8');
    assert.ok(
      content.includes('Plan Drift Guard'),
      'settings.md confirm table must include a "Plan Drift Guard" row'
    );
  });

  // ── B1: CONFIGURATION.md ─────────────────────────────────────────────────

  test('CONFIGURATION.md documents plan_review.source_grounding', () => {
    const content = fs.readFileSync(CONFIGURATION_PATH, 'utf-8');
    assert.ok(
      content.includes('`plan_review.source_grounding`'),
      'CONFIGURATION.md must document plan_review.source_grounding'
    );
  });

  test('CONFIGURATION.md documents plan_review.source_grounding_authority', () => {
    const content = fs.readFileSync(CONFIGURATION_PATH, 'utf-8');
    assert.ok(
      content.includes('`plan_review.source_grounding_authority`'),
      'CONFIGURATION.md must document plan_review.source_grounding_authority'
    );
  });

  test('CONFIGURATION.md documents grep as default authority', () => {
    const content = fs.readFileSync(CONFIGURATION_PATH, 'utf-8');
    assert.ok(
      content.includes('`grep`') && content.includes('source_grounding_authority'),
      'CONFIGURATION.md must document grep as the default source_grounding_authority'
    );
  });

  test('CONFIGURATION.md lists all five authority enum values', () => {
    const content = fs.readFileSync(CONFIGURATION_PATH, 'utf-8');
    const authorities = ['grep', 'intel', 'treesitter', 'lsp', 'scip'];
    const missing = authorities.filter(a => !content.includes(a));
    assert.deepStrictEqual(
      missing,
      [],
      `CONFIGURATION.md must list all authority values; missing: ${missing.join(', ')}`
    );
  });

  // ── B2: COMMANDS.md ───────────────────────────────────────────────────────

  test('COMMANDS.md mentions intel api-surface', () => {
    const content = fs.readFileSync(COMMANDS_PATH, 'utf-8');
    assert.ok(
      content.includes('intel api-surface'),
      'COMMANDS.md must document the gsd-tools intel api-surface command'
    );
  });

  test('COMMANDS.md documents api-surface gating on intel.enabled', () => {
    const content = fs.readFileSync(COMMANDS_PATH, 'utf-8');
    assert.ok(
      content.includes('intel.enabled'),
      'COMMANDS.md intel api-surface section must mention the intel.enabled gate'
    );
  });

  test('COMMANDS.md mentions API-SURFACE.md output', () => {
    const content = fs.readFileSync(COMMANDS_PATH, 'utf-8');
    assert.ok(
      content.includes('API-SURFACE.md'),
      'COMMANDS.md must mention the API-SURFACE.md output file'
    );
  });

  // ── B3: USER-GUIDE.md ─────────────────────────────────────────────────────

  test('USER-GUIDE.md has Plan Drift Guard subsection', () => {
    const content = fs.readFileSync(USER_GUIDE_PATH, 'utf-8');
    assert.ok(
      content.includes('### Plan Drift Guard'),
      'USER-GUIDE.md must have a "### Plan Drift Guard" subsection'
    );
  });

  test('USER-GUIDE.md mentions needs-acknowledgement behavior', () => {
    const content = fs.readFileSync(USER_GUIDE_PATH, 'utf-8');
    assert.ok(
      content.includes('needs-acknowledgement'),
      'USER-GUIDE.md drift guard section must describe needs-acknowledgement behavior'
    );
  });

  test('USER-GUIDE.md explains drift guard works without intel', () => {
    const content = fs.readFileSync(USER_GUIDE_PATH, 'utf-8');
    assert.ok(
      content.includes('without intel') || content.includes('Works without intel'),
      'USER-GUIDE.md must explain that the drift guard works without intel'
    );
  });

  // ── B4: ARCHITECTURE.md ───────────────────────────────────────────────────

  test('ARCHITECTURE.md links to ADR 22', () => {
    const content = fs.readFileSync(ARCHITECTURE_PATH, 'utf-8');
    assert.ok(
      content.includes('adr/22-plan-drift-guard.md') || content.includes('ADR 22'),
      'ARCHITECTURE.md must link to ADR 22 (adr/22-plan-drift-guard.md)'
    );
  });
});
