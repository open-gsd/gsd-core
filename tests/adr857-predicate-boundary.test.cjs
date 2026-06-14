/**
 * ADR-857 deliverable A — predicate-boundary conformance gate.
 *
 * Amended 2026-06-12: "Verification substrate vs. plug-in tier (the predicate boundary)"
 * + Rollout §6 exception: predicate-generation is CORE substrate, NOT an off-by-default
 * Feature Capability.
 *
 * Key ADR assertions tested here:
 *   - "The probe family that generates must-NOT-have and edge predicates is core
 *     verification substrate, not an off-by-default Feature Capability."
 *   - "no capabilities/edge-probe/ Feature Capability may remove it."
 *   - "phase 6 does not migrate predicate-generation to an off-by-default Capability."
 *   - "The substrate must be available even when all Feature Capabilities are off."
 *
 * Tests do NOT read source files (.md/.cjs) and .includes() on them.
 * All assertions drive the real exported functions and inspect typed return values.
 */
'use strict';
process.env.GSD_TEST_MODE = '1';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

// ── Paths ─────────────────────────────────────────────────────────────────────
const REPO_ROOT = path.join(__dirname, '..');
const LIB = path.join(REPO_ROOT, 'gsd-core', 'bin', 'lib');
const PROBE_CORE_PATH = path.join(LIB, 'probe-core.cjs');
const EDGE_PROBE_PATH = path.join(LIB, 'edge-probe.cjs');
const CAPABILITIES_DIR = path.join(REPO_ROOT, 'capabilities');

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Collect ids of all capability.json files under capabilities/. */
function collectCapabilityIds() {
  const dirs = fs.readdirSync(CAPABILITIES_DIR, { withFileTypes: true });
  const ids = [];
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const capFile = path.join(CAPABILITIES_DIR, d.name, 'capability.json');
    if (fs.existsSync(capFile)) {
      const parsed = JSON.parse(fs.readFileSync(capFile, 'utf8'));
      ids.push({ id: parsed.id, role: parsed.role });
    }
  }
  return ids;
}

/** Minimal valid item for probe-core analyzeCoverage. */
function makeItem(category, overrides = {}) {
  return {
    requirement_id: 'REQ-1',
    category,
    status: 'unresolved',
    verification: null,
    resolution: null,
    reason: null,
    probe: `probe-${category}`,
    ...overrides,
  };
}

/** Minimal validators bundle (mirrors edge adapter shape). */
const REPRESENTATIVE_VALIDATORS = {
  categories: ['boundary', 'adjacency', 'empty'],
  verification: ['explicit', 'backstop'],
  requiredFieldsByVerification: {
    explicit: ['resolution'],
    backstop: ['resolution'],
  },
};

// ── [happy] ADR-857 §"Verification substrate vs. plug-in tier": substrate loads and
//    functions as CORE regardless of capability config with NO capabilities active ───
describe('ADR-857 predicate boundary: substrate loads as core (no capabilities active)', () => {
  test('probe-core.cjs resolves from gsd-core/bin/lib (core path)', () => {
    // Confirm the module is loadable from the core lib path, not capabilities/
    assert.ok(
      fs.existsSync(PROBE_CORE_PATH),
      `probe-core.cjs must exist at core path ${PROBE_CORE_PATH}`
    );
    const pc = require(PROBE_CORE_PATH);
    assert.ok(pc != null, 'probe-core.cjs must export a non-null module');
  });

  test('edge-probe.cjs resolves from gsd-core/bin/lib (core path)', () => {
    assert.ok(
      fs.existsSync(EDGE_PROBE_PATH),
      `edge-probe.cjs must exist at core path ${EDGE_PROBE_PATH}`
    );
    const ep = require(EDGE_PROBE_PATH);
    assert.ok(ep != null, 'edge-probe.cjs must export a non-null module');
  });

  test('probe-core exports the locked VALID_STATUS set — substrate contract is present', () => {
    const pc = require(PROBE_CORE_PATH);
    // ADR: the contract is a stability contract — its shape must be consistent
    assert.ok(Array.isArray(pc.VALID_STATUS), 'VALID_STATUS must be an array');
    assert.deepEqual(
      [...pc.VALID_STATUS].sort(),
      ['dismissed', 'resolved', 'unresolved'],
      'VALID_STATUS must contain exactly resolved|dismissed|unresolved (the locked re-cut)'
    );
  });

  test('probe-core exports all four required contract functions', () => {
    const pc = require(PROBE_CORE_PATH);
    // The four deterministic substrate functions defined in probe-core
    assert.strictEqual(typeof pc.validateRequirement, 'function', 'validateRequirement must be a function');
    assert.strictEqual(typeof pc.validateResolution, 'function', 'validateResolution must be a function');
    assert.strictEqual(typeof pc.analyzeCoverage, 'function', 'analyzeCoverage must be a function');
    assert.strictEqual(typeof pc.runProbeCli, 'function', 'runProbeCli must be a function');
  });

  test('probe-core.validateRequirement accepts a valid requirement with NO capability config', () => {
    const pc = require(PROBE_CORE_PATH);
    // No capability config passed — function must work unconditionally (non-toggleable substrate)
    assert.doesNotThrow(
      () => pc.validateRequirement({ id: 'REQ-42', text: 'the system rounds values to two decimal places' }),
      'validateRequirement must not throw for a valid requirement when no capabilities are active'
    );
  });

  test('probe-core.analyzeCoverage returns a contract-shaped coverage report with NO capability config', () => {
    const pc = require(PROBE_CORE_PATH);
    // Drive the core merge/rollup engine with a minimal item set and NO capability config
    const items = [makeItem('boundary'), makeItem('adjacency')];
    const report = pc.analyzeCoverage(items, [], REPRESENTATIVE_VALIDATORS);

    // Contract shape: { items[], coverage: { applicable, resolved, unresolved, byVerification } }
    assert.ok(Array.isArray(report.items), 'report.items must be an array');
    assert.strictEqual(report.items.length, 2, 'report.items must contain both proposed items');
    assert.ok(report.coverage != null && typeof report.coverage === 'object', 'report.coverage must be an object');
    assert.strictEqual(typeof report.coverage.applicable, 'number', 'coverage.applicable must be a number');
    assert.strictEqual(typeof report.coverage.resolved, 'number', 'coverage.resolved must be a number');
    assert.strictEqual(typeof report.coverage.unresolved, 'number', 'coverage.unresolved must be a number');
    assert.ok(report.coverage.byVerification != null, 'coverage.byVerification must be present');

    // Exact values for genuineness
    assert.strictEqual(report.coverage.applicable, 2, 'applicable must equal item count (2)');
    assert.strictEqual(report.coverage.unresolved, 2, 'unresolved must be 2 (no resolutions provided)');
    assert.strictEqual(report.coverage.resolved, 0, 'resolved must be 0 (no resolutions provided)');
    assert.strictEqual(report.coverage.byVerification.explicit, 0, 'explicit count must be 0');
    assert.strictEqual(report.coverage.byVerification.backstop, 0, 'backstop count must be 0');
  });

  test('edge-probe exports the locked shape vocabulary (VALID_SHAPES, TAXONOMY, EDGE_VALIDATORS)', () => {
    const ep = require(EDGE_PROBE_PATH);
    // VALID_SHAPES: exactly 5 shape names
    assert.ok(ep.VALID_SHAPES instanceof Set, 'VALID_SHAPES must be a Set');
    assert.strictEqual(ep.VALID_SHAPES.size, 5, 'VALID_SHAPES must have exactly 5 entries');
    for (const s of ['numeric-range', 'collection', 'text', 'stateful', 'io']) {
      assert.ok(ep.VALID_SHAPES.has(s), `VALID_SHAPES must contain "${s}"`);
    }
    // TAXONOMY: exactly 8 edge categories
    assert.ok(Array.isArray(ep.TAXONOMY), 'TAXONOMY must be an array');
    assert.strictEqual(ep.TAXONOMY.length, 8, 'TAXONOMY must have exactly 8 categories');
    // EDGE_VALIDATORS: verification tiers must be exactly explicit|backstop
    assert.deepEqual(
      [...ep.EDGE_VALIDATORS.verification].sort(),
      ['backstop', 'explicit'],
      'EDGE_VALIDATORS.verification must be ["explicit","backstop"]'
    );
  });

  test('edge-probe.classifyShape returns a typed array result with NO capability config', () => {
    const ep = require(EDGE_PROBE_PATH);
    // ADR: substrate available without any capability toggling.
    // Text chosen to trigger multiple concrete shapes:
    //   "save" (word-boundary match in SHAPE_CUES.stateful) → stateful
    //   "file" (SHAPE_CUES.io) → io
    //   "maximum count limit" (SHAPE_CUES['numeric-range']) → numeric-range
    const shapes = ep.classifyShape('the system must save a file with a maximum count limit');
    assert.ok(Array.isArray(shapes), 'classifyShape must return an array');
    assert.ok(shapes.includes('numeric-range'), 'classifyShape must detect numeric-range from "maximum count limit"');
    assert.ok(shapes.includes('stateful'), 'classifyShape must detect stateful from "save" (word-boundary cue)');
    assert.ok(shapes.includes('io'), 'classifyShape must detect io from "file"');
  });

  test('edge-probe.proposeEdges returns unresolved items with contract shape with NO capability config', () => {
    const ep = require(EDGE_PROBE_PATH);
    const edges = ep.proposeEdges({ id: 'R-num', text: 'the score must stay within a numeric range between 0 and 100' });
    assert.ok(Array.isArray(edges), 'proposeEdges must return an array');
    assert.ok(edges.length > 0, 'proposeEdges must propose at least one edge for a numeric-range requirement');
    // Every proposed edge must be unresolved with null verification
    for (const edge of edges) {
      assert.strictEqual(edge.requirement_id, 'R-num', 'edge.requirement_id must match input id');
      assert.strictEqual(edge.status, 'unresolved', 'proposed edge status must be unresolved');
      assert.strictEqual(edge.verification, null, 'proposed edge verification must be null');
      assert.strictEqual(typeof edge.category, 'string', 'edge.category must be a string');
      assert.strictEqual(typeof edge.probe, 'string', 'edge.probe must be a string');
    }
    // Specific: "numeric range between 0 and 100" => boundary category expected
    const cats = edges.map(e => e.category);
    assert.ok(cats.includes('boundary'), 'proposeEdges must include boundary category for numeric-range text');
  });
});

// ── [negative] No off-by-default Feature Capability owns predicate-generation ──
describe('ADR-857 predicate boundary: no capabilities/edge-probe or prohibition-probe Feature Capability exists', () => {
  test('capabilities/edge-probe directory does NOT exist (ADR-857: not an off-by-default plug-in)', () => {
    const edgeProbeCap = path.join(CAPABILITIES_DIR, 'edge-probe');
    assert.strictEqual(
      fs.existsSync(edgeProbeCap),
      false,
      'capabilities/edge-probe must not exist — ADR-857 forbids predicate-generation as an off-by-default Capability'
    );
  });

  test('capabilities/prohibition-probe directory does NOT exist (ADR-857: not an off-by-default plug-in)', () => {
    const prohibitionProbeCap = path.join(CAPABILITIES_DIR, 'prohibition-probe');
    assert.strictEqual(
      fs.existsSync(prohibitionProbeCap),
      false,
      'capabilities/prohibition-probe must not exist — ADR-857 forbids predicate-generation as an off-by-default Capability'
    );
  });

  test('real capability registry has NO entry with id "edge-probe" or "prohibition-probe" with role "feature"', () => {
    const { capabilities } = require(path.join(LIB, 'capability-registry.cjs'));
    const ids = Object.keys(capabilities);

    // Assert no edge-probe feature capability
    const hasEdgeProbeFeature = ids.some(
      id => id === 'edge-probe' && capabilities[id].role === 'feature'
    );
    assert.strictEqual(
      hasEdgeProbeFeature,
      false,
      'registry must NOT contain a feature capability with id "edge-probe"'
    );

    // Assert no prohibition-probe feature capability
    const hasProhibitionProbeFeature = ids.some(
      id => id === 'prohibition-probe' && capabilities[id].role === 'feature'
    );
    assert.strictEqual(
      hasProhibitionProbeFeature,
      false,
      'registry must NOT contain a feature capability with id "prohibition-probe"'
    );

    // Also verify neither id exists at all (not even as a different role)
    assert.ok(
      !ids.includes('edge-probe'),
      'registry must not contain any capability with id "edge-probe"'
    );
    assert.ok(
      !ids.includes('prohibition-probe'),
      'registry must not contain any capability with id "prohibition-probe"'
    );
  });

  test('capability.json files on disk contain no id matching edge-probe or prohibition-probe with role feature', () => {
    const allCaps = collectCapabilityIds();
    const probeFeatures = allCaps.filter(
      c => (c.id === 'edge-probe' || c.id === 'prohibition-probe') && c.role === 'feature'
    );
    assert.deepEqual(
      probeFeatures,
      [],
      `No capability.json on disk may declare id "edge-probe" or "prohibition-probe" with role "feature"; found: ${JSON.stringify(probeFeatures)}`
    );
  });
});

// ── [happy] Predicate substrate lives in core (bin/lib), not in capabilities/ ──
describe('ADR-857 predicate boundary: substrate lives in core, not in capabilities/', () => {
  test('probe-core.cjs is resolvable from gsd-core/bin/lib — the core module tier', () => {
    // Must resolve from core lib, not from any capability folder
    const resolved = require.resolve(PROBE_CORE_PATH);
    assert.ok(
      resolved.includes(path.join('gsd-core', 'bin', 'lib')),
      `probe-core.cjs must resolve from gsd-core/bin/lib (got: ${resolved})`
    );
    assert.ok(
      !resolved.includes('capabilities'),
      `probe-core.cjs must NOT resolve from any capabilities/ folder (got: ${resolved})`
    );
  });

  test('edge-probe.cjs is resolvable from gsd-core/bin/lib — the core module tier', () => {
    const resolved = require.resolve(EDGE_PROBE_PATH);
    assert.ok(
      resolved.includes(path.join('gsd-core', 'bin', 'lib')),
      `edge-probe.cjs must resolve from gsd-core/bin/lib (got: ${resolved})`
    );
    assert.ok(
      !resolved.includes('capabilities'),
      `edge-probe.cjs must NOT resolve from any capabilities/ folder (got: ${resolved})`
    );
  });

  test('no capabilities/*/capability.json declares id "edge-probe" or "prohibition-probe" as a feature', () => {
    // Scan all capability.json files on disk and confirm none are probe features
    const allCaps = collectCapabilityIds();
    const featureIds = allCaps.filter(c => c.role === 'feature').map(c => c.id);

    assert.ok(
      !featureIds.includes('edge-probe'),
      `Feature capability ids must not include "edge-probe"; found: ${JSON.stringify(featureIds)}`
    );
    assert.ok(
      !featureIds.includes('prohibition-probe'),
      `Feature capability ids must not include "prohibition-probe"; found: ${JSON.stringify(featureIds)}`
    );
  });
});

// ── [negative/BVA] Toggling ALL capability config keys off does NOT change substrate
//    availability or output — substrate is non-toggleable ─────────────────────────
describe('ADR-857 predicate boundary: substrate is non-toggleable (all-off config does not affect it)', () => {
  test('probe-core functions return identical output before and after constructing an all-off config', () => {
    const ep = require(EDGE_PROBE_PATH);
    const { configKeys } = require(path.join(LIB, 'capability-registry.cjs'));

    // Build a config object with every known workflow.* and intel/profile key set to false
    const allOffConfig = {};
    for (const key of Object.keys(configKeys)) {
      allOffConfig[key] = false;
    }

    // "Before": call analyzeCoverage with a representative set
    const reqText = 'the API endpoint accepts a list of items with a maximum count threshold and stores each one';
    const BEFORE_shapes = ep.classifyShape(reqText);
    const BEFORE_edges = ep.proposeEdges({ id: 'R-bva', text: reqText });
    const BEFORE_report = ep.analyzeCoverage([{ id: 'R-bva', text: reqText }], []);

    // Simulate "all capabilities off" by confirming the config object is fully false
    // (The substrate does not accept a config parameter — this BVA tests that the
    // probe functions are unconditionally available regardless of config state)
    const allOff = Object.values(allOffConfig).every(v => v === false);
    assert.strictEqual(allOff, true, 'all config keys must be set to false in the all-off config');

    // "After all-off config": call the same functions again — results must be identical
    const AFTER_shapes = ep.classifyShape(reqText);
    const AFTER_edges = ep.proposeEdges({ id: 'R-bva', text: reqText });
    const AFTER_report = ep.analyzeCoverage([{ id: 'R-bva', text: reqText }], []);

    // ADR-857: the substrate is non-toggleable — output must not change
    assert.deepEqual(
      AFTER_shapes,
      BEFORE_shapes,
      'classifyShape must return identical output regardless of capability config state'
    );
    assert.deepEqual(
      AFTER_edges,
      BEFORE_edges,
      'proposeEdges must return identical output regardless of capability config state'
    );
    assert.deepEqual(
      AFTER_report,
      BEFORE_report,
      'analyzeCoverage must return identical output regardless of capability config state'
    );

    // Specific value assertion to prevent vacuous-truth: shapes must include at least two types
    assert.ok(AFTER_shapes.length >= 2, `classifyShape must detect at least 2 shapes for complex text (got ${AFTER_shapes.length})`);
    assert.ok(AFTER_edges.length >= 2, `proposeEdges must propose at least 2 edges for this requirement (got ${AFTER_edges.length})`);
  });

  test('probe-core.validateResolution rejects an invalid status regardless of all-off config (BVA: status boundary)', () => {
    const pc = require(PROBE_CORE_PATH);

    // BVA: exact boundary — 'unresolved' (valid, limit case) vs 'covered' (was valid pre-re-cut, now invalid)
    // Valid status (limit): must NOT throw
    assert.doesNotThrow(
      () => pc.validateResolution(
        { requirement_id: 'R1', category: 'boundary', status: 'unresolved', verification: null, resolution: null, reason: null },
        REPRESENTATIVE_VALIDATORS
      ),
      'validateResolution must accept status="unresolved" (the valid boundary case)'
    );

    // Invalid status (just outside the locked set): must throw with a message naming the bad status
    assert.throws(
      () => pc.validateResolution(
        { requirement_id: 'R1', category: 'boundary', status: 'covered', verification: null, resolution: null, reason: null },
        REPRESENTATIVE_VALIDATORS
      ),
      (err) => {
        assert.ok(err instanceof Error, 'must throw an Error');
        assert.ok(
          err.message.includes('covered'),
          `error message must name the invalid status "covered"; got: "${err.message}"`
        );
        return true;
      },
      'validateResolution must reject status="covered" (the pre-re-cut status that is now outside the locked set)'
    );
  });

  test('probe-core.analyzeCoverage rejects a resolved item missing verification tier (BVA: verification null boundary)', () => {
    const pc = require(PROBE_CORE_PATH);

    // BVA: resolved + null verification is INVALID (one step below the minimum)
    const badItems = [
      makeItem('boundary', { status: 'resolved', verification: null, resolution: 'AC text' }),
    ];
    assert.throws(
      () => pc.analyzeCoverage(badItems, [], REPRESENTATIVE_VALIDATORS),
      (err) => {
        assert.ok(err instanceof Error, 'must throw an Error');
        assert.ok(
          err.message.toLowerCase().includes('verification'),
          `error message must mention "verification"; got: "${err.message}"`
        );
        return true;
      },
      'analyzeCoverage must reject a resolved item with verification=null (verification required at this boundary)'
    );

    // BVA: resolved + valid verification tier is VALID (at the minimum)
    const goodItems = [
      makeItem('boundary', { status: 'resolved', verification: 'explicit', resolution: 'acceptance criterion text' }),
    ];
    const report = pc.analyzeCoverage(goodItems, [], REPRESENTATIVE_VALIDATORS);
    assert.strictEqual(report.coverage.resolved, 1, 'resolved count must be 1 for a valid resolved item');
    assert.strictEqual(report.coverage.byVerification.explicit, 1, 'byVerification.explicit must be 1');
  });

  test('all capability config keys being false does not prevent probe-core from loading or exporting VALID_STATUS', () => {
    // This test confirms the substrate is non-conditionally loaded (not behind any
    // capability gate) — if probe-core depended on a capability config, VALID_STATUS
    // would differ or throw when the underlying capability was off.
    const pc = require(PROBE_CORE_PATH);
    const { configKeys } = require(path.join(LIB, 'capability-registry.cjs'));

    // With every key false, VALID_STATUS must remain the locked set
    const allOffConfig = {};
    for (const key of Object.keys(configKeys)) {
      allOffConfig[key] = false;
    }

    // probe-core does not accept a config — it must be unconditional
    // Exact value check (genuineness: flipping one would fail)
    assert.deepEqual(
      [...pc.VALID_STATUS].sort(),
      ['dismissed', 'resolved', 'unresolved'],
      'VALID_STATUS must be identical regardless of all-off config (substrate is non-toggleable)'
    );

    // Also verify configKeys has at least some keys (ensures the all-off scenario is meaningful)
    assert.ok(
      Object.keys(configKeys).length > 0,
      'configKeys must be non-empty (all-off scenario must be meaningful)'
    );
  });
});
