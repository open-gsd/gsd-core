'use strict';

/**
 * Config whitelist gate for review.reviewer_instances (#1517).
 *
 * Behavioral test (not source-grep): proves `config-set` accepts the
 * review.reviewer_instances.<name>.{cli,model,agent} paths. Without the
 * dynamicKeyPatterns entry in config-schema.manifest.json, config-set rejects
 * the key and this test fails — that is the regression-must-fail-first signal.
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { createTempProject, cleanup, runGsdTools } = require('./helpers.cjs');

describe('config-set review.reviewer_instances (#1517)', () => {
  test('accepts a known-adapter cli for an instance', (t) => {
    const tmpDir = createTempProject('reviewer-instances-cli');
    t.after(() => cleanup(tmpDir));

    const result = runGsdTools('config-set review.reviewer_instances.opencode-deepseek.cli opencode', tmpDir);
    assert.ok(result.success, `config-set should accept the instance cli path: ${result.error || JSON.stringify(result)}`);

    const configPath = path.join(tmpDir, '.planning', 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    assert.strictEqual(
      config.review?.reviewer_instances?.['opencode-deepseek']?.cli,
      'opencode',
      'instance cli must persist',
    );
  });

  test('accepts model and agent fields for an instance', (t) => {
    const tmpDir = createTempProject('reviewer-instances-model');
    t.after(() => cleanup(tmpDir));

    const modelRes = runGsdTools('config-set review.reviewer_instances.opencode-deepseek.model deepseek/deepseek-v4-pro', tmpDir);
    assert.ok(modelRes.success, `model set failed: ${modelRes.error}`);
    const agentRes = runGsdTools('config-set review.reviewer_instances.opencode-deepseek.agent review', tmpDir);
    assert.ok(agentRes.success, `agent set failed: ${agentRes.error}`);

    const configPath = path.join(tmpDir, '.planning', 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    assert.strictEqual(config.review.reviewer_instances['opencode-deepseek'].model, 'deepseek/deepseek-v4-pro');
    assert.strictEqual(config.review.reviewer_instances['opencode-deepseek'].agent, 'review');
  });
});
