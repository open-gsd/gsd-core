// The workflow prose is the product (source-text-is-the-product): these tests deliberately
// pin the prose of the complete-milestone.md security_audit_reminder step by substring because
// the prose is exactly what the executing agent reads at runtime.
/**
 * Security-audit milestone-close reminder (#6222, slice 1)
 *
 * Covers:
 * - Config key registration and validation (workflow.security_audit_phase)
 * - Schema default (absent key resolves to false)
 * - Config template default (false)
 * - complete-milestone.md reminder step contract:
 *   - gated on workflow.security_audit_phase (silent when false)
 *   - tool-agnostic ("no audit tooling available", never fabricates results)
 *   - non-blocking and positioned before the close
 */

const { describe, test, beforeEach, afterEach, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

const GSD_ROOT = path.join(__dirname, '..', 'gsd-core');
const CONFIG_TEMPLATE_PATH = path.join(GSD_ROOT, 'templates', 'config.json');
const COMPLETE_MILESTONE_PATH = path.join(GSD_ROOT, 'workflows', 'complete-milestone.md');
const PLANNING_CONFIG_PATH = path.join(GSD_ROOT, 'references', 'planning-config.md');
const DOCS_CONFIG_PATH = path.join(__dirname, '..', 'docs', 'CONFIGURATION.md');

describe('security_audit_phase: config key registration and validation', () => {
  let tmpDir;
  beforeEach(() => {
    tmpDir = createTempProject();
  });
  afterEach(() => {
    cleanup(tmpDir);
  });

  test('config-set accepts workflow.security_audit_phase true and persists it', () => {
    const result = runGsdTools(['config-set', 'workflow.security_audit_phase', 'true'], tmpDir);
    assert.ok(result.success, `config-set should accept workflow.security_audit_phase: ${result.error}`);

    const configPath = path.join(tmpDir, '.planning', 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    assert.strictEqual(config.workflow?.security_audit_phase, true, 'value must be persisted');
  });

  test('config-set accepts workflow.security_audit_phase false and persists it', () => {
    const result = runGsdTools(['config-set', 'workflow.security_audit_phase', 'false'], tmpDir);
    assert.ok(result.success, `config-set should accept false: ${result.error}`);

    const configPath = path.join(tmpDir, '.planning', 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    assert.strictEqual(config.workflow?.security_audit_phase, false, 'value must be persisted');
  });

  test('an absent key resolves to the schema default false', () => {
    const result = runGsdTools(['config-get', 'workflow.security_audit_phase', '--raw'], tmpDir);
    assert.ok(result.success, `config-get must resolve the schema default: ${result.error}`);
    assert.strictEqual(result.output, 'false', 'absent workflow.security_audit_phase must resolve to false');
  });

  test('config-set rejects a non-boolean value and leaves the previous value intact', () => {
    const seed = runGsdTools(['config-set', 'workflow.security_audit_phase', 'true'], tmpDir);
    assert.ok(seed.success, `seed set must succeed: ${seed.error}`);

    const result = runGsdTools(['config-set', 'workflow.security_audit_phase', 'not-a-boolean'], tmpDir);
    assert.strictEqual(result.success, false, 'a non-boolean value must be rejected');

    const configPath = path.join(tmpDir, '.planning', 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    assert.strictEqual(
      config.workflow?.security_audit_phase,
      true,
      'the rejected write must not overwrite the persisted value'
    );
  });

  test('config-set rejects a numeric value where a boolean is required', () => {
    const seed = runGsdTools(['config-set', 'workflow.security_audit_phase', 'false'], tmpDir);
    assert.ok(seed.success, `seed set must succeed: ${seed.error}`);

    const result = runGsdTools(['config-set', 'workflow.security_audit_phase', '1'], tmpDir);
    assert.strictEqual(result.success, false, 'a number must be rejected for a boolean key');

    const configPath = path.join(tmpDir, '.planning', 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    assert.strictEqual(
      config.workflow?.security_audit_phase,
      false,
      'the rejected write must not overwrite the persisted value'
    );
  });

  test('unknown sibling spellings are still rejected', () => {
    const result = runGsdTools(['config-set', 'workflow.security_audit', 'true'], tmpDir);
    assert.strictEqual(result.success, false, 'workflow.security_audit is not a valid key');
  });
});

describe('security_audit_phase: config template default', () => {
  test('config template ships security_audit_phase default false', () => {
    const template = JSON.parse(fs.readFileSync(CONFIG_TEMPLATE_PATH, 'utf-8'));
    assert.strictEqual(
      template.workflow.security_audit_phase,
      false,
      'config template workflow.security_audit_phase should default to false'
    );
  });
});

describe('security_audit_phase: complete-milestone.md reminder step', () => {
  let content;
  let step;

  before(() => {
    content = fs.readFileSync(COMPLETE_MILESTONE_PATH, 'utf-8');
    const start = content.indexOf('<step name="security_audit_reminder">');
    assert.ok(start !== -1, 'complete-milestone.md must contain a security_audit_reminder step');
    const end = content.indexOf('</step>', start);
    assert.ok(end !== -1, 'security_audit_reminder step must be closed');
    step = content.slice(start, end);
  });

  test('the step is gated on config-get workflow.security_audit_phase', () => {
    assert.ok(
      step.includes('gsd_run query config-get workflow.security_audit_phase'),
      'the step must read workflow.security_audit_phase via config-get'
    );
  });

  test('the key is off by default — the step fails open to silence', () => {
    assert.ok(
      step.includes('|| echo "false"'),
      'the config-get fallback must default to "false" so a tooling failure changes nothing'
    );
    assert.match(
      step,
      /skip this step silently/i,
      'the step must instruct a silent skip when the key is not true'
    );
  });

  test('the gate polarity is pinned: skip when the key is not "true"', () => {
    assert.match(
      step,
      /is not `"true"`:\s*skip this step silently/i,
      'the gate must skip when SECURITY_AUDIT_PHASE is not "true"'
    );
    assert.ok(
      !/is\s+`"true"`:\s*skip/i.test(step),
      'the gate must not be inverted into skip-when-true'
    );
  });

  test('the prose default is pinned to false', () => {
    assert.ok(
      step.includes('default `false`'),
      'the step must state the key defaults to false'
    );
    assert.ok(
      !/default\s+`true`/.test(step),
      'the prose default must not be flipped to true'
    );
  });

  test('the reminder is conditional on missing evidence', () => {
    const evidenceAt = step.indexOf('If no evidence exists');
    assert.ok(evidenceAt !== -1, 'the step must gate the reminder on missing evidence');
    const reminderAt = step.indexOf('print this reminder');
    assert.ok(reminderAt !== -1, 'the reminder block must exist');
    assert.ok(
      evidenceAt < reminderAt,
      'the "If no evidence exists" condition must precede the reminder'
    );
  });

  test('the reminder is tool-agnostic and never fabricates audit results', () => {
    assert.ok(
      step.includes('no audit tooling available'),
      'the reminder must report "no audit tooling available" when no tooling exists'
    );
    assert.match(
      step,
      /NEVER fabricate/i,
      'the reminder must forbid fabricating audit results'
    );
    assert.match(
      step,
      /whatever audit\s+skill or tooling/i,
      'the reminder must not name a specific audit tool'
    );
  });

  test('the reminder is non-blocking', () => {
    assert.match(
      step,
      /never blocks, gates, or delays/i,
      'the reminder must be explicitly non-blocking'
    );
  });

  test('per-phase secure-phase and code review do not count as audit evidence', () => {
    assert.match(
      step,
      /NOT a whole-codebase security audit/i,
      'the step must disqualify per-phase verification as audit evidence'
    );
  });

  test('the reminder runs before the milestone close', () => {
    const reminderAt = content.indexOf('<step name="security_audit_reminder">');
    const archiveAt = content.indexOf('<step name="archive_milestone">');
    const verifyAt = content.indexOf('<step name="verify_readiness">');
    assert.ok(archiveAt !== -1 && verifyAt !== -1, 'close steps must exist');
    assert.ok(
      reminderAt < verifyAt,
      'the reminder must surface before the readiness confirmation and close'
    );
    assert.ok(
      reminderAt < archiveAt,
      'the reminder must surface before the irreversible archive step'
    );
  });
});

describe('security_audit_phase: documentation', () => {
  let planningConfig;
  let docsConfig;

  before(() => {
    planningConfig = fs.readFileSync(PLANNING_CONFIG_PATH, 'utf-8');
    docsConfig = fs.readFileSync(DOCS_CONFIG_PATH, 'utf-8');
  });

  test('planning-config.md documents workflow.security_audit_phase', () => {
    assert.ok(
      planningConfig.includes('`workflow.security_audit_phase`'),
      'planning-config.md must document workflow.security_audit_phase'
    );
  });

  test('docs/CONFIGURATION.md documents workflow.security_audit_phase', () => {
    assert.ok(
      docsConfig.includes('`workflow.security_audit_phase`'),
      'docs/CONFIGURATION.md must document workflow.security_audit_phase'
    );
  });
});
