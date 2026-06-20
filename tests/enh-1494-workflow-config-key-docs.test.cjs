'use strict';

/**
 * Parity assertions for #1494: workflow config keys that are consumed by
 * planning-pipeline code must be (a) accepted by VALID_CONFIG_KEYS and
 * (b) documented in references/planning-config.md.
 *
 * Per DEFECT.GENERATIVE-FIX: a shared constant / key-list that spans two
 * surfaces requires a parity assertion that fails when the surfaces diverge.
 */

const { describe, test, before, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { createTempProject, cleanup, runGsdTools } = require('./helpers.cjs');

const CONFIG_SCHEMA_PATH = path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'config-schema.cjs');
const PLANNING_CONFIG_PATH = path.join(__dirname, '..', 'gsd-core', 'references', 'planning-config.md');

describe('VALID_CONFIG_KEYS parity — #1494 orphan-undocumented keys', () => {
  const { VALID_CONFIG_KEYS } = require(CONFIG_SCHEMA_PATH);

  test('workflow.mvp_mode is in VALID_CONFIG_KEYS', () => {
    assert.ok(
      VALID_CONFIG_KEYS.has('workflow.mvp_mode'),
      'workflow.mvp_mode is read by config-loader.cts and plan-phase.md but was missing from VALID_CONFIG_KEYS (#1494)'
    );
  });

  test('workflow.code_review_command is in VALID_CONFIG_KEYS', () => {
    assert.ok(
      VALID_CONFIG_KEYS.has('workflow.code_review_command'),
      'workflow.code_review_command must be in VALID_CONFIG_KEYS'
    );
  });

  test('workflow.plan_chunked is in VALID_CONFIG_KEYS', () => {
    assert.ok(
      VALID_CONFIG_KEYS.has('workflow.plan_chunked'),
      'workflow.plan_chunked must be in VALID_CONFIG_KEYS'
    );
  });

  test('workflow.test_command is in VALID_CONFIG_KEYS', () => {
    assert.ok(
      VALID_CONFIG_KEYS.has('workflow.test_command'),
      'workflow.test_command must be in VALID_CONFIG_KEYS'
    );
  });

  test('workflow.build_command is in VALID_CONFIG_KEYS', () => {
    assert.ok(
      VALID_CONFIG_KEYS.has('workflow.build_command'),
      'workflow.build_command must be in VALID_CONFIG_KEYS'
    );
  });
});

describe('config-set accepts workflow.mvp_mode (#1494)', () => {
  let tmpDir;
  afterEach(() => { if (tmpDir) cleanup(tmpDir); });

  test('config-set workflow.mvp_mode true succeeds and stores the value', () => {
    tmpDir = createTempProject();
    const result = runGsdTools(['config-set', 'workflow.mvp_mode', 'true'], tmpDir);
    assert.ok(
      result.success,
      `config-set workflow.mvp_mode must succeed; got:\nstdout: ${result.output}\nstderr: ${result.error}`
    );
    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.updated, true, 'response must have updated:true');
    assert.strictEqual(parsed.key, 'workflow.mvp_mode', 'response must echo the key');
  });

  test('config-set workflow.mvp_mode false succeeds', () => {
    tmpDir = createTempProject();
    const result = runGsdTools(['config-set', 'workflow.mvp_mode', 'false'], tmpDir);
    assert.ok(
      result.success,
      `config-set workflow.mvp_mode false must succeed; got:\nstdout: ${result.output}\nstderr: ${result.error}`
    );
    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.updated, true);
  });
});

// allow-test-rule: source-text-is-the-product — planning-config.md is the deployed reference contract (#1494)
describe('planning-config.md documents #1494 keys', () => {
  let content;
  before(() => { content = fs.readFileSync(PLANNING_CONFIG_PATH, 'utf-8'); });

  const KEYS = [
    'workflow.mvp_mode',
    'workflow.code_review_command',
    'workflow.plan_chunked',
    'workflow.test_command',
    'workflow.build_command',
  ];

  for (const key of KEYS) {
    test(`planning-config.md documents \`${key}\``, () => {
      assert.ok(
        content.includes(`\`${key}\``),
        `planning-config.md must document \`${key}\` (#1494)`
      );
    });

    test(`\`${key}\` appears in the Complete Field Reference section`, () => {
      const refSection = content.slice(content.indexOf('## Complete Field Reference'));
      assert.ok(
        refSection.includes(`\`${key}\``),
        `planning-config.md Complete Field Reference must include \`${key}\` (#1494)`
      );
    });
  }
});
