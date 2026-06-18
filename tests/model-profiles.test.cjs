/**
 * Model Profiles Tests
 *
 * Tests for MODEL_PROFILES data structure, VALID_PROFILES list,
 * formatAgentToModelMapAsTable, getAgentToModelMapForProfile,
 * and resolveModelInternal precedence (override > profile > default).
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const fs = require('node:fs');
const path = require('node:path');

const {
  MODEL_PROFILES,
  VALID_PROFILES,
  formatAgentToModelMapAsTable,
  getAgentToModelMapForProfile,
} = require('../gsd-core/bin/lib/model-profiles.cjs');

const { resolveModelInternal } = require('../gsd-core/bin/lib/model-resolver.cjs');
const { createTempProject, cleanup } = require('./helpers.cjs');
const { listAgentFiles } = require('./helpers/agent-roster.cjs');

// ─── temp-project helpers ──────────────────────────────────────────────────────

function writeConfig(tmpDir, obj) {
  fs.writeFileSync(
    path.join(tmpDir, '.planning', 'config.json'),
    JSON.stringify(obj, null, 2),
    'utf-8'
  );
}

// ─── MODEL_PROFILES data integrity ────────────────────────────────────────────

describe('MODEL_PROFILES', () => {
  test('contains every shipped gsd agent file on disk (#3229)', () => {
    // Canonical source roster (sorted gsd-* basenames without .md) — shared helper.
    const expectedAgents = listAgentFiles();
    const actualAgents = Object.keys(MODEL_PROFILES).sort();
    assert.deepStrictEqual(actualAgents, expectedAgents);
  });

  test('every agent has quality, balanced, budget, and adaptive profiles', () => {
    for (const [agent, profiles] of Object.entries(MODEL_PROFILES)) {
      assert.ok(profiles.quality, `${agent} missing quality profile`);
      assert.ok(profiles.balanced, `${agent} missing balanced profile`);
      assert.ok(profiles.budget, `${agent} missing budget profile`);
      assert.ok(profiles.adaptive, `${agent} missing adaptive profile`);
    }
  });

  test('all profile values are valid model aliases', () => {
    const validModels = ['opus', 'sonnet', 'haiku'];
    for (const [agent, profiles] of Object.entries(MODEL_PROFILES)) {
      for (const [profile, model] of Object.entries(profiles)) {
        assert.ok(
          validModels.includes(model),
          `${agent}.${profile} has invalid model "${model}" — expected one of ${validModels.join(', ')}`
        );
      }
    }
  });

  test('quality profile never uses haiku', () => {
    for (const [agent, profiles] of Object.entries(MODEL_PROFILES)) {
      assert.notStrictEqual(
        profiles.quality, 'haiku',
        `${agent} quality profile should not use haiku`
      );
    }
  });
});

// ─── VALID_PROFILES ───────────────────────────────────────────────────────────

describe('VALID_PROFILES', () => {
  test('contains quality, balanced, budget, adaptive, and inherit', () => {
    assert.deepStrictEqual(VALID_PROFILES.sort(), ['adaptive', 'balanced', 'budget', 'inherit', 'quality']);
  });

  test('includes all MODEL_PROFILES keys plus inherit', () => {
    const fromData = Object.keys(MODEL_PROFILES['gsd-planner']);
    for (const profile of fromData) {
      assert.ok(VALID_PROFILES.includes(profile), `VALID_PROFILES should include ${profile}`);
    }
    assert.ok(VALID_PROFILES.includes('inherit'), 'VALID_PROFILES should include inherit');
  });
});

// ─── getAgentToModelMapForProfile ─────────────────────────────────────────────

describe('getAgentToModelMapForProfile', () => {
  test('returns correct models for balanced profile', () => {
    const map = getAgentToModelMapForProfile('balanced');
    assert.strictEqual(map['gsd-planner'], 'opus');
    assert.strictEqual(map['gsd-codebase-mapper'], 'haiku');
    assert.strictEqual(map['gsd-verifier'], 'sonnet');
  });

  test('returns correct models for budget profile', () => {
    const map = getAgentToModelMapForProfile('budget');
    assert.strictEqual(map['gsd-planner'], 'sonnet');
    assert.strictEqual(map['gsd-phase-researcher'], 'haiku');
  });

  test('returns correct models for quality profile', () => {
    const map = getAgentToModelMapForProfile('quality');
    assert.strictEqual(map['gsd-planner'], 'opus');
    assert.strictEqual(map['gsd-executor'], 'opus');
  });

  test('returns correct models for adaptive profile', () => {
    const map = getAgentToModelMapForProfile('adaptive');
    assert.strictEqual(map['gsd-planner'], 'opus', 'planner should use opus in adaptive');
    assert.strictEqual(map['gsd-debugger'], 'opus', 'debugger should use opus in adaptive');
    assert.strictEqual(map['gsd-executor'], 'sonnet', 'executor should use sonnet in adaptive');
    assert.strictEqual(map['gsd-codebase-mapper'], 'haiku', 'mapper should use haiku in adaptive');
    assert.strictEqual(map['gsd-plan-checker'], 'haiku', 'checker should use haiku in adaptive');
  });

  // ─── resolution order: override > profile > default ─────────────────────────
  // Uses gsd-phase-researcher because it has visibly distinct values at every
  // level: balanced (default) = sonnet, budget (profile) = haiku, override = opus.
  // Each tier must beat the one below it; the test goes RED if resolveModelInternal
  // ignores model_overrides (returns 'haiku') or conflates default with profile
  // (returns 'sonnet' instead of 'haiku' for budget).
  describe('resolution order: override > profile > default', () => {
    // agent under test — must have three distinct model values across tiers
    const AGENT = 'gsd-phase-researcher';
    const EXPECTED_DEFAULT = 'sonnet'; // balanced profile (no config)
    const EXPECTED_PROFILE = 'haiku';  // budget profile
    const EXPECTED_OVERRIDE = 'opus';  // explicit model_overrides entry

    let tmpDir;
    beforeEach(() => { tmpDir = createTempProject(); });
    afterEach(() => { cleanup(tmpDir); tmpDir = null; });

    test('default (no config) resolves to balanced profile model', () => {
      // Sanity-check: balanced is the profile tier when no config is present.
      assert.strictEqual(
        resolveModelInternal(tmpDir, AGENT),
        EXPECTED_DEFAULT,
        `expected balanced-profile default "${EXPECTED_DEFAULT}" but got a different model`
      );
    });

    test('profile setting (budget) beats the balanced default', () => {
      writeConfig(tmpDir, { model_profile: 'budget' });
      assert.strictEqual(
        resolveModelInternal(tmpDir, AGENT),
        EXPECTED_PROFILE,
        `expected budget-profile model "${EXPECTED_PROFILE}" but got a different model`
      );
    });

    test('model_overrides entry beats the active profile', () => {
      // budget profile would give haiku; override must win with opus
      writeConfig(tmpDir, {
        model_profile: 'budget',
        model_overrides: { [AGENT]: EXPECTED_OVERRIDE },
      });
      assert.strictEqual(
        resolveModelInternal(tmpDir, AGENT),
        EXPECTED_OVERRIDE,
        `expected override "${EXPECTED_OVERRIDE}" to beat budget-profile model "${EXPECTED_PROFILE}"`
      );
    });

    test('model_overrides beats the default profile too (no explicit profile key)', () => {
      // Even without an explicit model_profile, override still wins over default
      writeConfig(tmpDir, {
        model_overrides: { [AGENT]: EXPECTED_OVERRIDE },
      });
      assert.strictEqual(
        resolveModelInternal(tmpDir, AGENT),
        EXPECTED_OVERRIDE,
        `expected override "${EXPECTED_OVERRIDE}" to beat balanced default "${EXPECTED_DEFAULT}"`
      );
    });
  });

  test('returns all agents in the map', () => {
    const map = getAgentToModelMapForProfile('balanced');
    const agentCount = Object.keys(MODEL_PROFILES).length;
    assert.strictEqual(Object.keys(map).length, agentCount);
  });
});

// ─── formatAgentToModelMapAsTable ─────────────────────────────────────────────

describe('formatAgentToModelMapAsTable', () => {
  test('produces a table with header and separator', () => {
    const map = { 'gsd-planner': 'opus', 'gsd-executor': 'sonnet' };
    const table = formatAgentToModelMapAsTable(map);
    assert.ok(table.includes('Agent'), 'should have Agent header');
    assert.ok(table.includes('Model'), 'should have Model header');
    assert.ok(table.includes('─'), 'should have separator line');
    assert.ok(table.includes('gsd-planner'), 'should list agent');
    assert.ok(table.includes('opus'), 'should list model');
  });

  test('pads columns correctly', () => {
    const map = { 'a': 'opus', 'very-long-agent-name': 'haiku' };
    const table = formatAgentToModelMapAsTable(map);
    const lines = table.split('\n').filter(l => l.trim());
    // Separator line uses ┼, data/header lines use │
    const dataLines = lines.filter(l => l.includes('│'));
    const pipePositions = dataLines.map(l => l.indexOf('│'));
    const unique = [...new Set(pipePositions)];
    assert.strictEqual(unique.length, 1, 'all data lines should align on │');
  });

  test('handles empty map', () => {
    const table = formatAgentToModelMapAsTable({});
    assert.ok(table.includes('Agent'), 'should still have header');
  });
});
