/**
 * Regression test for the prototype-pollution guard in setConfigValue()
 * (src/config.cts, fix #663).
 *
 * config-set splits the key path on '.' and checks every segment against a
 * FORBIDDEN_KEYS set {'__proto__', 'prototype', 'constructor'}.  These tests
 * confirm:
 *   a) The command exits non-zero for every poisoned key.
 *   b) Object.prototype is clean after the attempt (no pollution leaked).
 *   c) A legitimate nested key still works (guard does not over-reject).
 *
 * Requirements: TEST-663-A
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

// ─── helpers ──────────────────────────────────────────────────────────────────

function readConfig(tmpDir) {
  const configPath = path.join(tmpDir, '.planning', 'config.json');
  return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
}

// ─── tests ────────────────────────────────────────────────────────────────────

describe('config-set prototype-pollution guard (#663)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    // Initialise config so there is a config.json to write to.
    runGsdTools('config-ensure-section', tmpDir);
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('rejects __proto__ key segment and does not pollute Object.prototype', () => {
    const result = runGsdTools('config-set __proto__.polluted true', tmpDir);

    assert.strictEqual(result.success, false, `Expected failure but got: ${result.output}`);

    // No prototype pollution.
    assert.strictEqual(({}).polluted, undefined, '__proto__ pollution: {}.polluted should be undefined');
    assert.strictEqual(Object.prototype.polluted, undefined, '__proto__ pollution: Object.prototype.polluted should be undefined');

    // Confirm .planning/config.json does not have a 'polluted' property at any level.
    const config = readConfig(tmpDir);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(config, 'polluted'), false,
      'config.json root must not gain a "polluted" key');
  });

  test('rejects constructor.prototype key and does not pollute Object.prototype', () => {
    const result = runGsdTools('config-set constructor.prototype.polluted2 true', tmpDir);

    assert.strictEqual(result.success, false, `Expected failure but got: ${result.output}`);

    assert.strictEqual(({}).polluted2, undefined, 'constructor chain pollution: {}.polluted2 should be undefined');
    assert.strictEqual(Object.prototype.polluted2, undefined,
      'constructor chain pollution: Object.prototype.polluted2 should be undefined');
  });

  test('rejects bare prototype key segment', () => {
    const result = runGsdTools('config-set prototype.x true', tmpDir);

    assert.strictEqual(result.success, false, `Expected failure but got: ${result.output}`);
    assert.strictEqual(Object.prototype.x, undefined, 'prototype.x should not leak onto Object.prototype');
  });

  test('positive control: legitimate nested key workflow.research succeeds', () => {
    const result = runGsdTools('config-set workflow.research true', tmpDir);

    assert.ok(result.success, `Legitimate key rejected unexpectedly: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.workflow.research, true, 'workflow.research should be written to config.json');
  });
});
