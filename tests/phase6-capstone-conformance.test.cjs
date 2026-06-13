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

  // ─── Phase-6 conformance: RED BY DESIGN until phase 6 is actually complete ──────
  //
  // #1139 closed (via #1158) with a green "capstone conformance gate" while the
  // ADR-857 phase-6 acceptance criteria were unmet — a false green. The three
  // tests below assert the real criteria with NO paper-over allowlist, so the
  // gate stays RED until the work lands. Green here must mean "phase 6 conformant,"
  // not "no new regression." Fixes tracked in #1167 / #1168 / #1169.

  test('every declared capability hook point has a render-hooks call site in the host loop (#1168)', () => {
    // No allowlist: every point a capability declares a hook at MUST have a
    // `render-hooks` call site in the host loop, or those hooks can never fire.
    const declaredPoints = new Set();
    for (const cap of Object.values(registry.capabilities)) {
      for (const group of ['steps', 'gates', 'contributions']) {
        for (const hook of cap[group] || []) {
          if (hook.point) declaredPoints.add(hook.point);
        }
      }
    }

    // Scan only the host loop files (a `render-hooks` mention in a non-host
    // workflow must not mask a lost host call site).
    const callSites = new Set();
    const reCall = /loop render-hooks\s+([a-z:]+)/g;
    for (const relativePath of HOST_LOOP_FILES) {
      const content = readRepoFile(relativePath);
      let m;
      while ((m = reCall.exec(content))) callSites.add(m[1]);
    }

    const orphaned = [...declaredPoints].sort().filter((p) => !callSites.has(p));
    assert.deepEqual(
      orphaned, [],
      `ADR-857 phase 6 is NOT complete: capability hooks declare these extension points ` +
      `but no host-loop workflow calls \`gsd_run loop render-hooks <point>\`, so the hooks ` +
      `can never fire: ${orphaned.join(', ')}. Wire each call site (#1167/#1169).`,
    );
  });

  test('all ADR-857-named optional features are migrated to Capabilities (#1169)', () => {
    // ADR-857 §53 + Decision 7 enumerate these optional, non-loop modules as
    // Capabilities. Until each is a registered feature capability (or documented
    // as core substrate), phase 6 is incomplete and the capstone is a false green.
    const REQUIRED = ['tdd', 'schema-gate', 'drift', 'gap-analysis', 'profile-pipeline'];
    const unmigrated = REQUIRED.filter((id) => registry.capabilities[id]?.role !== 'feature');
    assert.deepEqual(
      unmigrated, [],
      `ADR-857 phase 6 is NOT complete: these ADR-named optional features are not yet ` +
      `feature Capabilities (still inline in plan-phase.md / execute-phase.md): ` +
      `${unmigrated.join(', ')}. Migrate each, or document it as core substrate (#1169).`,
    );
  });

  test('host loop reads no capability-owned config key inline (#1169)', () => {
    // Phase 6 requires the loop to resolve capability behavior via render-hooks,
    // not by reading capability-owned keys directly. Any inline `config-get` of a
    // registry-owned key is an incomplete migration (the loop still owns the
    // feature's params).
    const leaks = [];
    for (const relativePath of HOST_LOOP_FILES) {
      const content = readRepoFile(relativePath);
      for (const key of Object.keys(registry.configKeys)) {
        if (new RegExp(`\\bconfig-get\\s+${escapeRegExp(key)}\\b`).test(content)) {
          leaks.push(`${path.basename(relativePath)} → ${key} (owned by ${registry.configKeys[key]})`);
        }
      }
    }
    leaks.sort();
    assert.deepEqual(
      leaks, [],
      `ADR-857 phase 6 is NOT complete: the host loop reads capability-owned config keys ` +
      `inline:\n  ${leaks.join('\n  ')}\nThe owning capability must render/consume these (#1169).`,
    );
  });
});
