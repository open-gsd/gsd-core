/**
 * Unit tests for src/resolution.cts → gsd-core/bin/lib/resolution.cjs
 *
 * Tests the `makeResolution` builder and the `Resolution<T>` envelope shape
 * introduced for ADR-1411 P3 (Resolution Provenance, #1416).
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const RESOLUTION_PATH = path.join(__dirname, '../gsd-core/bin/lib/resolution.cjs');

describe('resolution module — makeResolution builder', () => {
  test('module loads and exports makeResolution', () => {
    const mod = require(RESOLUTION_PATH);
    assert.ok(mod, 'module must be truthy');
    assert.strictEqual(typeof mod.makeResolution, 'function', 'makeResolution must be a function');
  });

  test('makeResolution builds the Resolution<T> shape', () => {
    const { makeResolution } = require(RESOLUTION_PATH);
    const result = makeResolution(
      { block: '<agent_skills />', skills_count: 1 },
      { configured: true, reason: 'resolved', warnings: [] },
    );
    assert.ok(result, 'result must be truthy');
    assert.ok('value' in result, 'result must have value field');
    assert.ok('configured' in result, 'result must have configured field');
    assert.ok('reason' in result, 'result must have reason field');
    assert.ok('warnings' in result, 'result must have warnings field');
  });

  test('makeResolution preserves the value as-is', () => {
    const { makeResolution } = require(RESOLUTION_PATH);
    const value = { block: '<agent_skills>test</agent_skills>', skills_count: 2 };
    const result = makeResolution(value, { configured: true, reason: 'resolved', warnings: [] });
    assert.deepStrictEqual(result.value, value, 'value must be preserved');
    assert.strictEqual(result.value.block, '<agent_skills>test</agent_skills>');
    assert.strictEqual(result.value.skills_count, 2);
  });

  test('makeResolution carries configured field', () => {
    const { makeResolution } = require(RESOLUTION_PATH);
    const trueResult = makeResolution({ block: '', skills_count: 0 }, { configured: true, reason: 'configured_empty', warnings: [] });
    const falseResult = makeResolution({ block: '', skills_count: 0 }, { configured: false, reason: 'not_configured', warnings: [] });
    assert.strictEqual(trueResult.configured, true, 'configured:true must be preserved');
    assert.strictEqual(falseResult.configured, false, 'configured:false must be preserved');
  });

  test('makeResolution carries reason field', () => {
    const { makeResolution } = require(RESOLUTION_PATH);
    const reasons = ['resolved', 'not_configured', 'configured_empty', 'configured_unresolved'];
    for (const reason of reasons) {
      const result = makeResolution({ block: '', skills_count: 0 }, { configured: false, reason, warnings: [] });
      assert.strictEqual(result.reason, reason, `reason '${reason}' must be preserved`);
    }
  });

  test('makeResolution carries warnings array', () => {
    const { makeResolution } = require(RESOLUTION_PATH);
    const warnings = ['path /foo/bar not found', 'path /baz not found'];
    const result = makeResolution({ block: '', skills_count: 0 }, { configured: true, reason: 'configured_unresolved', warnings });
    assert.deepStrictEqual(result.warnings, warnings, 'warnings must be preserved');
    assert.strictEqual(result.warnings.length, 2);
  });

  test('makeResolution with empty warnings array', () => {
    const { makeResolution } = require(RESOLUTION_PATH);
    const result = makeResolution({ block: '<agent_skills />', skills_count: 1 }, { configured: true, reason: 'resolved', warnings: [] });
    assert.deepStrictEqual(result.warnings, [], 'empty warnings array must be preserved');
  });

  test('makeResolution works with non-AgentSkillsValue generics (string)', () => {
    const { makeResolution } = require(RESOLUTION_PATH);
    const result = makeResolution('hello', { configured: true, reason: 'resolved', warnings: [] });
    assert.strictEqual(result.value, 'hello', 'string value must be preserved');
    assert.strictEqual(result.configured, true);
  });

  test('makeResolution result has exactly the four envelope fields plus value', () => {
    const { makeResolution } = require(RESOLUTION_PATH);
    const result = makeResolution(42, { configured: false, reason: 'not_configured', warnings: [] });
    const keys = Object.keys(result).sort();
    assert.deepStrictEqual(keys, ['configured', 'reason', 'value', 'warnings'], 'envelope must have exactly 4 fields');
  });
});
