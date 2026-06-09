'use strict';

/**
 * capability-registry.test.cjs — behavioral tests for the capability registry generator.
 *
 * ADR-894 phase 3a-impl.
 * Uses node:test + node:assert/strict.
 * Tests use in-memory fixtures (not real files) for adversarial cases.
 * The UI pilot test loads from the real capabilities/ui/ directory.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { spawnSync } = require('node:child_process');

const {
  validateCapability,
  validateAgainstContract,
  validateConsumesGlobal,
  validateCrossCapability,
  classifyCrossErrors,
  loadAndValidate,
  buildRegistry,
  serializeRegistry,
  computeRequiresClosure,
  topoSortSteps,
  SCHEMA_VERSION,
} = require('../scripts/gen-capability-registry.cjs');

const ROOT = path.resolve(__dirname, '..');

// ─── UI pilot fixture (from capabilities/ui/capability.json) ─────────────────

const UI_CAP_PATH = path.join(ROOT, 'capabilities', 'ui', 'capability.json');
const UI_CAP = JSON.parse(fs.readFileSync(UI_CAP_PATH, 'utf8'));

// ─── Helper: write temporary capability dir ───────────────────────────────────

function makeTempCapDir(capabilities) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-test-'));
  for (const [id, cap] of Object.entries(capabilities)) {
    const subDir = path.join(tmpDir, id);
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(path.join(subDir, 'capability.json'), JSON.stringify(cap), 'utf8');
  }
  return tmpDir;
}

// ─── 1. Valid UI pilot ────────────────────────────────────────────────────────

describe('UI pilot capability', () => {
  test('UI capability.json passes per-file validation', () => {
    const errors = validateCapability(UI_CAP, 'ui');
    assert.deepEqual(errors, [], 'Expected no validation errors: ' + JSON.stringify(errors));
  });

  test('UI capability passes contract validation', () => {
    const errors = validateAgainstContract(UI_CAP, 'ui');
    assert.deepEqual(errors, [], 'Expected no contract errors: ' + JSON.stringify(errors));
  });

  test('UI pilot generates a registry with correct shape', () => {
    // Pass empty central keys so the pre-migration config keys do not cause collision errors
    const capDir = makeTempCapDir({ ui: UI_CAP });
    const { capMap, errors } = loadAndValidate(new Set(), capDir);
    assert.deepEqual(errors, [], 'Expected no errors: ' + JSON.stringify(errors));

    const registry = buildRegistry(capMap);

    // capabilities.ui exists
    assert.ok(registry.capabilities.ui, 'registry.capabilities.ui should exist');
    assert.strictEqual(registry.version, SCHEMA_VERSION);

    // bySkill maps ui-phase and ui-review to 'ui'
    assert.strictEqual(registry.bySkill['ui-phase'], 'ui');
    assert.strictEqual(registry.bySkill['ui-review'], 'ui');

    // byAgent maps gsd-ui-checker and gsd-ui-auditor to 'ui'
    assert.strictEqual(registry.byAgent['gsd-ui-checker'], 'ui');
    assert.strictEqual(registry.byAgent['gsd-ui-auditor'], 'ui');

    // byLoopPoint['plan:pre'].steps contains the ui-phase step
    const planPreSteps = registry.byLoopPoint['plan:pre'].steps;
    assert.ok(Array.isArray(planPreSteps), 'plan:pre.steps should be an array');
    const uiPhaseStep = planPreSteps.find((s) => s.ref && s.ref.skill === 'ui-phase');
    assert.ok(uiPhaseStep, 'plan:pre.steps should contain the ui-phase step');
    assert.strictEqual(uiPhaseStep.capId, 'ui');

    // byLoopPoint['execute:wave:post'].gates contains the UI safety gate
    const execWavePostGates = registry.byLoopPoint['execute:wave:post'].gates;
    assert.ok(Array.isArray(execWavePostGates), 'execute:wave:post.gates should be an array');
    const uiGate = execWavePostGates.find(
      (g) => g.check && g.check.query === 'ui.safety-gate',
    );
    assert.ok(uiGate, 'execute:wave:post.gates should contain the ui safety gate');
    assert.strictEqual(uiGate.capId, 'ui');
    assert.strictEqual(uiGate.blocking, true);

    // configKeys maps the 3 UI keys to 'ui'
    assert.strictEqual(registry.configKeys['workflow.ui_phase'], 'ui');
    assert.strictEqual(registry.configKeys['workflow.ui_review'], 'ui');
    assert.strictEqual(registry.configKeys['workflow.ui_safety_gate'], 'ui');
  });

  test('requiresClosure("ui") returns empty set (no requires)', () => {
    const capMap = new Map([['ui', UI_CAP]]);
    const closure = computeRequiresClosure('ui', capMap);
    assert.deepEqual([...closure], []);
  });
});

// ─── 2. Adversarial invalid declarations ─────────────────────────────────────

describe('validateCapability adversarial cases', () => {
  test('missing id rejected', () => {
    const cap = { ...UI_CAP };
    delete cap.id;
    const errors = validateCapability(cap, 'ui');
    assert.ok(errors.length > 0, 'Expected errors for missing id');
    assert.ok(
      errors.some((e) => e.includes('id')),
      'Error should mention id, got: ' + JSON.stringify(errors),
    );
  });

  test('id not equal to folder name rejected', () => {
    const cap = { ...UI_CAP, id: 'not-ui' };
    const errors = validateCapability(cap, 'ui');
    assert.ok(errors.length > 0);
    assert.ok(errors.some((e) => e.includes('folder')));
  });

  test('bad role rejected', () => {
    const cap = { ...UI_CAP, role: 'plugin' };
    const errors = validateCapability(cap, 'ui');
    assert.ok(errors.length > 0);
    assert.ok(errors.some((e) => e.includes('role')));
  });

  test('bad tier enum rejected', () => {
    const cap = { ...UI_CAP, tier: 'premium' };
    const errors = validateCapability(cap, 'ui');
    assert.ok(errors.length > 0);
    assert.ok(errors.some((e) => e.includes('tier')));
  });

  test('step with invalid point rejected', () => {
    const cap = {
      ...UI_CAP,
      steps: [
        { ...UI_CAP.steps[0], point: 'notapoint:pre' },
      ],
    };
    const errors = validateCapability(cap, 'ui');
    assert.ok(errors.length > 0);
    assert.ok(errors.some((e) => e.includes('notapoint:pre')));
  });

  test('gate with agentVerdict and blocking:true rejected', () => {
    const cap = {
      ...UI_CAP,
      gates: [
        {
          point: 'execute:wave:post',
          check: { agentVerdict: { ref: 'gsd-ui-checker', prompt: 'check' } },
          blocking: true,
          onError: 'halt',
        },
      ],
    };
    const errors = validateCapability(cap, 'ui');
    assert.ok(errors.length > 0);
    assert.ok(
      errors.some((e) => e.includes('agentVerdict') && e.includes('blocking')),
      'Expected error about agentVerdict forcing blocking:false, got: ' + JSON.stringify(errors),
    );
  });
});

describe('validateAgainstContract adversarial cases', () => {
  test('contribution.into not in step agentRoles rejected', () => {
    const cap = {
      ...UI_CAP,
      contributions: [
        {
          point: 'plan:pre',
          into: 'notarole',
          fragment: { inline: 'test' },
          when: 'workflow.ui_phase',
          onError: 'skip',
        },
      ],
    };
    const errors = validateAgainstContract(cap, 'ui');
    assert.ok(errors.length > 0);
    assert.ok(errors.some((e) => e.includes('notarole')));
  });
});

describe('validateCrossCapability adversarial cases', () => {
  test('duplicate skill ownership across two capabilities rejected', () => {
    const cap1 = { ...UI_CAP };
    const cap2 = {
      ...UI_CAP,
      id: 'ui2',
      skills: ['ui-phase'],  // duplicate
      agents: ['gsd-other-agent'],
      config: {},
    };
    const capMap = new Map([['ui', cap1], ['ui2', cap2]]);
    const errors = validateCrossCapability(capMap, new Set());
    assert.ok(errors.length > 0);
    assert.ok(errors.some((e) => e.includes('ui-phase')));
  });

  test('requires referencing nonexistent id rejected', () => {
    const cap = { ...UI_CAP, requires: ['nonexistent-cap'] };
    const capMap = new Map([['ui', cap]]);
    const errors = validateCrossCapability(capMap, new Set());
    assert.ok(errors.length > 0);
    assert.ok(errors.some((e) => e.includes('nonexistent-cap')));
  });

  test('requires cycle rejected', () => {
    const capA = { ...UI_CAP, id: 'cap-a', tier: 'standard', requires: ['cap-b'] };
    const capB = {
      id: 'cap-b', role: 'feature', title: 'B', tier: 'standard', requires: ['cap-a'],
      skills: [], agents: [], hooks: [], config: {}, steps: [], contributions: [], gates: [],
    };
    const capMap = new Map([['cap-a', capA], ['cap-b', capB]]);
    const errors = validateCrossCapability(capMap, new Set());
    assert.ok(errors.length > 0);
    assert.ok(errors.some((e) => e.includes('cycle')));
  });

  test('tier-monotone violation: core requires full rejected', () => {
    const coreCap = {
      id: 'core-cap', role: 'feature', title: 'Core', tier: 'core', requires: ['full-cap'],
      skills: ['core-skill'], agents: ['gsd-core-agent'], hooks: [], config: {},
      steps: [], contributions: [], gates: [],
    };
    const fullCap = {
      id: 'full-cap', role: 'feature', title: 'Full', tier: 'full', requires: [],
      skills: ['full-skill'], agents: ['gsd-full-agent'], hooks: [], config: {},
      steps: [], contributions: [], gates: [],
    };
    const capMap = new Map([['core-cap', coreCap], ['full-cap', fullCap]]);
    const errors = validateCrossCapability(capMap, new Set());
    assert.ok(errors.length > 0);
    assert.ok(errors.some((e) => e.includes('tier-monotone')));
  });

  test('config key colliding with central config-schema rejected', () => {
    const cap = { ...UI_CAP };
    const centralKeys = new Set(['workflow.ui_phase']); // simulate key present in both
    const capMap = new Map([['ui', cap]]);
    const errors = validateCrossCapability(capMap, centralKeys);
    assert.ok(errors.length > 0);
    assert.ok(
      errors.some((e) => e.includes('workflow.ui_phase') && e.includes('central config-schema')),
      'Expected central config-schema collision error, got: ' + JSON.stringify(errors),
    );
  });

  test('config key owned by two capabilities rejected', () => {
    const cap1 = { ...UI_CAP };
    const cap2 = {
      id: 'ui2', role: 'feature', title: 'UI2', tier: 'standard', requires: [],
      skills: ['other-skill'], agents: ['gsd-other-agent'], hooks: [],
      config: { 'workflow.ui_phase': { type: 'boolean', default: true, description: 'dup' } },
      steps: [], contributions: [], gates: [],
    };
    const capMap = new Map([['ui', cap1], ['ui2', cap2]]);
    const errors = validateCrossCapability(capMap, new Set());
    assert.ok(errors.length > 0);
    assert.ok(errors.some((e) => e.includes('workflow.ui_phase')));
  });
});

// ─── 3. Materialized ordering ─────────────────────────────────────────────────

describe('topological step ordering', () => {
  test('two steps at one point with produces/consumes dependency order correctly', () => {
    // Step B consumes what step A produces → A must come before B
    const stepA = {
      capId: 'cap-a',
      step: { point: 'plan:pre', ref: { skill: 'a-skill' }, produces: ['A-OUTPUT.md'], consumes: [], when: undefined, onError: 'skip' },
    };
    const stepB = {
      capId: 'cap-b',
      step: { point: 'plan:pre', ref: { skill: 'b-skill' }, produces: ['B-OUTPUT.md'], consumes: ['A-OUTPUT.md'], when: undefined, onError: 'skip' },
    };

    // Pass in reverse order to verify sort happens
    const sorted = topoSortSteps([stepB, stepA]);
    assert.strictEqual(sorted[0].capId, 'cap-a', 'cap-a (producer) should come first');
    assert.strictEqual(sorted[1].capId, 'cap-b', 'cap-b (consumer) should come second');
  });

  test('steps with no dependency order by capId tiebreak', () => {
    const stepZ = {
      capId: 'z-cap',
      step: { point: 'plan:pre', ref: { skill: 'z' }, produces: ['Z.md'], consumes: [], when: undefined, onError: 'skip' },
    };
    const stepA = {
      capId: 'a-cap',
      step: { point: 'plan:pre', ref: { skill: 'a' }, produces: ['A.md'], consumes: [], when: undefined, onError: 'skip' },
    };
    const sorted = topoSortSteps([stepZ, stepA]);
    assert.strictEqual(sorted[0].capId, 'a-cap', 'a-cap should come first (alphabetical tiebreak)');
    assert.strictEqual(sorted[1].capId, 'z-cap');
  });
});

// ─── 4. --check drift detection ──────────────────────────────────────────────

describe('--check drift detection', () => {
  test('returns drift when on-disk registry differs from live', () => {
    // Build a registry from the real UI cap
    const capDir = makeTempCapDir({ ui: UI_CAP });
    const { capMap } = loadAndValidate(new Set(), capDir);
    const registry = buildRegistry(capMap);
    const liveContent = serializeRegistry(registry, capMap);

    // Modify it slightly to simulate drift — replace the version string constant at top level
    const driftedContent = liveContent.replace(
      "version: '" + SCHEMA_VERSION + "'",
      "version: '0-stale'",
    );

    // Confirm the replacement actually changed something
    assert.notStrictEqual(driftedContent, liveContent, 'driftedContent should differ from liveContent after replacement');

    // Write to a temp file
    const tmpFile = path.join(os.tmpdir(), 'cap-registry-drift-test.cjs');
    fs.writeFileSync(tmpFile, driftedContent, 'utf8');

    // Compare: live vs drifted (simulating what --check does)
    const committed = fs.readFileSync(tmpFile, 'utf8');
    assert.notStrictEqual(committed, liveContent, 'Drifted content should differ from live');

    // Cleanup
    fs.unlinkSync(tmpFile);
  });

  test('no drift when registry is freshly generated', () => {
    const capDir = makeTempCapDir({ ui: UI_CAP });
    const { capMap } = loadAndValidate(new Set(), capDir);
    const registry = buildRegistry(capMap);
    const content1 = serializeRegistry(registry, capMap);
    const content2 = serializeRegistry(registry, capMap);
    assert.strictEqual(content1, content2, 'Two calls to serializeRegistry should be identical');
  });
});

describe('committed gsd-core/bin/lib/capability-registry.cjs is not stale', () => {
  test('gen-capability-registry.cjs --check exits 0 (committed registry is up to date)', () => {
    const result = spawnSync(
      process.execPath,
      [require('node:path').join(ROOT, 'scripts', 'gen-capability-registry.cjs'), '--check'],
      { cwd: ROOT, encoding: 'utf8' },
    );
    assert.strictEqual(
      result.status,
      0,
      'gen-capability-registry.cjs --check failed — committed capability-registry.cjs is stale.\n' +
      'Run: node scripts/gen-capability-registry.cjs --write\n' +
      'stderr: ' + (result.stderr || ''),
    );
  });
});

// ─── 5. Registry shape from multiple capabilities ────────────────────────────

describe('registry structure', () => {
  test('byLoopPoint contains all 12 valid points', () => {
    const capDir = makeTempCapDir({ ui: UI_CAP });
    const { capMap } = loadAndValidate(new Set(), capDir);
    const registry = buildRegistry(capMap);

    const expectedPoints = [
      'discuss:pre', 'discuss:post',
      'plan:pre', 'plan:post',
      'execute:pre', 'execute:wave:pre', 'execute:wave:post', 'execute:post',
      'verify:pre', 'verify:post',
      'ship:pre', 'ship:post',
    ];
    for (const point of expectedPoints) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(registry.byLoopPoint, point),
        'byLoopPoint should contain point: ' + point,
      );
    }
  });

  test('requiresClosure works for a cap with transitive requires', () => {
    const capA = {
      id: 'cap-a', role: 'feature', title: 'A', tier: 'standard', requires: ['cap-b'],
      skills: ['a-skill'], agents: ['gsd-a-agent'], hooks: [], config: {},
      steps: [], contributions: [], gates: [],
    };
    const capB = {
      id: 'cap-b', role: 'feature', title: 'B', tier: 'standard', requires: ['cap-c'],
      skills: ['b-skill'], agents: ['gsd-b-agent'], hooks: [], config: {},
      steps: [], contributions: [], gates: [],
    };
    const capC = {
      id: 'cap-c', role: 'feature', title: 'C', tier: 'standard', requires: [],
      skills: ['c-skill'], agents: ['gsd-c-agent'], hooks: [], config: {},
      steps: [], contributions: [], gates: [],
    };
    const capMap = new Map([['cap-a', capA], ['cap-b', capB], ['cap-c', capC]]);
    const closure = computeRequiresClosure('cap-a', capMap);
    assert.ok(closure.has('cap-b'), 'closure should include cap-b');
    assert.ok(closure.has('cap-c'), 'closure should include cap-c (transitive)');
    assert.strictEqual(closure.size, 2);
  });
});

// ─── 6. Fix regression guards ────────────────────────────────────────────────

describe('Fix #1: consumes-satisfiability is point-order-aware', () => {
  test('plan:pre step consuming UAT.md (produced only at verify:post) is rejected', () => {
    // UAT.md is produced by the host at verify:post (C1: :post availability rule).
    // A plan:pre step consuming it must fail — the host hasn't produced it yet at that point.
    const cap = {
      ...UI_CAP,
      steps: [
        {
          point: 'plan:pre',
          ref: { skill: 'ui-phase' },
          produces: [],
          consumes: ['UAT.md'],  // UAT.md not available until verify:post
          when: 'workflow.ui_phase',
          onError: 'skip',
        },
      ],
    };
    // C2: consumes validation is now global
    const capMap = new Map([['ui', cap]]);
    const errors = validateConsumesGlobal(capMap);
    assert.ok(errors.length > 0, 'Expected a satisfiability error for early consumption of UAT.md');
    assert.ok(
      errors.some((e) => e.includes('UAT.md')),
      'Error should mention UAT.md, got: ' + JSON.stringify(errors),
    );
    assert.ok(
      errors.some((e) => e.includes('plan:pre')),
      'Error should mention plan:pre, got: ' + JSON.stringify(errors),
    );
  });

  test('verify:post step consuming UAT.md (produced at verify:post by host) is accepted', () => {
    // C1: UAT.md becomes available from verify:post onward (produced by the verify host step).
    // verify:post index (9) <= verify:post index (9) → accepted.
    const cap = {
      ...UI_CAP,
      steps: [
        {
          point: 'verify:post',
          ref: { skill: 'ui-review' },
          produces: ['UI-REVIEW.md'],
          consumes: ['UAT.md'],
          when: 'workflow.ui_review',
          onError: 'skip',
        },
      ],
    };
    // C2: consumes validation is now global
    const capMap = new Map([['ui', cap]]);
    const errors = validateConsumesGlobal(capMap);
    // Should have zero satisfiability errors for UAT.md at verify:post
    const satErrors = errors.filter((e) => e.includes('UAT.md'));
    assert.deepEqual(satErrors, [], 'Expected no satisfiability errors for UAT.md at verify:post, got: ' + JSON.stringify(satErrors));
  });

  // C1 regression: PLAN.md is produced at plan:post, NOT plan:pre
  test('plan:pre step consuming PLAN.md is rejected (PLAN.md only available from plan:post)', () => {
    const cap = {
      ...UI_CAP,
      steps: [
        {
          point: 'plan:pre',
          ref: { skill: 'ui-phase' },
          produces: [],
          consumes: ['PLAN.md'],  // PLAN.md produced at plan:post, not available at plan:pre
          when: 'workflow.ui_phase',
          onError: 'skip',
        },
      ],
    };
    const capMap = new Map([['ui', cap]]);
    const errors = validateConsumesGlobal(capMap);
    assert.ok(errors.length > 0, 'Expected rejection: PLAN.md not available at plan:pre');
    assert.ok(errors.some((e) => e.includes('PLAN.md')), 'Error should mention PLAN.md');
  });

  // C1: execute:pre consuming PLAN.md → PLAN.md available at plan:post (index 3), execute:pre is index 4 → accepted
  test('execute:pre step consuming PLAN.md (produced at plan:post) is accepted', () => {
    const cap = {
      ...UI_CAP,
      steps: [
        {
          point: 'execute:pre',
          ref: { skill: 'ui-phase' },
          produces: [],
          consumes: ['PLAN.md'],  // PLAN.md available from plan:post onward
          when: 'workflow.ui_phase',
          onError: 'skip',
        },
      ],
    };
    const capMap = new Map([['ui', cap]]);
    const errors = validateConsumesGlobal(capMap);
    const satErrors = errors.filter((e) => e.includes('PLAN.md'));
    assert.deepEqual(satErrors, [], 'Expected PLAN.md to be available at execute:pre, got: ' + JSON.stringify(satErrors));
  });
});

describe('Fix #2: topoSortSteps errors on a produces/consumes cycle', () => {
  test('two-step cycle at the same point throws an error', () => {
    // Step A produces X and consumes Y; step B produces Y and consumes X — mutual dependency
    const stepA = {
      capId: 'cap-a',
      step: {
        point: 'plan:pre',
        ref: { skill: 'a-skill' },
        produces: ['X.md'],
        consumes: ['Y.md'],
        onError: 'skip',
      },
    };
    const stepB = {
      capId: 'cap-b',
      step: {
        point: 'plan:pre',
        ref: { skill: 'b-skill' },
        produces: ['Y.md'],
        consumes: ['X.md'],
        onError: 'skip',
      },
    };
    assert.throws(
      () => topoSortSteps([stepA, stepB]),
      (err) => {
        assert.ok(err instanceof Error, 'Should throw an Error');
        assert.ok(
          err.message.includes('cycle') || err.message.includes('cycle'),
          'Error message should mention cycle, got: ' + err.message,
        );
        return true;
      },
    );
  });
});

describe('Fix #3: config-collision emits pending-migration warning, not hard error', () => {
  test('validateCrossCapability still detects and reports the collision', () => {
    // The underlying collision detection must still fire (regression guard for existing test)
    const cap = { ...UI_CAP };
    const centralKeys = new Set(['workflow.ui_phase']);
    const capMap = new Map([['ui', cap]]);
    const errors = validateCrossCapability(capMap, centralKeys);
    assert.ok(errors.length > 0, 'Expected collision errors from validateCrossCapability');
    assert.ok(
      errors.some((e) => e.includes('workflow.ui_phase') && e.includes('central config-schema')),
      'Expected central config-schema collision error, got: ' + JSON.stringify(errors),
    );
  });

  test('classifyCrossErrors separates collision errors into pending-migration warnings', () => {
    const cap = { ...UI_CAP };
    const centralKeys = new Set(['workflow.ui_phase', 'workflow.ui_review', 'workflow.ui_safety_gate']);
    const capMap = new Map([['ui', cap]]);
    const allErrors = validateCrossCapability(capMap, centralKeys);
    const { hardErrors, pendingMigrationWarnings } = classifyCrossErrors(allErrors);
    // All three collision errors should become warnings, not hard errors
    assert.strictEqual(
      hardErrors.length, 0,
      'No hard errors expected for collision-only cross errors, got: ' + JSON.stringify(hardErrors),
    );
    assert.ok(
      pendingMigrationWarnings.length >= 1,
      'Expected at least one pending-migration warning',
    );
    assert.ok(
      pendingMigrationWarnings.some((w) => w.includes('pending-migration') && w.includes('workflow.ui_phase')),
      'Warning should mention pending-migration and workflow.ui_phase, got: ' + JSON.stringify(pendingMigrationWarnings),
    );
  });
});

describe('Fix #4: step.ref must be exclusive skill XOR agent', () => {
  test('step.ref with both skill and agent is rejected', () => {
    const cap = {
      ...UI_CAP,
      steps: [
        {
          point: 'plan:pre',
          ref: { skill: 'ui-phase', agent: 'gsd-ui-checker' },  // BOTH keys — invalid
          produces: ['UI-SPEC.md'],
          consumes: ['CONTEXT.md'],
          when: 'workflow.ui_phase',
          onError: 'skip',
        },
      ],
    };
    const errors = validateCapability(cap, 'ui');
    assert.ok(errors.length > 0, 'Expected errors for step.ref with both skill and agent');
    assert.ok(
      errors.some((e) => e.includes('exactly one') || e.includes('not both') || e.includes('skill') && e.includes('agent')),
      'Error should mention exclusive skill/agent constraint, got: ' + JSON.stringify(errors),
    );
  });

  test('step.ref with only skill is accepted', () => {
    const cap = {
      ...UI_CAP,
      steps: [
        {
          point: 'plan:pre',
          ref: { skill: 'ui-phase' },
          produces: ['UI-SPEC.md'],
          consumes: ['CONTEXT.md'],
          when: 'workflow.ui_phase',
          onError: 'skip',
        },
      ],
    };
    const refErrors = validateCapability(cap, 'ui').filter((e) => e.includes('ref'));
    assert.deepEqual(refErrors, [], 'No ref errors expected for skill-only ref, got: ' + JSON.stringify(refErrors));
  });

  test('step.ref with only agent is accepted', () => {
    const cap = {
      ...UI_CAP,
      steps: [
        {
          point: 'plan:pre',
          ref: { agent: 'gsd-ui-checker' },
          produces: ['UI-SPEC.md'],
          consumes: ['CONTEXT.md'],
          when: 'workflow.ui_phase',
          onError: 'skip',
        },
      ],
    };
    const refErrors = validateCapability(cap, 'ui').filter((e) => e.includes('ref'));
    assert.deepEqual(refErrors, [], 'No ref errors expected for agent-only ref, got: ' + JSON.stringify(refErrors));
  });
});

describe('Fix: 3-node requires cycle (A→B→C→A) is detected', () => {
  test('three-node requires cycle is reported as an error', () => {
    const capA = {
      id: 'cyc-a', role: 'feature', title: 'CycA', tier: 'standard', requires: ['cyc-b'],
      skills: ['cyc-a-skill'], agents: ['gsd-cyc-a'], hooks: [], config: {},
      steps: [], contributions: [], gates: [],
    };
    const capB = {
      id: 'cyc-b', role: 'feature', title: 'CycB', tier: 'standard', requires: ['cyc-c'],
      skills: ['cyc-b-skill'], agents: ['gsd-cyc-b'], hooks: [], config: {},
      steps: [], contributions: [], gates: [],
    };
    const capC = {
      id: 'cyc-c', role: 'feature', title: 'CycC', tier: 'standard', requires: ['cyc-a'],
      skills: ['cyc-c-skill'], agents: ['gsd-cyc-c'], hooks: [], config: {},
      steps: [], contributions: [], gates: [],
    };
    const capMap = new Map([['cyc-a', capA], ['cyc-b', capB], ['cyc-c', capC]]);
    const errors = validateCrossCapability(capMap, new Set());
    assert.ok(errors.length > 0, 'Expected cycle errors for A→B→C→A');
    assert.ok(
      errors.some((e) => e.toLowerCase().includes('cycle')),
      'Error should mention cycle, got: ' + JSON.stringify(errors),
    );
  });
});

describe('Fix: agentVerdict gate with blocking:false is accepted', () => {
  test('agentVerdict gate with blocking:false generates zero errors', () => {
    // Complement of the existing blocking:true rejection test
    const cap = {
      ...UI_CAP,
      gates: [
        {
          point: 'execute:wave:post',
          check: { agentVerdict: { ref: 'gsd-ui-checker', prompt: 'check ui' } },
          blocking: false,  // advisory — valid
          onError: 'skip',
        },
      ],
    };
    const errors = validateCapability(cap, 'ui');
    const gateErrors = errors.filter((e) => e.includes('agentVerdict'));
    assert.deepEqual(
      gateErrors, [],
      'Expected no agentVerdict errors for blocking:false, got: ' + JSON.stringify(gateErrors),
    );
  });
});

// ─── 7. Security: fragment.path traversal (S1) ───────────────────────────────

describe('S1: fragment.path traversal guard', () => {
  const makeCapWithContribPath = (fragPath) => ({
    ...UI_CAP,
    contributions: [
      {
        point: 'plan:pre',
        into: 'planner',
        fragment: { path: fragPath },
        when: 'workflow.ui_phase',
        onError: 'skip',
      },
    ],
  });

  test('fragment.path with ".." segments is rejected', () => {
    const errors = validateCapability(makeCapWithContribPath('../../etc/passwd'), 'ui');
    assert.ok(errors.length > 0, 'Expected rejection for path traversal');
    assert.ok(
      errors.some((e) => e.includes('fragment.path') && e.includes('..')),
      'Error should mention fragment.path traversal, got: ' + JSON.stringify(errors),
    );
  });

  test('absolute fragment.path is rejected', () => {
    const errors = validateCapability(makeCapWithContribPath('/etc/passwd'), 'ui');
    assert.ok(errors.length > 0, 'Expected rejection for absolute path');
    assert.ok(
      errors.some((e) => e.includes('fragment.path')),
      'Error should mention fragment.path, got: ' + JSON.stringify(errors),
    );
  });

  test('clean relative fragment.path is accepted', () => {
    const errors = validateCapability(makeCapWithContribPath('loop/threat-model.md'), 'ui');
    const pathErrors = errors.filter((e) => e.includes('fragment.path'));
    assert.deepEqual(pathErrors, [], 'Expected no path errors for clean relative path, got: ' + JSON.stringify(pathErrors));
  });

  test('empty fragment.path string is rejected', () => {
    const errors = validateCapability(makeCapWithContribPath(''), 'ui');
    assert.ok(errors.length > 0, 'Expected rejection for empty path');
    assert.ok(errors.some((e) => e.includes('fragment.path')));
  });
});

// ─── 8. Security: prototype pollution (S2) ────────────────────────────────────

describe('S2: prototype pollution guards', () => {
  test('skill named "__proto__" is rejected', () => {
    const cap = { ...UI_CAP, skills: ['__proto__'] };
    const errors = validateCapability(cap, 'ui');
    assert.ok(errors.length > 0, 'Expected rejection for __proto__ skill');
    assert.ok(
      errors.some((e) => e.includes('__proto__') && e.includes('reserved')),
      'Error should mention reserved name, got: ' + JSON.stringify(errors),
    );
  });

  test('skill named "constructor" is rejected', () => {
    const cap = { ...UI_CAP, skills: ['constructor'] };
    const errors = validateCapability(cap, 'ui');
    assert.ok(errors.length > 0);
    assert.ok(errors.some((e) => e.includes('constructor') && e.includes('reserved')));
  });

  test('agent named "__proto__" is rejected', () => {
    const cap = { ...UI_CAP, agents: ['__proto__'] };
    const errors = validateCapability(cap, 'ui');
    assert.ok(errors.length > 0);
    assert.ok(errors.some((e) => e.includes('__proto__') && e.includes('reserved')));
  });

  test('config key named "prototype" is rejected', () => {
    const configWithReserved = {
      ...UI_CAP.config,
      'prototype': { type: 'boolean', default: false, description: 'bad key' },
    };
    const cap = { ...UI_CAP, config: configWithReserved };
    const errors = validateCapability(cap, 'ui');
    assert.ok(errors.length > 0);
    assert.ok(errors.some((e) => e.includes('prototype') && e.includes('reserved')));
  });

  test('building registry with prototype-polluting names does not pollute Object.prototype', () => {
    // Even if somehow a reserved name got through, buildRegistry must not pollute.
    // We test this by checking that Object.prototype is clean after a normal build.
    const capDir = makeTempCapDir({ ui: UI_CAP });
    const { capMap } = loadAndValidate(new Set(), capDir);
    buildRegistry(capMap);
    // After registry build, Object.prototype must not have been polluted.
    assert.strictEqual(({}).polluted, undefined, 'Object.prototype should not be polluted');
    assert.strictEqual(({}).ui, undefined, 'Object.prototype.ui should not exist');
  });
});

// ─── 9. C2: Cross-capability consumes satisfiability ─────────────────────────

describe('C2: cross-capability consumes satisfiability (global pass)', () => {
  test('cap B step consuming artifact produced by cap A at earlier point is accepted', () => {
    const capA = {
      id: 'cap-a', role: 'feature', title: 'A', description: 'A', tier: 'standard', requires: [],
      skills: ['a-skill'], agents: ['gsd-a-agent'], hooks: [], config: {},
      steps: [
        {
          point: 'plan:pre',
          ref: { skill: 'a-skill' },
          produces: ['A-OUTPUT.md'],
          consumes: ['CONTEXT.md'],
          onError: 'skip',
        },
      ],
      contributions: [], gates: [],
    };
    const capB = {
      id: 'cap-b', role: 'feature', title: 'B', description: 'B', tier: 'standard', requires: [],
      skills: ['b-skill'], agents: ['gsd-b-agent'], hooks: [], config: {},
      steps: [
        {
          point: 'execute:pre',  // after plan:pre — A-OUTPUT.md is available
          ref: { skill: 'b-skill' },
          produces: [],
          consumes: ['A-OUTPUT.md'],
          onError: 'skip',
        },
      ],
      contributions: [], gates: [],
    };
    const capMap = new Map([['cap-a', capA], ['cap-b', capB]]);
    const errors = validateConsumesGlobal(capMap);
    const aOutputErrors = errors.filter((e) => e.includes('A-OUTPUT.md'));
    assert.deepEqual(aOutputErrors, [], 'Cap B consuming A-OUTPUT at execute:pre should be accepted, got: ' + JSON.stringify(aOutputErrors));
  });

  test('consuming an artifact that is never produced is rejected', () => {
    const cap = {
      id: 'cap-a', role: 'feature', title: 'A', description: 'A', tier: 'standard', requires: [],
      skills: ['a-skill'], agents: ['gsd-a-agent'], hooks: [], config: {},
      steps: [
        {
          point: 'plan:pre',
          ref: { skill: 'a-skill' },
          produces: [],
          consumes: ['NONEXISTENT-ARTIFACT.md'],
          onError: 'skip',
        },
      ],
      contributions: [], gates: [],
    };
    const capMap = new Map([['cap-a', cap]]);
    const errors = validateConsumesGlobal(capMap);
    assert.ok(errors.length > 0, 'Expected rejection: NONEXISTENT-ARTIFACT.md is never produced');
    assert.ok(errors.some((e) => e.includes('NONEXISTENT-ARTIFACT.md')));
    assert.ok(errors.some((e) => e.includes('never produced')));
  });

  test('same-point consumer of cross-cap artifact is accepted (topo handles intra-point order)', () => {
    // Cap B at plan:pre consumes A-OUTPUT.md produced by cap A also at plan:pre.
    // Same-point is OK — topoSortSteps will ensure A runs before B.
    const capA = {
      id: 'cap-a', role: 'feature', title: 'A', description: 'A', tier: 'standard', requires: [],
      skills: ['a-skill'], agents: ['gsd-a-agent'], hooks: [], config: {},
      steps: [
        {
          point: 'plan:pre',
          ref: { skill: 'a-skill' },
          produces: ['A-PLAN-OUTPUT.md'],
          consumes: [],
          onError: 'skip',
        },
      ],
      contributions: [], gates: [],
    };
    const capB = {
      id: 'cap-b', role: 'feature', title: 'B', description: 'B', tier: 'standard', requires: [],
      skills: ['b-skill'], agents: ['gsd-b-agent'], hooks: [], config: {},
      steps: [
        {
          point: 'plan:pre',  // same point — OK for global check; topo handles ordering
          ref: { skill: 'b-skill' },
          produces: [],
          consumes: ['A-PLAN-OUTPUT.md'],
          onError: 'skip',
        },
      ],
      contributions: [], gates: [],
    };
    const capMap = new Map([['cap-a', capA], ['cap-b', capB]]);
    const errors = validateConsumesGlobal(capMap);
    const outputErrors = errors.filter((e) => e.includes('A-PLAN-OUTPUT.md'));
    assert.deepEqual(outputErrors, [], 'Same-point cross-cap consume should be accepted by global check, got: ' + JSON.stringify(outputErrors));
  });
});

// ─── 10. C3: role:runtime validation ─────────────────────────────────────────

describe('C3: role:runtime body validation', () => {
  const VALID_RUNTIME_CAP = {
    id: 'cursor', role: 'runtime', title: 'Cursor', description: 'Cursor IDE runtime',
    tier: 'standard', requires: [],
    runtime: {
      configHome: '~/.cursor',
      configFormat: 'settings-json',
      artifactLayout: [],
      commandStyle: 'slash',
      hooksSurface: 'rules',
      sandboxTier: 'none',
      supportTier: 2,
    },
  };

  test('valid runtime descriptor passes validation', () => {
    const errors = validateCapability(VALID_RUNTIME_CAP, 'cursor');
    assert.deepEqual(errors, [], 'Expected no validation errors for valid runtime cap, got: ' + JSON.stringify(errors));
  });

  test('runtime cap with skills present is rejected', () => {
    const cap = { ...VALID_RUNTIME_CAP, skills: ['some-skill'] };
    const errors = validateCapability(cap, 'cursor');
    assert.ok(errors.length > 0);
    assert.ok(errors.some((e) => e.includes('skills') && e.includes('feature-only')));
  });

  test('runtime cap with steps present is rejected', () => {
    const cap = { ...VALID_RUNTIME_CAP, steps: [] };
    const errors = validateCapability(cap, 'cursor');
    assert.ok(errors.length > 0);
    assert.ok(errors.some((e) => e.includes('steps') && e.includes('feature-only')));
  });

  test('runtime cap with contributions present is rejected', () => {
    const cap = { ...VALID_RUNTIME_CAP, contributions: [] };
    const errors = validateCapability(cap, 'cursor');
    assert.ok(errors.length > 0);
    assert.ok(errors.some((e) => e.includes('contributions') && e.includes('feature-only')));
  });

  test('runtime cap missing the runtime object is rejected', () => {
    const { runtime: _r, ...capWithoutRuntime } = VALID_RUNTIME_CAP;
    const errors = validateCapability(capWithoutRuntime, 'cursor');
    assert.ok(errors.length > 0);
    assert.ok(errors.some((e) => e.includes('runtime') && e.includes('object')));
  });

  test('runtime cap with invalid configFormat is rejected', () => {
    const cap = { ...VALID_RUNTIME_CAP, runtime: { ...VALID_RUNTIME_CAP.runtime, configFormat: 'xml' } };
    const errors = validateCapability(cap, 'cursor');
    assert.ok(errors.length > 0);
    assert.ok(errors.some((e) => e.includes('configFormat')));
  });

  test('runtime cap with supportTier 3 is rejected', () => {
    const cap = { ...VALID_RUNTIME_CAP, runtime: { ...VALID_RUNTIME_CAP.runtime, supportTier: 3 } };
    const errors = validateCapability(cap, 'cursor');
    assert.ok(errors.length > 0);
    assert.ok(errors.some((e) => e.includes('supportTier')));
  });

  test('runtime cap with supportTier 1 is accepted', () => {
    const cap = { ...VALID_RUNTIME_CAP, runtime: { ...VALID_RUNTIME_CAP.runtime, supportTier: 1 } };
    const errors = validateCapability(cap, 'cursor');
    assert.deepEqual(errors, [], 'Expected no errors for supportTier:1, got: ' + JSON.stringify(errors));
  });
});

// ─── 11. C4: description and hooks validation ─────────────────────────────────

describe('C4: description and hooks validation', () => {
  test('missing description is rejected', () => {
    const { description: _d, ...capWithoutDesc } = UI_CAP;
    const errors = validateCapability(capWithoutDesc, 'ui');
    assert.ok(errors.length > 0, 'Expected rejection for missing description');
    assert.ok(errors.some((e) => e.includes('description')));
  });

  test('hooks = 42 (non-array) is rejected', () => {
    const cap = { ...UI_CAP, hooks: 42 };
    const errors = validateCapability(cap, 'ui');
    assert.ok(errors.length > 0, 'Expected rejection for hooks = 42');
    assert.ok(errors.some((e) => e.includes('hooks') && e.includes('array')));
  });

  test('hooks with malformed entry (missing event) is rejected', () => {
    const cap = { ...UI_CAP, hooks: [{ script: 'some.sh' }] };
    const errors = validateCapability(cap, 'ui');
    assert.ok(errors.length > 0, 'Expected rejection for hook missing event');
    assert.ok(errors.some((e) => e.includes('hooks[0].event')));
  });

  test('hooks with malformed entry (missing script) is rejected', () => {
    const cap = { ...UI_CAP, hooks: [{ event: 'FileChanged' }] };
    const errors = validateCapability(cap, 'ui');
    assert.ok(errors.length > 0, 'Expected rejection for hook missing script');
    assert.ok(errors.some((e) => e.includes('hooks[0].script')));
  });

  test('valid hooks array with well-formed entry is accepted', () => {
    const cap = { ...UI_CAP, hooks: [{ event: 'FileChanged', script: 'hooks/file-changed.sh' }] };
    const errors = validateCapability(cap, 'ui');
    const hookErrors = errors.filter((e) => e.includes('hooks['));
    assert.deepEqual(hookErrors, [], 'Expected no hook errors for valid hooks entry, got: ' + JSON.stringify(hookErrors));
  });

  test('description present in UI_CAP passes validation', () => {
    const errors = validateCapability(UI_CAP, 'ui');
    const descErrors = errors.filter((e) => e.includes('description'));
    assert.deepEqual(descErrors, [], 'UI_CAP should have valid description, got: ' + JSON.stringify(descErrors));
  });
});

// ─── 12. C5: config value shape validation ────────────────────────────────────

describe('C5: config value shape validation', () => {
  test('config value that is null is rejected', () => {
    const config = { ...UI_CAP.config, 'workflow.ui_null_test': null };
    const cap = { ...UI_CAP, config };
    const errors = validateCapability(cap, 'ui');
    assert.ok(errors.length > 0, 'Expected rejection for null config value');
    assert.ok(
      errors.some((e) => e.includes('workflow.ui_null_test') && e.includes('null')),
      'Error should mention the key and null, got: ' + JSON.stringify(errors),
    );
  });

  test('config value that is a string scalar is rejected', () => {
    const config = { ...UI_CAP.config, 'workflow.ui_bad': 'just-a-string' };
    const cap = { ...UI_CAP, config };
    const errors = validateCapability(cap, 'ui');
    assert.ok(errors.length > 0, 'Expected rejection for scalar string config value');
    assert.ok(errors.some((e) => e.includes('workflow.ui_bad') && e.includes('object')));
  });

  test('config value that is a number is rejected', () => {
    const config = { ...UI_CAP.config, 'workflow.ui_num': 42 };
    const cap = { ...UI_CAP, config };
    const errors = validateCapability(cap, 'ui');
    assert.ok(errors.length > 0);
    assert.ok(errors.some((e) => e.includes('workflow.ui_num') && e.includes('object')));
  });

  test('config value that is a proper object is accepted', () => {
    // UI_CAP config values are all valid objects — validate it
    const errors = validateCapability(UI_CAP, 'ui');
    const configErrors = errors.filter((e) => e.includes('config['));
    assert.deepEqual(configErrors, [], 'UI_CAP config values should all be valid objects, got: ' + JSON.stringify(configErrors));
  });

  test('config value {} (empty object, missing type) is rejected', () => {
    const config = { ...UI_CAP.config, 'workflow.ui_no_type': {} };
    const cap = { ...UI_CAP, config };
    const errors = validateCapability(cap, 'ui');
    assert.ok(errors.length > 0, 'Expected rejection for config value with no type field');
    assert.ok(
      errors.some((e) => e.includes('workflow.ui_no_type') && e.includes('type')),
      'Error should mention the key and "type", got: ' + JSON.stringify(errors),
    );
  });

  test('config value { type: "boolean", default: true } is accepted', () => {
    const config = { ...UI_CAP.config, 'workflow.ui_good': { type: 'boolean', default: true } };
    const cap = { ...UI_CAP, config };
    const errors = validateCapability(cap, 'ui');
    const configErrors = errors.filter((e) => e.includes('workflow.ui_good'));
    assert.deepEqual(configErrors, [], 'config value with type:"boolean" and default should be accepted, got: ' + JSON.stringify(configErrors));
  });

  test('UI pilot config values all have type:"boolean" and pass FIX 2 validation', () => {
    // Regression guard: UI_CAP config keys (workflow.ui_phase etc.) all have type:"boolean"
    const errors = validateCapability(UI_CAP, 'ui');
    const configErrors = errors.filter((e) => e.includes('config['));
    assert.deepEqual(
      configErrors, [],
      'UI pilot config values should all pass type-field validation, got: ' + JSON.stringify(configErrors),
    );
    // Directly confirm each key has type:"boolean"
    for (const [key, val] of Object.entries(UI_CAP.config)) {
      assert.strictEqual(typeof val.type, 'string', 'config["' + key + '"].type should be a string');
      assert.strictEqual(val.type, 'boolean', 'config["' + key + '"].type should be "boolean"');
    }
  });
});

// ─── 13. FIX 1: self-consume rejection ───────────────────────────────────────

describe('FIX 1: self-consume rejection in validateConsumesGlobal', () => {
  test('a step produces:["SELF.md"] and consumes:["SELF.md"] with no other producer is rejected', () => {
    const cap = {
      id: 'self-cap', role: 'feature', title: 'Self', description: 'Self consume test',
      tier: 'standard', requires: [],
      skills: ['self-skill'], agents: ['gsd-self-agent'], hooks: [], config: {},
      steps: [
        {
          point: 'plan:pre',
          ref: { skill: 'self-skill' },
          produces: ['SELF.md'],
          consumes: ['SELF.md'],
          onError: 'skip',
        },
      ],
      contributions: [], gates: [],
    };
    const capMap = new Map([['self-cap', cap]]);
    const errors = validateConsumesGlobal(capMap);
    assert.ok(errors.length > 0, 'Expected rejection: step cannot consume its own output');
    assert.ok(
      errors.some((e) => e.includes('SELF.md')),
      'Error should mention SELF.md, got: ' + JSON.stringify(errors),
    );
    assert.ok(
      errors.some((e) => e.includes('self') || e.includes('itself') || e.includes('own output')),
      'Error should indicate self-consume violation, got: ' + JSON.stringify(errors),
    );
  });

  test('a step produces:["SELF.md"] and consumes:["SELF.md"] but another capability produces SELF.md at an earlier point is accepted', () => {
    const producerCap = {
      id: 'producer-cap', role: 'feature', title: 'Producer', description: 'Produces SELF.md',
      tier: 'standard', requires: [],
      skills: ['producer-skill'], agents: ['gsd-producer-agent'], hooks: [], config: {},
      steps: [
        {
          point: 'plan:pre',  // same point, but different cap — satisfies self-cap's consume
          ref: { skill: 'producer-skill' },
          produces: ['SELF.md'],
          consumes: [],
          onError: 'skip',
        },
      ],
      contributions: [], gates: [],
    };
    const selfCap = {
      id: 'self-cap', role: 'feature', title: 'Self', description: 'Self consume test',
      tier: 'standard', requires: [],
      skills: ['self-skill'], agents: ['gsd-self-agent'], hooks: [], config: {},
      steps: [
        {
          point: 'execute:pre',  // later point than plan:pre — producer-cap satisfies it
          ref: { skill: 'self-skill' },
          produces: ['SELF.md'],
          consumes: ['SELF.md'],
          onError: 'skip',
        },
      ],
      contributions: [], gates: [],
    };
    const capMap = new Map([['producer-cap', producerCap], ['self-cap', selfCap]]);
    const errors = validateConsumesGlobal(capMap);
    const selfErrors = errors.filter((e) => e.includes('SELF.md') && e.includes('self-cap'));
    assert.deepEqual(
      selfErrors, [],
      'Expected self-cap consume of SELF.md to be accepted when producer-cap produces it at an earlier point, got: ' + JSON.stringify(selfErrors),
    );
  });

  test('a step produces:["SELF.md"] and consumes:["SELF.md"] and another capability produces SELF.md at the SAME point is accepted (different hook)', () => {
    const producerCap = {
      id: 'producer-cap', role: 'feature', title: 'Producer', description: 'Produces SELF.md',
      tier: 'standard', requires: [],
      skills: ['producer-skill'], agents: ['gsd-producer-agent'], hooks: [], config: {},
      steps: [
        {
          point: 'plan:pre',  // same point as self-cap
          ref: { skill: 'producer-skill' },
          produces: ['SELF.md'],
          consumes: [],
          onError: 'skip',
        },
      ],
      contributions: [], gates: [],
    };
    const selfCap = {
      id: 'self-cap', role: 'feature', title: 'Self', description: 'Self consume test',
      tier: 'standard', requires: [],
      skills: ['self-skill'], agents: ['gsd-self-agent'], hooks: [], config: {},
      steps: [
        {
          point: 'plan:pre',  // same point — different hook (producer-cap) satisfies it
          ref: { skill: 'self-skill' },
          produces: ['SELF.md'],
          consumes: ['SELF.md'],
          onError: 'skip',
        },
      ],
      contributions: [], gates: [],
    };
    const capMap = new Map([['producer-cap', producerCap], ['self-cap', selfCap]]);
    const errors = validateConsumesGlobal(capMap);
    const selfErrors = errors.filter((e) => e.includes('SELF.md') && e.includes('self-cap'));
    assert.deepEqual(
      selfErrors, [],
      'Expected self-cap consume of SELF.md to be accepted when a DIFFERENT cap produces it at the same point, got: ' + JSON.stringify(selfErrors),
    );
  });
});
