'use strict';

/**
 * Characterization tests for the skill cluster definitions module.
 * Locks the CLUSTERS export shape and allClusteredSkills function.
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  CLUSTERS,
  allClusteredSkills,
} = require('../gsd-core/bin/lib/clusters.cjs');

describe('CLUSTERS', () => {
  test('is a frozen object', () => {
    assert.ok(Object.isFrozen(CLUSTERS));
  });

  test('contains expected cluster names', () => {
    const expectedKeys = [
      'core_loop', 'audit_review', 'milestone', 'research_ideate',
      'workspace_state', 'docs', 'ui', 'ai_eval', 'ns_meta', 'utility',
    ];
    for (const key of expectedKeys) {
      assert.ok(key in CLUSTERS, `expected cluster '${key}' to exist`);
    }
  });

  test('each cluster is a frozen array of strings', () => {
    for (const [name, skills] of Object.entries(CLUSTERS)) {
      assert.ok(Array.isArray(skills), `${name} should be an array`);
      assert.ok(Object.isFrozen(skills), `${name} should be frozen`);
      for (const skill of skills) {
        assert.equal(typeof skill, 'string', `${name} skill ${skill} should be a string`);
      }
    }
  });

  test('core_loop contains expected skills', () => {
    assert.ok(CLUSTERS.core_loop.includes('plan-phase'));
    assert.ok(CLUSTERS.core_loop.includes('execute-phase'));
    assert.ok(CLUSTERS.core_loop.includes('help'));
  });

  test('audit_review contains code-review', () => {
    assert.ok(CLUSTERS.audit_review.includes('code-review'));
  });

  test('utility cluster is the largest by membership', () => {
    const utilitySize = CLUSTERS.utility.length;
    // utility must meet the design-intent floor: at least 15 distinct skill stems
    assert.ok(utilitySize >= 15, `utility cluster must have at least 15 members, got ${utilitySize}`);
    for (const [name, skills] of Object.entries(CLUSTERS)) {
      if (name !== 'utility') {
        assert.ok(utilitySize >= skills.length, `utility (${utilitySize}) should be >= ${name} (${skills.length})`);
      }
    }
  });
});

describe('allClusteredSkills', () => {
  test('returns a Set', () => {
    assert.ok(allClusteredSkills() instanceof Set);
  });

  test('Set is non-empty', () => {
    assert.ok(allClusteredSkills().size > 0);
  });

  test('contains skills from all clusters', () => {
    const all = allClusteredSkills();
    assert.ok(all.has('plan-phase'));   // core_loop
    assert.ok(all.has('code-review')); // audit_review
    assert.ok(all.has('health'));      // milestone + utility
    assert.ok(all.has('surface'));     // utility
  });

  test('union is superset of every individual cluster', () => {
    const all = allClusteredSkills();
    for (const skills of Object.values(CLUSTERS)) {
      for (const s of skills) {
        assert.ok(all.has(s), `skill '${s}' should be in allClusteredSkills`);
      }
    }
  });
});
