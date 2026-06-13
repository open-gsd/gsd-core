// allow-test-rule: source-text-is-the-product
'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const HOST_LOOP_FILES = [
  'gsd-core/workflows/plan-phase.md',
  'gsd-core/workflows/execute-phase.md',
  'gsd-core/workflows/verify-work.md',
  'gsd-core/workflows/ship.md',
];

const CORE_SUBSTRATE_TERMS = [
  'Verification substrate',
  'verifier↔predicate contract',
  'Probe Core Module',
  'Edge Probe Module',
];

const registry = require('../gsd-core/bin/lib/capability-registry.cjs');
const { isCentralConfigKey } = require('../gsd-core/bin/lib/config-schema.cjs');

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function activeWhenKeys() {
  const keys = new Set();
  for (const cap of Object.values(registry.capabilities)) {
    for (const group of ['steps', 'gates', 'contributions']) {
      for (const hook of cap[group] || []) {
        if (hook.when) keys.add(hook.when);
      }
    }
  }
  return [...keys].sort();
}

describe('ADR-857 Phase 6 capstone conformance (#1139)', () => {
  test('first-party optional feature capabilities are declared in the generated registry', () => {
    const expectedFeatureCapabilities = [
      'ai-integration',
      'audit',
      'code-review',
      'graphify',
      'intel',
      'nyquist',
      'pattern-mapper',
      'research',
      'security',
      'ui',
    ];

    for (const capId of expectedFeatureCapabilities) {
      assert.equal(registry.capabilities[capId]?.role, 'feature', `${capId} must be a feature Capability`);
    }
  });

  test('core verification substrate is documented as deliberately not capability-owned', () => {
    const context = readRepoFile('CONTEXT.md');
    for (const term of CORE_SUBSTRATE_TERMS) {
      assert.match(context, new RegExp(escapeRegExp(term)), `${term} must be documented in CONTEXT.md`);
    }
  });

  test('host loop files do not read capability hook activation keys directly', () => {
    const forbiddenKeys = activeWhenKeys();
    assert.ok(forbiddenKeys.length > 0, 'registry must expose hook activation keys');

    for (const relativePath of HOST_LOOP_FILES) {
      const content = readRepoFile(relativePath);
      for (const key of forbiddenKeys) {
        assert.doesNotMatch(
          content,
          new RegExp(`\\bconfig-get\\s+${escapeRegExp(key)}\\b`),
          `${relativePath} must resolve ${key} through Capability hooks/state, not direct config-get`,
        );
      }
    }
  });

  test('capability-owned config keys are not reintroduced into the central schema', () => {
    for (const key of Object.keys(registry.configKeys).sort()) {
      assert.equal(
        isCentralConfigKey(key),
        false,
        `${key} is owned by capability ${registry.configKeys[key]} and must stay out of central config schema`,
      );
    }
  });

  test('host loop workflow files have committed byte budgets', () => {
    const baseline = JSON.parse(readRepoFile('tests/workflow-size-baseline.json'));
    for (const relativePath of HOST_LOOP_FILES) {
      const fileName = path.basename(relativePath);
      assert.equal(typeof baseline[fileName], 'number', `${fileName} must have a workflow-size baseline`);
      assert.ok(baseline[fileName] > 0, `${fileName} baseline must be positive`);
    }
  });
});
