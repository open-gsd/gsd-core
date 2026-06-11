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
  normalizeLineEndings,
  validateConfigSliceEntry,
  VALID_CONFIG_SLICE_TYPES,
  SCHEMA_VERSION,
  // ADR-857 phase 4a
  deriveCapabilityClusters,
  deriveProfileMembership,
  runConsistencyGate,
  PROFILE_RANK,
  // ADR-959
  validateCommandEntry,
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

    // configKeys maps the 3 UI keys to 'ui' (ownership map — preserved)
    assert.strictEqual(registry.configKeys['workflow.ui_phase'], 'ui');
    assert.strictEqual(registry.configKeys['workflow.ui_review'], 'ui');
    assert.strictEqual(registry.configKeys['workflow.ui_safety_gate'], 'ui');

    // configSchema index — new in phase 3b
    assert.ok(registry.configSchema, 'registry.configSchema should exist');

    // workflow.ui_phase
    assert.ok(registry.configSchema['workflow.ui_phase'], 'configSchema should have workflow.ui_phase');
    assert.strictEqual(registry.configSchema['workflow.ui_phase'].owner, 'ui');
    assert.strictEqual(registry.configSchema['workflow.ui_phase'].type, 'boolean');
    assert.strictEqual(registry.configSchema['workflow.ui_phase'].default, true);
    assert.strictEqual(typeof registry.configSchema['workflow.ui_phase'].description, 'string');
    assert.ok(registry.configSchema['workflow.ui_phase'].description.length > 0);

    // workflow.ui_review
    assert.ok(registry.configSchema['workflow.ui_review'], 'configSchema should have workflow.ui_review');
    assert.strictEqual(registry.configSchema['workflow.ui_review'].owner, 'ui');
    assert.strictEqual(registry.configSchema['workflow.ui_review'].type, 'boolean');
    assert.strictEqual(registry.configSchema['workflow.ui_review'].default, true);

    // workflow.ui_safety_gate
    assert.ok(registry.configSchema['workflow.ui_safety_gate'], 'configSchema should have workflow.ui_safety_gate');
    assert.strictEqual(registry.configSchema['workflow.ui_safety_gate'].owner, 'ui');
    assert.strictEqual(registry.configSchema['workflow.ui_safety_gate'].type, 'boolean');
    assert.strictEqual(registry.configSchema['workflow.ui_safety_gate'].default, true);
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

// ─── 4b. normalizeLineEndings — Windows CRLF regression guard ────────────────

describe('normalizeLineEndings', () => {
  test('strips \\r so LF and CRLF content compare as equal', () => {
    const lf = 'line1\nline2\nline3\n';
    const crlf = 'line1\r\nline2\r\nline3\r\n';
    assert.strictEqual(
      normalizeLineEndings(lf),
      normalizeLineEndings(crlf),
      'LF and CRLF variants should normalize to the same string',
    );
  });

  test('standalone \\r (old Mac line endings) is also stripped', () => {
    const cr = 'line1\rline2\r';
    const lf = 'line1\nline2\n';
    assert.notStrictEqual(normalizeLineEndings(cr), normalizeLineEndings(lf),
      'standalone CR collapses differently from LF — only \\r is stripped, not newlines added');
    // The key property: \\r is gone
    assert.ok(!normalizeLineEndings(cr).includes('\r'), 'result must not contain \\r');
  });

  test('real registry content: CRLF variant compares equal to LF variant after normalization', () => {
    const capDir = makeTempCapDir({ ui: UI_CAP });
    const { capMap } = loadAndValidate(new Set(), capDir);
    const registry = buildRegistry(capMap);
    const lfContent = serializeRegistry(registry, capMap);

    // Simulate Windows git checkout by converting LF -> CRLF
    const crlfContent = lfContent.replace(/\n/g, '\r\n');

    assert.notStrictEqual(lfContent, crlfContent, 'CRLF and LF versions are byte-different');
    assert.strictEqual(
      normalizeLineEndings(lfContent),
      normalizeLineEndings(crlfContent),
      '--check must treat CRLF-checked-out registry as up to date (Windows autocrlf regression guard)',
    );
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

describe('double-prefix guard: step.ref.skill must not start with "gsd-"', () => {
  // ref.skill is an unprefixed stem (e.g. "ui-review"). Workflow dispatch prepends
  // "gsd-" at runtime. A stem already starting with "gsd-" would produce "gsd-gsd-..."
  // at dispatch time, silently invoking a non-existent skill.

  test('ref.skill starting with "gsd-" is rejected', () => {
    const cap = {
      ...UI_CAP,
      steps: [
        {
          point: 'verify:post',
          ref: { skill: 'gsd-ui-review' },  // wrong: stem must NOT have gsd- prefix
          produces: ['UI-REVIEW.md'],
          consumes: ['UI-SPEC.md'],
          when: 'workflow.ui_review',
          onError: 'skip',
        },
      ],
    };
    const errors = validateCapability(cap, 'ui');
    assert.ok(errors.length > 0, 'Expected an error for gsd-prefixed ref.skill');
    assert.ok(
      errors.some((e) => e.includes('gsd-') && (e.includes('double') || e.includes('unprefixed') || e.includes('must not start'))),
      'Error should mention the double-prefix problem, got: ' + JSON.stringify(errors),
    );
  });

  test('ref.skill without "gsd-" prefix is accepted (stem only)', () => {
    const cap = {
      ...UI_CAP,
      steps: [
        {
          point: 'verify:post',
          ref: { skill: 'ui-review' },  // correct: unprefixed stem
          produces: ['UI-REVIEW.md'],
          consumes: ['UI-SPEC.md'],
          when: 'workflow.ui_review',
          onError: 'skip',
        },
      ],
    };
    const prefixErrors = validateCapability(cap, 'ui').filter((e) => e.includes('gsd-') && e.includes('stem'));
    assert.deepEqual(prefixErrors, [], 'No prefix errors expected for unprefixed stem, got: ' + JSON.stringify(prefixErrors));
  });

  test('real UI capability.json uses unprefixed ref.skill values', () => {
    // Verify the live capability uses unprefixed stems and therefore passes the new guard.
    const errors = validateCapability(UI_CAP, 'ui');
    const prefixErrors = errors.filter((e) => e.includes('must not start with'));
    assert.deepEqual(prefixErrors, [], 'Live UI capability.json should not trigger the double-prefix guard: ' + JSON.stringify(prefixErrors));
  });
});

// ─── Fix: ref.skill/ref.agent membership in declared skills/agents ────────────

describe('ref membership check: step.ref.skill must be in cap.skills', () => {
  // A capability declares skills: ["ui-phase", "ui-review"].
  // A step with ref.skill "typo-skill" (not in skills) must be rejected.

  test('step.ref.skill NOT in cap.skills is rejected', () => {
    const cap = {
      ...UI_CAP,
      steps: [
        {
          point: 'plan:pre',
          ref: { skill: 'typo-skill' },  // not in skills: ["ui-phase", "ui-review"]
          produces: ['UI-SPEC.md'],
          consumes: ['CONTEXT.md'],
          when: 'workflow.ui_phase',
          onError: 'skip',
        },
      ],
    };
    const errors = validateCapability(cap, 'ui');
    assert.ok(errors.length > 0, 'Expected errors for undeclared ref.skill');
    assert.ok(
      errors.some((e) => e.includes('typo-skill') && e.includes('not declared')),
      'Error should mention "typo-skill" and "not declared", got: ' + JSON.stringify(errors),
    );
  });

  test('step.ref.skill IN cap.skills is accepted', () => {
    const cap = {
      ...UI_CAP,
      steps: [
        {
          point: 'plan:pre',
          ref: { skill: 'ui-phase' },  // declared in skills: ["ui-phase", "ui-review"]
          produces: ['UI-SPEC.md'],
          consumes: ['CONTEXT.md'],
          when: 'workflow.ui_phase',
          onError: 'skip',
        },
      ],
    };
    const errors = validateCapability(cap, 'ui');
    const membershipErrors = errors.filter((e) => e.includes('not declared') && e.includes('ui-phase'));
    assert.deepEqual(
      membershipErrors, [],
      'No membership errors expected for declared ref.skill, got: ' + JSON.stringify(membershipErrors),
    );
  });

  test('real UI capability passes: ui-phase and ui-review are both in skills', () => {
    // Regression guard: the real UI capability must not trigger the new membership check.
    const errors = validateCapability(UI_CAP, 'ui');
    const membershipErrors = errors.filter((e) => e.includes('not declared'));
    assert.deepEqual(
      membershipErrors, [],
      'Real UI capability should pass membership check for all ref.skill values, got: ' + JSON.stringify(membershipErrors),
    );
  });
});

describe('ref membership check: step.ref.agent must be in cap.agents', () => {
  // A capability declares agents: ["gsd-ui-checker", "gsd-ui-auditor"].
  // A step with ref.agent "gsd-unknown-agent" (not in agents) must be rejected.

  test('step.ref.agent NOT in cap.agents is rejected', () => {
    const cap = {
      ...UI_CAP,
      steps: [
        {
          point: 'plan:pre',
          ref: { agent: 'gsd-unknown-agent' },  // not in agents: ["gsd-ui-checker", "gsd-ui-auditor"]
          produces: ['UI-SPEC.md'],
          consumes: ['CONTEXT.md'],
          when: 'workflow.ui_phase',
          onError: 'skip',
        },
      ],
    };
    const errors = validateCapability(cap, 'ui');
    assert.ok(errors.length > 0, 'Expected errors for undeclared ref.agent');
    assert.ok(
      errors.some((e) => e.includes('gsd-unknown-agent') && e.includes('not declared')),
      'Error should mention "gsd-unknown-agent" and "not declared", got: ' + JSON.stringify(errors),
    );
  });

  test('step.ref.agent IN cap.agents is accepted', () => {
    const cap = {
      ...UI_CAP,
      steps: [
        {
          point: 'plan:pre',
          ref: { agent: 'gsd-ui-checker' },  // declared in agents
          produces: ['UI-SPEC.md'],
          consumes: ['CONTEXT.md'],
          when: 'workflow.ui_phase',
          onError: 'skip',
        },
      ],
    };
    const errors = validateCapability(cap, 'ui');
    const membershipErrors = errors.filter((e) => e.includes('not declared') && e.includes('gsd-ui-checker'));
    assert.deepEqual(
      membershipErrors, [],
      'No membership errors expected for declared ref.agent, got: ' + JSON.stringify(membershipErrors),
    );
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

  // (this test follows the series above)
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

// ─── 14. configSchema emission (ADR-857 phase 3b) ────────────────────────────

describe('configSchema emission (ADR-857 phase 3b)', () => {
  test('buildRegistry emits configSchema with correct shape for UI pilot', () => {
    const capDir = makeTempCapDir({ ui: UI_CAP });
    const { capMap, errors } = loadAndValidate(new Set(), capDir);
    assert.deepEqual(errors, [], 'No errors expected');

    const registry = buildRegistry(capMap);
    assert.ok(registry.configSchema, 'registry.configSchema must exist');

    const uiPhase = registry.configSchema['workflow.ui_phase'];
    assert.ok(uiPhase, 'configSchema must have workflow.ui_phase');
    assert.strictEqual(uiPhase.owner, 'ui');
    assert.strictEqual(uiPhase.type, 'boolean');
    assert.strictEqual(uiPhase.default, true);
    assert.ok(typeof uiPhase.description === 'string' && uiPhase.description.length > 0);

    const uiReview = registry.configSchema['workflow.ui_review'];
    assert.ok(uiReview, 'configSchema must have workflow.ui_review');
    assert.strictEqual(uiReview.owner, 'ui');
    assert.strictEqual(uiReview.type, 'boolean');

    const uiSafetyGate = registry.configSchema['workflow.ui_safety_gate'];
    assert.ok(uiSafetyGate, 'configSchema must have workflow.ui_safety_gate');
    assert.strictEqual(uiSafetyGate.type, 'boolean');
  });

  test('serializeRegistry emits a configSchema block in the generated .cjs', () => {
    const capDir = makeTempCapDir({ ui: UI_CAP });
    const { capMap } = loadAndValidate(new Set(), capDir);
    const registry = buildRegistry(capMap);
    const content = serializeRegistry(registry, capMap);

    assert.ok(content.includes('const configSchema'), 'Generated file must contain "const configSchema"');
    assert.ok(content.includes('"workflow.ui_phase"'), 'Generated file must contain "workflow.ui_phase"');
    assert.ok(content.includes('"owner"'), 'Generated file must contain "owner" field');
    assert.ok(content.includes('"type"'), 'Generated file must contain "type" field');
    assert.ok(content.includes('"default"'), 'Generated file must contain "default" field');
    assert.ok(content.includes('"description"'), 'Generated file must contain "description" field');
    assert.ok(content.includes('configSchema,'), 'Generated module.exports must include configSchema');
  });

  test('committed capability-registry.cjs has configSchema with correct shape', () => {
    const registry = require('../gsd-core/bin/lib/capability-registry.cjs');
    assert.ok(registry.configSchema, 'capability-registry.cjs must export configSchema');

    const uiPhase = registry.configSchema['workflow.ui_phase'];
    assert.ok(uiPhase, 'committed registry configSchema must have workflow.ui_phase');
    assert.strictEqual(uiPhase.owner, 'ui', 'owner must be "ui"');
    assert.strictEqual(uiPhase.type, 'boolean', 'type must be "boolean"');
    assert.strictEqual(uiPhase.default, true, 'default must be true');
    assert.ok(typeof uiPhase.description === 'string' && uiPhase.description.length > 0);
  });
});

// ─── 15. validateConfigSliceEntry adversarial tests ───────────────────────────

describe('validateConfigSliceEntry adversarial cases (ADR-857 phase 3b)', () => {
  const CAP_ID = 'test-cap';
  const KEY = 'test.key';

  test('VALID_CONFIG_SLICE_TYPES exports expected types', () => {
    const types = [...VALID_CONFIG_SLICE_TYPES];
    assert.ok(types.includes('boolean'), 'Must include boolean');
    assert.ok(types.includes('string'), 'Must include string');
    assert.ok(types.includes('number'), 'Must include number');
    assert.ok(types.includes('enum'), 'Must include enum');
    assert.strictEqual(types.length, 4, 'Must have exactly 4 types');
  });

  test('valid boolean slice passes validation', () => {
    const errors = validateConfigSliceEntry(CAP_ID, KEY, { type: 'boolean', default: true, description: 'ok' });
    assert.deepEqual(errors, [], 'Valid boolean slice should produce no errors, got: ' + JSON.stringify(errors));
  });

  test('valid string slice passes validation', () => {
    const errors = validateConfigSliceEntry(CAP_ID, KEY, { type: 'string', default: 'x', description: 'ok' });
    assert.deepEqual(errors, []);
  });

  test('valid number slice passes validation', () => {
    const errors = validateConfigSliceEntry(CAP_ID, KEY, { type: 'number', default: 5, description: 'ok' });
    assert.deepEqual(errors, []);
  });

  test('REJECTED: enum slice without values list → error (FIX 5a: values required)', () => {
    const errors = validateConfigSliceEntry(CAP_ID, KEY, { type: 'enum', default: 'x', description: 'ok' });
    assert.ok(errors.length > 0, 'Expected rejection for enum without values list, got: ' + JSON.stringify(errors));
    assert.ok(
      errors.some((e) => e.includes('values') || e.includes('enum')),
      'Error should mention values or enum, got: ' + JSON.stringify(errors),
    );
  });

  test('valid enum slice (with values list, default in values) passes', () => {
    const errors = validateConfigSliceEntry(CAP_ID, KEY, {
      type: 'enum', default: 'b', values: ['a', 'b', 'c'], description: 'ok',
    });
    assert.deepEqual(errors, []);
  });

  test('REJECTED: bad type ("xml") → error mentioning type', () => {
    const errors = validateConfigSliceEntry(CAP_ID, KEY, { type: 'xml', default: '<x/>', description: 'ok' });
    assert.ok(errors.length > 0, 'Expected rejection for bad type');
    assert.ok(errors.some((e) => e.includes('type')), 'Error should mention type, got: ' + JSON.stringify(errors));
  });

  test('REJECTED: missing type → error', () => {
    const errors = validateConfigSliceEntry(CAP_ID, KEY, { default: true, description: 'ok' });
    assert.ok(errors.length > 0, 'Expected rejection for missing type');
    assert.ok(errors.some((e) => e.includes('type')));
  });

  test('REJECTED: missing default → error mentioning default', () => {
    const errors = validateConfigSliceEntry(CAP_ID, KEY, { type: 'boolean', description: 'ok' });
    assert.ok(errors.length > 0, 'Expected rejection for missing default');
    assert.ok(errors.some((e) => e.includes('default')), 'Error should mention default, got: ' + JSON.stringify(errors));
  });

  test('REJECTED: boolean type with string default → error', () => {
    const errors = validateConfigSliceEntry(CAP_ID, KEY, { type: 'boolean', default: 'true', description: 'ok' });
    assert.ok(errors.length > 0, 'Expected rejection for boolean type with string default');
    assert.ok(errors.some((e) => e.includes('boolean') || e.includes('default')));
  });

  test('REJECTED: string type with boolean default → error', () => {
    const errors = validateConfigSliceEntry(CAP_ID, KEY, { type: 'string', default: false, description: 'ok' });
    assert.ok(errors.length > 0, 'Expected rejection for string type with boolean default');
  });

  test('REJECTED: number type with string default → error', () => {
    const errors = validateConfigSliceEntry(CAP_ID, KEY, { type: 'number', default: 'five', description: 'ok' });
    assert.ok(errors.length > 0, 'Expected rejection for number type with string default');
  });

  test('REJECTED: enum type with values list, default not in values → error', () => {
    const errors = validateConfigSliceEntry(CAP_ID, KEY, {
      type: 'enum', default: 'z', values: ['a', 'b', 'c'], description: 'ok',
    });
    assert.ok(errors.length > 0, 'Expected rejection for enum default not in values');
    assert.ok(errors.some((e) => e.includes('enum') || e.includes('values') || e.includes('z')));
  });

  test('REJECTED: enum type with non-string default → error', () => {
    const errors = validateConfigSliceEntry(CAP_ID, KEY, { type: 'enum', default: 42, description: 'ok' });
    assert.ok(errors.length > 0, 'Expected rejection for enum with non-string default');
  });

  test('REJECTED: empty description string → error', () => {
    const errors = validateConfigSliceEntry(CAP_ID, KEY, { type: 'boolean', default: true, description: '' });
    assert.ok(errors.length > 0, 'Expected rejection for empty description');
    assert.ok(errors.some((e) => e.includes('description')));
  });

  test('REJECTED: non-string description (number) → error', () => {
    const errors = validateConfigSliceEntry(CAP_ID, KEY, { type: 'boolean', default: true, description: 42 });
    assert.ok(errors.length > 0, 'Expected rejection for non-string description');
    assert.ok(errors.some((e) => e.includes('description')));
  });

  test('REJECTED: missing description → error', () => {
    const errors = validateConfigSliceEntry(CAP_ID, KEY, { type: 'boolean', default: true });
    assert.ok(errors.length > 0, 'Expected rejection for missing description');
    assert.ok(errors.some((e) => e.includes('description')));
  });

  test('REJECTED: null slice → error', () => {
    const errors = validateConfigSliceEntry(CAP_ID, KEY, null);
    assert.ok(errors.length > 0, 'Expected rejection for null slice');
  });

  test('REJECTED: array slice → error', () => {
    const errors = validateConfigSliceEntry(CAP_ID, KEY, []);
    assert.ok(errors.length > 0, 'Expected rejection for array slice');
  });

  // FIX 5a: enum-without-values and default-not-in-values
  test('REJECTED: enum with empty values array → error (FIX 5a)', () => {
    const errors = validateConfigSliceEntry(CAP_ID, KEY, { type: 'enum', default: 'x', values: [], description: 'ok' });
    assert.ok(errors.length > 0, 'Expected rejection for enum with empty values, got: ' + JSON.stringify(errors));
    assert.ok(errors.some((e) => e.includes('values') || e.includes('enum')));
  });

  test('REJECTED: enum with non-string values array entries → error (FIX 5a)', () => {
    const errors = validateConfigSliceEntry(CAP_ID, KEY, { type: 'enum', default: 'x', values: ['a', 42], description: 'ok' });
    assert.ok(errors.length > 0, 'Expected rejection for enum with non-string values, got: ' + JSON.stringify(errors));
    assert.ok(errors.some((e) => e.includes('values') || e.includes('string')));
  });

  test('REJECTED: enum default not in values → error (FIX 5a)', () => {
    const errors = validateConfigSliceEntry(CAP_ID, KEY, { type: 'enum', default: 'z', values: ['a', 'b'], description: 'ok' });
    assert.ok(errors.length > 0, 'Expected rejection for enum default not in values, got: ' + JSON.stringify(errors));
    assert.ok(errors.some((e) => e.includes('z') || e.includes('values') || e.includes('default')));
  });

  // FIX 6a: NaN and non-finite number defaults
  test('REJECTED: NaN number default → error (FIX 6a)', () => {
    const errors = validateConfigSliceEntry(CAP_ID, KEY, { type: 'number', default: NaN, description: 'ok' });
    assert.ok(errors.length > 0, 'Expected rejection for NaN default, got: ' + JSON.stringify(errors));
    assert.ok(errors.some((e) => e.includes('finite') || e.includes('NaN') || e.includes('number')));
  });

  test('REJECTED: Infinity number default → error (FIX 6a)', () => {
    const errors = validateConfigSliceEntry(CAP_ID, KEY, { type: 'number', default: Infinity, description: 'ok' });
    assert.ok(errors.length > 0, 'Expected rejection for Infinity default, got: ' + JSON.stringify(errors));
    assert.ok(errors.some((e) => e.includes('finite') || e.includes('number')));
  });

  test('REJECTED: -Infinity number default → error (FIX 6a)', () => {
    const errors = validateConfigSliceEntry(CAP_ID, KEY, { type: 'number', default: -Infinity, description: 'ok' });
    assert.ok(errors.length > 0, 'Expected rejection for -Infinity default, got: ' + JSON.stringify(errors));
  });

  test('buildRegistry throws on malformed config slice in capability', () => {
    // A capability with a config slice that has a missing default — buildRegistry must throw
    const cap = {
      ...UI_CAP,
      config: {
        ...UI_CAP.config,
        'workflow.bad_key': { type: 'boolean', description: 'missing default' },
      },
    };
    const capMap = new Map([['ui', cap]]);
    assert.throws(
      () => buildRegistry(capMap),
      (err) => {
        assert.ok(err instanceof Error, 'Must throw an Error');
        assert.ok(
          err.message.includes('configSchema') || err.message.includes('default') || err.message.includes('validation'),
          'Error must mention configSchema validation, got: ' + err.message,
        );
        return true;
      },
    );
  });
});

// ─── 16. ADR-857 phase 4a: capabilityClusters + profileMembership ─────────────

// Minimal valid feature capability for synthetic tests
function makeSyntheticCap(id, tier, skills) {
  return {
    id,
    role: 'feature',
    title: id,
    description: 'Synthetic cap for testing',
    tier,
    requires: [],
    skills: [...skills],
    agents: [],
    hooks: [],
    config: {},
    steps: [],
    contributions: [],
    gates: [],
  };
}

describe('ADR-857 phase 4a: capabilityClusters shape', () => {
  test('ui capabilityClusters → [ui-phase, ui-review]', () => {
    const capMap = new Map([['ui', UI_CAP]]);
    const clusters = deriveCapabilityClusters(capMap);
    assert.ok(clusters.ui, 'capabilityClusters.ui should exist');
    // Skills are sorted for determinism
    assert.deepEqual(
      clusters.ui,
      ['ui-phase', 'ui-review'],
      'ui cluster should be [ui-phase, ui-review], got: ' + JSON.stringify(clusters.ui),
    );
  });

  test('capabilityClusters skips runtime capabilities (no skills)', () => {
    const runtimeCap = {
      id: 'cursor', role: 'runtime', title: 'Cursor', description: 'Cursor runtime',
      tier: 'standard', requires: [],
      runtime: {
        configHome: '~/.cursor', configFormat: 'settings-json',
        artifactLayout: [], commandStyle: 'slash', hooksSurface: 'rules',
        sandboxTier: 'none', supportTier: 2,
      },
    };
    const capMap = new Map([['cursor', runtimeCap]]);
    const clusters = deriveCapabilityClusters(capMap);
    assert.ok(!clusters.cursor, 'runtime cap should not appear in capabilityClusters');
  });

  test('capabilityClusters skills are sorted for determinism', () => {
    const cap = makeSyntheticCap('test-cap', 'standard', ['z-skill', 'a-skill', 'm-skill']);
    const capMap = new Map([['test-cap', cap]]);
    const clusters = deriveCapabilityClusters(capMap);
    assert.deepEqual(
      clusters['test-cap'],
      ['a-skill', 'm-skill', 'z-skill'],
      'Skills should be sorted alphabetically, got: ' + JSON.stringify(clusters['test-cap']),
    );
  });

  test('buildRegistry includes capabilityClusters with correct ui value', () => {
    const capDir = makeTempCapDir({ ui: UI_CAP });
    const { capMap } = loadAndValidate(new Set(), capDir);
    const registry = buildRegistry(capMap);
    assert.ok(registry.capabilityClusters, 'registry.capabilityClusters should exist');
    assert.deepEqual(
      registry.capabilityClusters.ui,
      ['ui-phase', 'ui-review'],
      'registry.capabilityClusters.ui should be [ui-phase, ui-review]',
    );
  });

  test('serializeRegistry emits capabilityClusters block in generated .cjs', () => {
    const capDir = makeTempCapDir({ ui: UI_CAP });
    const { capMap } = loadAndValidate(new Set(), capDir);
    const registry = buildRegistry(capMap);
    const content = serializeRegistry(registry, capMap);
    assert.ok(content.includes('const capabilityClusters'), 'Generated file must contain "const capabilityClusters"');
    assert.ok(content.includes('"ui-phase"'), 'Generated file must contain "ui-phase" in capabilityClusters');
    assert.ok(content.includes('capabilityClusters,'), 'module.exports must include capabilityClusters');
  });

  test('committed capability-registry.cjs has capabilityClusters with ui=[ui-phase,ui-review]', () => {
    const registry = require('../gsd-core/bin/lib/capability-registry.cjs');
    assert.ok(registry.capabilityClusters, 'capability-registry.cjs must export capabilityClusters');
    assert.deepEqual(
      registry.capabilityClusters.ui,
      ['ui-phase', 'ui-review'],
      'committed capabilityClusters.ui should be [ui-phase, ui-review]',
    );
  });
});

describe('ADR-857 phase 4a: capabilityClusters HARD consistency gate', () => {
  test('synthetic cap whose capId matches a CLUSTERS name but with different skills throws', () => {
    // The 'ui' name exists in CLUSTERS with ['ui-phase', 'ui-review'].
    // A synthetic 'ui' cap with only ['ui-phase'] (missing 'ui-review') must throw.
    const wrongUiCap = makeSyntheticCap('ui', 'standard', ['ui-phase']); // missing ui-review
    const capMap = new Map([['ui', wrongUiCap]]);
    const clusters = deriveCapabilityClusters(capMap);
    const profiles = deriveProfileMembership(capMap);
    assert.throws(
      () => runConsistencyGate(clusters, profiles, capMap),
      (err) => {
        assert.ok(err instanceof Error, 'Must throw an Error');
        assert.ok(
          err.message.includes('ui'),
          'Error must name the capId, got: ' + err.message,
        );
        assert.ok(
          err.message.includes('ui-review') || err.message.includes('derived set') || err.message.includes('hand-authored'),
          'Error must describe the mismatch, got: ' + err.message,
        );
        return true;
      },
    );
  });

  test('cap with capId that has NO matching CLUSTERS entry is accepted (new cluster — fine)', () => {
    // A new capability 'payments' that has no CLUSTERS entry must NOT throw
    const newCap = makeSyntheticCap('payments', 'standard', ['pay-phase', 'pay-review']);
    const capMap = new Map([['payments', newCap]]);
    const clusters = deriveCapabilityClusters(capMap);
    const profiles = deriveProfileMembership(capMap);
    // Must not throw
    assert.doesNotThrow(
      () => runConsistencyGate(clusters, profiles, capMap),
      'A cap with no matching CLUSTERS entry should not throw (new cluster is fine)',
    );
  });

  test('HARD gate: extra skill in derived set (more than hand-authored) also throws', () => {
    // 'ui' cap with an extra skill triggers the mismatch
    const extraUiCap = makeSyntheticCap('ui', 'standard', ['ui-phase', 'ui-review', 'ui-extra']);
    const capMap = new Map([['ui', extraUiCap]]);
    const clusters = deriveCapabilityClusters(capMap);
    const profiles = deriveProfileMembership(capMap);
    assert.throws(
      () => runConsistencyGate(clusters, profiles, capMap),
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes('ui'), 'Error must name the capId');
        return true;
      },
    );
  });
});

describe('ADR-857 phase 4a: profileMembership derivation', () => {
  test('tier core → profiles [core, standard, full]', () => {
    const cap = makeSyntheticCap('core-cap', 'core', ['core-skill']);
    const capMap = new Map([['core-cap', cap]]);
    const profiles = deriveProfileMembership(capMap);
    assert.ok(profiles['core-cap'], 'profileMembership should have core-cap');
    assert.strictEqual(profiles['core-cap'].tier, 'core');
    assert.deepEqual(
      profiles['core-cap'].profiles,
      ['core', 'standard', 'full'],
      'core tier should produce [core, standard, full], got: ' + JSON.stringify(profiles['core-cap'].profiles),
    );
  });

  test('tier standard → profiles [standard, full]', () => {
    const cap = makeSyntheticCap('std-cap', 'standard', ['std-skill']);
    const capMap = new Map([['std-cap', cap]]);
    const profiles = deriveProfileMembership(capMap);
    assert.ok(profiles['std-cap'], 'profileMembership should have std-cap');
    assert.strictEqual(profiles['std-cap'].tier, 'standard');
    assert.deepEqual(
      profiles['std-cap'].profiles,
      ['standard', 'full'],
      'standard tier should produce [standard, full], got: ' + JSON.stringify(profiles['std-cap'].profiles),
    );
  });

  test('tier full → profiles [full]', () => {
    const cap = makeSyntheticCap('full-cap', 'full', ['full-skill']);
    const capMap = new Map([['full-cap', cap]]);
    const profiles = deriveProfileMembership(capMap);
    assert.ok(profiles['full-cap'], 'profileMembership should have full-cap');
    assert.strictEqual(profiles['full-cap'].tier, 'full');
    assert.deepEqual(
      profiles['full-cap'].profiles,
      ['full'],
      'full tier should produce [full], got: ' + JSON.stringify(profiles['full-cap'].profiles),
    );
  });

  test('PROFILE_RANK is imported (not hardcoded): all three tiers covered', () => {
    // Verify PROFILE_RANK is the canonical ['core', 'standard', 'full'] from install-profiles.cjs
    assert.deepEqual(
      PROFILE_RANK,
      ['core', 'standard', 'full'],
      'PROFILE_RANK must be [core, standard, full] from install-profiles.cjs, got: ' + JSON.stringify(PROFILE_RANK),
    );
  });

  test('ui cap (tier full after reconciliation) profileMembership is [full]', () => {
    // ADR-857 phase 4c: ui tier changed from standard → full
    const capMap = new Map([['ui', UI_CAP]]);
    const profiles = deriveProfileMembership(capMap);
    assert.deepEqual(
      profiles.ui.profiles,
      ['full'],
      'ui (tier full) should have profiles [full] after reconciliation',
    );
  });

  test('buildRegistry includes profileMembership with correct ui value', () => {
    const capDir = makeTempCapDir({ ui: UI_CAP });
    const { capMap } = loadAndValidate(new Set(), capDir);
    const registry = buildRegistry(capMap);
    assert.ok(registry.profileMembership, 'registry.profileMembership should exist');
    // After ADR-857 phase 4c reconciliation: ui is tier:full → profiles: ['full'] only
    assert.deepEqual(
      registry.profileMembership.ui,
      { tier: 'full', profiles: ['full'] },
      'profileMembership.ui should be { tier: full, profiles: [full] } after reconciliation',
    );
  });

  test('serializeRegistry emits profileMembership block in generated .cjs', () => {
    const capDir = makeTempCapDir({ ui: UI_CAP });
    const { capMap } = loadAndValidate(new Set(), capDir);
    const registry = buildRegistry(capMap);
    const content = serializeRegistry(registry, capMap);
    assert.ok(content.includes('const profileMembership'), 'Generated file must contain "const profileMembership"');
    // After ADR-857 phase 4c reconciliation: ui is tier:full → profileMembership contains "full"
    assert.ok(content.includes('"full"'), 'Generated file must contain "full" in profileMembership');
    assert.ok(content.includes('profileMembership,'), 'module.exports must include profileMembership');
  });

  test('committed capability-registry.cjs has profileMembership with correct ui value', () => {
    const registry = require('../gsd-core/bin/lib/capability-registry.cjs');
    assert.ok(registry.profileMembership, 'capability-registry.cjs must export profileMembership');
    // After ADR-857 phase 4c reconciliation: ui is tier:full → profiles: ['full'] only
    assert.deepEqual(
      registry.profileMembership.ui,
      { tier: 'full', profiles: ['full'] },
      'committed profileMembership.ui should be { tier: full, profiles: [full] } after reconciliation',
    );
  });
});

describe('ADR-857 phase 4a: pending-reconciliation warnings (SOFT gate)', () => {
  test('ui (tier full) generates ZERO pending-reconciliation warnings (ADR-857 phase 4c reconciliation)', () => {
    // After reconciliation: ui is tier:full. The full profile is '*' (every skill).
    // The consistency gate must NOT fire for full-tier capabilities — their skills are
    // always present in the full profile by definition.
    const capMap = new Map([['ui', UI_CAP]]);
    const clusters = deriveCapabilityClusters(capMap);
    const profiles = deriveProfileMembership(capMap);
    const warnings = runConsistencyGate(clusters, profiles, capMap);
    const uiPhaseWarn = warnings.find((w) => w.includes('ui-phase'));
    const uiReviewWarn = warnings.find((w) => w.includes('ui-review'));
    assert.ok(
      !uiPhaseWarn,
      'No pending-reconciliation warning expected for ui-phase (tier:full), got: ' + JSON.stringify(warnings),
    );
    assert.ok(
      !uiReviewWarn,
      'No pending-reconciliation warning expected for ui-review (tier:full), got: ' + JSON.stringify(warnings),
    );
  });

  test('ui reconciled: profileMembership.ui.profiles is ["full"] after tier:full reconciliation', () => {
    // After reconciliation: ui is tier:full → profileMembership.ui.profiles = ['full'] only.
    // ui-phase/ui-review are correctly absent from core/standard (they're full-only features).
    // No pending-reconciliation warning fires because full='*' always satisfies the gate.
    const capMap = new Map([['ui', UI_CAP]]);
    const profiles = deriveProfileMembership(capMap);
    assert.deepStrictEqual(
      profiles.ui.profiles,
      ['full'],
      'After tier:full reconciliation, ui profileMembership should be ["full"] only',
    );
    assert.strictEqual(
      profiles.ui.tier,
      'full',
      'ui tier should be "full" after reconciliation',
    );

    // Confirm ui-phase is NOT in standard profile — that's expected and correct for full-tier skills.
    const { resolveProfile: rp } = require('../gsd-core/bin/lib/install-profiles.cjs');
    const resolved = rp({ modes: ['standard'], manifest: new Map() });
    assert.ok(
      resolved.skills !== '*',
      'standard profile should not be full',
    );
    assert.ok(
      !resolved.skills.has('ui-phase'),
      'ui-phase should NOT be in hand-authored standard profile (correctly full-only after reconciliation)',
    );
    assert.ok(
      !resolved.skills.has('ui-review'),
      'ui-review should NOT be in hand-authored standard profile (correctly full-only after reconciliation)',
    );
  });

  test('SOFT gate does NOT throw — only returns warnings', () => {
    // Even with reconciliation gaps, runConsistencyGate must NOT throw
    const capMap = new Map([['ui', UI_CAP]]);
    const clusters = deriveCapabilityClusters(capMap);
    const profiles = deriveProfileMembership(capMap);
    let warnings;
    assert.doesNotThrow(
      () => { warnings = runConsistencyGate(clusters, profiles, capMap); },
      'SOFT gate must not throw — only collect warnings',
    );
    assert.ok(Array.isArray(warnings), 'runConsistencyGate must return an array');
  });

  test('buildRegistry._reconciliationWarnings is empty for reconciled ui (tier:full)', () => {
    // After reconciliation: ui is tier:full → no pending-reconciliation warnings.
    const capDir = makeTempCapDir({ ui: UI_CAP });
    const { capMap } = loadAndValidate(new Set(), capDir);
    const registry = buildRegistry(capMap);
    assert.ok(
      Array.isArray(registry._reconciliationWarnings),
      'registry._reconciliationWarnings should be an array',
    );
    const uiWarnings = registry._reconciliationWarnings.filter(
      (w) => w.includes('ui-phase') || w.includes('ui-review')
    );
    assert.deepStrictEqual(
      uiWarnings,
      [],
      'No reconciliation warnings expected for reconciled ui capability, got: ' + JSON.stringify(uiWarnings),
    );
  });

  test('reconciliation warnings are NOT in serialized registry output (determinism gate)', () => {
    // Warnings must appear ONLY on stderr, not in the generated .cjs file
    const capDir = makeTempCapDir({ ui: UI_CAP });
    const { capMap } = loadAndValidate(new Set(), capDir);
    const registry = buildRegistry(capMap);
    const content = serializeRegistry(registry, capMap);
    assert.ok(
      !content.includes('pending-reconciliation'),
      'Serialized registry must NOT contain "pending-reconciliation" text (warnings are stderr-only)',
    );
    assert.ok(
      !content.includes('_reconciliationWarnings'),
      'Serialized registry must NOT contain _reconciliationWarnings key',
    );
  });

  test('a cap whose skill IS already in the standard profile emits no reconciliation warning', () => {
    // 'plan-phase' IS in the hand-authored standard profile. A synthetic cap
    // with tier=standard and skill=plan-phase should NOT generate a warning.
    const cap = makeSyntheticCap('planner-cap', 'standard', ['plan-phase']);
    const capMap = new Map([['planner-cap', cap]]);
    const clusters = deriveCapabilityClusters(capMap);
    const profiles = deriveProfileMembership(capMap);
    const warnings = runConsistencyGate(clusters, profiles, capMap);
    const planPhaseWarnings = warnings.filter((w) => w.includes('plan-phase'));
    assert.deepEqual(
      planPhaseWarnings, [],
      'No reconciliation warning expected for plan-phase (already in standard profile), got: ' + JSON.stringify(planPhaseWarnings),
    );
  });

  test('a core-tier cap with skills already in core profile emits no reconciliation warning', () => {
    // 'new-project' IS in the hand-authored core profile.
    const cap = makeSyntheticCap('np-cap', 'core', ['new-project']);
    const capMap = new Map([['np-cap', cap]]);
    const clusters = deriveCapabilityClusters(capMap);
    const profiles = deriveProfileMembership(capMap);
    const warnings = runConsistencyGate(clusters, profiles, capMap);
    const npWarnings = warnings.filter((w) => w.includes('new-project'));
    assert.deepEqual(
      npWarnings, [],
      'No reconciliation warning expected for new-project (already in core profile), got: ' + JSON.stringify(npWarnings),
    );
  });
});

describe('ADR-857 phase 4a: requires-closure tier-monotone (synthetic)', () => {
  test('tier-monotone: a required capability must be same-or-lower tier', () => {
    // Cap A at 'core' requiring cap B at 'standard' violates tier-monotone.
    // validateCrossCapability already tests this; here we verify the rule via
    // a profileMembership structural check: if A is core → B must have rank ≤ core.
    const capA = makeSyntheticCap('tier-a', 'core', ['a-skill']);
    capA.requires = ['tier-b'];
    const capB = makeSyntheticCap('tier-b', 'standard', ['b-skill']);
    const capMap = new Map([['tier-a', capA], ['tier-b', capB]]);

    // validateCrossCapability enforces the rule
    const { validateCrossCapability: vcc } = require('../scripts/gen-capability-registry.cjs');
    const errors = vcc(capMap, new Set());
    assert.ok(
      errors.some((e) => e.includes('tier-monotone')),
      'Expected tier-monotone error, got: ' + JSON.stringify(errors),
    );
  });

  test('tier-monotone: same-tier requires is accepted', () => {
    const capA = makeSyntheticCap('mono-a', 'standard', ['ma-skill']);
    capA.requires = ['mono-b'];
    const capB = makeSyntheticCap('mono-b', 'standard', ['mb-skill']);
    const capMap = new Map([['mono-a', capA], ['mono-b', capB]]);

    const { validateCrossCapability: vcc } = require('../scripts/gen-capability-registry.cjs');
    const errors = vcc(capMap, new Set());
    const monotoneErrors = errors.filter((e) => e.includes('tier-monotone'));
    assert.deepEqual(monotoneErrors, [], 'Same-tier requires should be accepted, got: ' + JSON.stringify(monotoneErrors));
  });

  test('tier-monotone: higher-tier requiring lower-tier is accepted (full requires core)', () => {
    const capA = makeSyntheticCap('full-a', 'full', ['fa-skill']);
    capA.requires = ['core-b'];
    const capB = makeSyntheticCap('core-b', 'core', ['cb-skill']);
    const capMap = new Map([['full-a', capA], ['core-b', capB]]);

    const { validateCrossCapability: vcc } = require('../scripts/gen-capability-registry.cjs');
    const errors = vcc(capMap, new Set());
    const monotoneErrors = errors.filter((e) => e.includes('tier-monotone'));
    assert.deepEqual(
      monotoneErrors, [],
      'full requiring core should be accepted (higher tier can require lower tier), got: ' + JSON.stringify(monotoneErrors),
    );
  });
});

describe('ADR-857 phase 4a: --check determinism after --write', () => {
  test('serializeRegistry produces identical output for two calls (determinism)', () => {
    // Regression guard: --check would fail if output is non-deterministic
    const capDir = makeTempCapDir({ ui: UI_CAP });
    const { capMap } = loadAndValidate(new Set(), capDir);
    const registry = buildRegistry(capMap);
    const content1 = serializeRegistry(registry, capMap);
    const content2 = serializeRegistry(registry, capMap);
    assert.strictEqual(content1, content2, 'serializeRegistry output must be deterministic');
  });
});

// ─── 17. FIX 1: SOFT gate uses real manifest for requires-closure expansion ────

describe('FIX 1: SOFT gate uses closure-resolved manifest (not empty)', () => {
  test('plan-phase is transitively in standard — no reconciliation warning', () => {
    // plan-phase is in PROFILES.standard directly; resolved (with real manifest) = in standard.
    // A standard-tier cap with skill=plan-phase must NOT generate a reconciliation warning.
    const cap = makeSyntheticCap('plan-cap', 'standard', ['plan-phase']);
    const capMap = new Map([['plan-cap', cap]]);
    const clusters = deriveCapabilityClusters(capMap);
    const profiles = deriveProfileMembership(capMap);
    const warnings = runConsistencyGate(clusters, profiles, capMap);
    const planWarnings = warnings.filter((w) => w.includes('plan-phase'));
    assert.deepEqual(
      planWarnings, [],
      'plan-phase is in standard profile — no warning expected, got: ' + JSON.stringify(planWarnings),
    );
  });

  test('FIX 1: skill only transitively in standard (requires-closure) emits no warning', () => {
    // 'code-review' is brought into standard via requires-closure expansion (not in raw base).
    // FIX 1 ensures the real manifest is used, so no false-positive warning is emitted.
    const cap = makeSyntheticCap('cr-cap', 'standard', ['code-review']);
    const capMap = new Map([['cr-cap', cap]]);
    const clusters = deriveCapabilityClusters(capMap);
    const profiles = deriveProfileMembership(capMap);
    const warnings = runConsistencyGate(clusters, profiles, capMap);
    const crWarnings = warnings.filter((w) => w.includes('code-review'));
    assert.deepEqual(
      crWarnings, [],
      'code-review is transitively in standard via requires-closure — no warning expected, got: ' + JSON.stringify(crWarnings),
    );
  });
});

// ─── 18. FIX 2: globally-sorted capId emission ───────────────────────────────

describe('FIX 2: globally-sorted capId emission (determinism with mixed feature+runtime)', () => {
  test('feature cap "analytics" and feature cap "ui" are globally sorted in serialized output', () => {
    // "analytics" < "ui" alphabetically — must appear first in both derived views
    const analyticsCap = makeSyntheticCap('analytics', 'standard', ['analytics-skill']);
    const capDir = makeTempCapDir({ analytics: analyticsCap, ui: UI_CAP });
    const { capMap } = loadAndValidate(new Set(), capDir);
    const registry = buildRegistry(capMap);
    const content = serializeRegistry(registry, capMap);

    // Find the positions of "analytics" and "ui" in the capabilityClusters block
    const clustersStart = content.indexOf('const capabilityClusters');
    const clustersEnd = content.indexOf('const profileMembership');
    const clustersBlock = content.slice(clustersStart, clustersEnd);

    const analyticsPos = clustersBlock.indexOf('"analytics"');
    const uiPos = clustersBlock.indexOf('"ui"');
    assert.ok(
      analyticsPos < uiPos,
      'analytics must appear before ui in capabilityClusters (global alphabetical sort)',
    );

    // Same check for profileMembership
    const profileStart = content.indexOf('const profileMembership');
    const profileEnd = content.indexOf('const _requiresGraph');
    const profileBlock = content.slice(profileStart, profileEnd);

    const analyticsProfilePos = profileBlock.indexOf('"analytics"');
    const uiProfilePos = profileBlock.indexOf('"ui"');
    assert.ok(
      analyticsProfilePos < uiProfilePos,
      'analytics must appear before ui in profileMembership (global alphabetical sort)',
    );
  });

  test('serialized output is stable across two calls (determinism)', () => {
    const analyticsCap = makeSyntheticCap('analytics', 'standard', ['analytics-skill']);
    const capDir = makeTempCapDir({ analytics: analyticsCap, ui: UI_CAP });
    const { capMap } = loadAndValidate(new Set(), capDir);
    const registry = buildRegistry(capMap);
    const s1 = serializeRegistry(registry, capMap);
    const s2 = serializeRegistry(registry, capMap);
    assert.strictEqual(s1, s2, 'Two serializeRegistry calls must produce identical output');
  });
});

// ─── 19. FIX 3: consistent role scoping across both derived views ─────────────

describe('FIX 3: consistent scope — capabilities that own skills', () => {
  test('feature cap with empty skills does not appear in capabilityClusters', () => {
    // A feature cap with an empty skills array must NOT appear in capabilityClusters
    const emptySkillsCap = {
      id: 'empty-skills', role: 'feature', title: 'Empty', description: 'No skills',
      tier: 'standard', requires: [],
      skills: [], agents: [], hooks: [], config: {}, steps: [], contributions: [], gates: [],
    };
    const capMap = new Map([['empty-skills', emptySkillsCap]]);
    const clusters = deriveCapabilityClusters(capMap);
    assert.ok(
      !Object.prototype.hasOwnProperty.call(clusters, 'empty-skills'),
      'Cap with empty skills array must not appear in capabilityClusters',
    );
  });

  test('feature cap with empty skills does not appear in profileMembership', () => {
    // FIX 3: profileMembership must also exclude caps with no skills (consistent scope)
    const emptySkillsCap = {
      id: 'empty-skills', role: 'feature', title: 'Empty', description: 'No skills',
      tier: 'standard', requires: [],
      skills: [], agents: [], hooks: [], config: {}, steps: [], contributions: [], gates: [],
    };
    const capMap = new Map([['empty-skills', emptySkillsCap]]);
    const profiles = deriveProfileMembership(capMap);
    assert.ok(
      !Object.prototype.hasOwnProperty.call(profiles, 'empty-skills'),
      'Cap with empty skills array must not appear in profileMembership (FIX 3: consistent scope)',
    );
  });
});

// ─── 20. FIX 4: de-duplicated reconciliation warnings ────────────────────────

describe('FIX 4: de-duplicated reconciliation warnings (one per skill, not per profile)', () => {
  test('core-tier cap with skill missing from both core and standard emits ONE warning', () => {
    // ui-phase is not in the hand-authored core or standard profiles.
    // A core-tier cap with ui-phase must emit exactly 1 warning (listing both profiles).
    const cap = makeSyntheticCap('core-ui-cap', 'core', ['ui-phase']);
    const capMap = new Map([['core-ui-cap', cap]]);
    const clusters = deriveCapabilityClusters(capMap);
    const profiles = deriveProfileMembership(capMap);
    const warnings = runConsistencyGate(clusters, profiles, capMap);
    const uiPhaseWarnings = warnings.filter((w) => w.includes('ui-phase'));
    assert.strictEqual(
      uiPhaseWarnings.length, 1,
      'Expected exactly 1 warning for ui-phase (FIX 4: one per skill, not per profile), got: ' + JSON.stringify(uiPhaseWarnings),
    );
    // Warning must list both missing profiles
    assert.ok(
      uiPhaseWarnings[0].includes('core') && uiPhaseWarnings[0].includes('standard'),
      'Warning must list both missing profiles (core and standard), got: ' + uiPhaseWarnings[0],
    );
  });

  test('standard-tier cap with skill missing from standard emits ONE warning with <standard>', () => {
    const cap = makeSyntheticCap('std-ui-cap', 'standard', ['ui-phase']);
    const capMap = new Map([['std-ui-cap', cap]]);
    const clusters = deriveCapabilityClusters(capMap);
    const profiles = deriveProfileMembership(capMap);
    const warnings = runConsistencyGate(clusters, profiles, capMap);
    assert.strictEqual(warnings.length, 1, 'Expected exactly 1 warning, got: ' + JSON.stringify(warnings));
    assert.ok(
      warnings[0].includes('profile(s): <standard>'),
      'Warning must use "profile(s): <standard>" format, got: ' + warnings[0],
    );
  });
});

// ─── 21. FIX 5: tierIdx -1 throws loudly ─────────────────────────────────────

describe('FIX 5: tierIdx === -1 throws loudly (VALID_TIERS/PROFILE_RANK drift guard)', () => {
  test('normal usage (standard/core/full) does not throw in deriveProfileMembership', () => {
    const cap = makeSyntheticCap('drift-test', 'standard', ['s1']);
    const capMap = new Map([['drift-test', cap]]);
    assert.doesNotThrow(
      () => deriveProfileMembership(capMap),
      'deriveProfileMembership must not throw for valid tiers',
    );
  });
});

// ─── 22. FIX 6: UI true-negative doesNotThrow ─────────────────────────────────

describe('FIX 6: runConsistencyGate does NOT throw for real UI capability (true-negative)', () => {
  test('buildRegistry with real UI cap does not throw (HARD gate true-negative)', () => {
    // The real UI cap has skills = [ui-phase, ui-review] which matches CLUSTERS.ui exactly.
    // The HARD gate must NOT throw.
    const capDir = makeTempCapDir({ ui: UI_CAP });
    const { capMap } = loadAndValidate(new Set(), capDir);
    assert.doesNotThrow(
      () => buildRegistry(capMap),
      'buildRegistry must not throw for the real UI capability (CLUSTERS match expected)',
    );
  });

  test('runConsistencyGate does NOT throw for real UI cap (cluster match true-negative)', () => {
    // Explicit doesNotThrow covering runConsistencyGate directly
    const capMap = new Map([['ui', UI_CAP]]);
    const clusters = deriveCapabilityClusters(capMap);
    const profiles = deriveProfileMembership(capMap);
    assert.doesNotThrow(
      () => runConsistencyGate(clusters, profiles, capMap),
      'runConsistencyGate must not throw for UI cap (CLUSTERS.ui matches ui.skills)',
    );
  });
});

// ─── 23. ADR-959: commands field + commandFamilies index ──────────────────────

/**
 * Build a minimal feature capability for ADR-959 command tests.
 * skills/agents/etc. kept minimal-valid so validateCapability passes.
 */
function makeCommandCap(id, commands) {
  return {
    id,
    role: 'feature',
    title: 'Test cap ' + id,
    description: 'Synthetic capability for ADR-959 command tests.',
    tier: 'full',
    requires: [],
    skills: [],
    agents: [],
    hooks: [],
    config: {},
    steps: [],
    contributions: [],
    gates: [],
    commands,
  };
}

describe('ADR-959: validateCommandEntry — valid entry', () => {
  test('valid minimal entry (no subcommands) passes', () => {
    const errors = validateCommandEntry('my-cap', { family: 'foo', module: 'foo.cjs', router: 'routeFoo' }, 'commands[0]');
    assert.deepEqual(errors, []);
  });

  test('valid entry with subcommands passes', () => {
    const errors = validateCommandEntry('my-cap', {
      family: 'bar',
      module: 'bar-router.cjs',
      router: 'routeBar',
      subcommands: ['query', 'status'],
    }, 'commands[0]');
    assert.deepEqual(errors, []);
  });
});

describe('ADR-959: validateCommandEntry — adversarial rejects', () => {
  test('missing family → error', () => {
    const errors = validateCommandEntry('my-cap', { module: 'foo.cjs', router: 'routeFoo' }, 'commands[0]');
    assert.ok(errors.some((e) => e.includes('family')), 'Expected family error, got: ' + JSON.stringify(errors));
  });

  test('empty family → error', () => {
    const errors = validateCommandEntry('my-cap', { family: '', module: 'foo.cjs', router: 'routeFoo' }, 'commands[0]');
    assert.ok(errors.some((e) => e.includes('family')), 'Expected family error, got: ' + JSON.stringify(errors));
  });

  test('missing module → error', () => {
    const errors = validateCommandEntry('my-cap', { family: 'foo', router: 'routeFoo' }, 'commands[0]');
    assert.ok(errors.some((e) => e.includes('module')), 'Expected module error, got: ' + JSON.stringify(errors));
  });

  test('missing router → error', () => {
    const errors = validateCommandEntry('my-cap', { family: 'foo', module: 'foo.cjs' }, 'commands[0]');
    assert.ok(errors.some((e) => e.includes('router')), 'Expected router error, got: ' + JSON.stringify(errors));
  });

  test('non-string router → error', () => {
    const errors = validateCommandEntry('my-cap', { family: 'foo', module: 'foo.cjs', router: 42 }, 'commands[0]');
    assert.ok(errors.some((e) => e.includes('router')), 'Expected router error, got: ' + JSON.stringify(errors));
  });

  test('traversal module "../evil.cjs" → error', () => {
    const errors = validateCommandEntry('my-cap', { family: 'foo', module: '../evil.cjs', router: 'r' }, 'commands[0]');
    assert.ok(errors.some((e) => e.includes('module')), 'Expected module traversal error, got: ' + JSON.stringify(errors));
  });

  test('absolute module "/abs/path.cjs" → error', () => {
    const errors = validateCommandEntry('my-cap', { family: 'foo', module: '/abs/path.cjs', router: 'r' }, 'commands[0]');
    assert.ok(errors.some((e) => e.includes('module')), 'Expected module absolute error, got: ' + JSON.stringify(errors));
  });

  test('module with "/" separator "lib/foo.cjs" → error', () => {
    const errors = validateCommandEntry('my-cap', { family: 'foo', module: 'lib/foo.cjs', router: 'r' }, 'commands[0]');
    assert.ok(errors.some((e) => e.includes('module')), 'Expected module separator error, got: ' + JSON.stringify(errors));
  });

  test('subcommands non-array → error', () => {
    const errors = validateCommandEntry('my-cap', {
      family: 'foo', module: 'foo.cjs', router: 'r', subcommands: 'not-array',
    }, 'commands[0]');
    assert.ok(errors.some((e) => e.includes('subcommands')), 'Expected subcommands error, got: ' + JSON.stringify(errors));
  });

  test('subcommands with non-string entry → error', () => {
    const errors = validateCommandEntry('my-cap', {
      family: 'foo', module: 'foo.cjs', router: 'r', subcommands: ['ok', 42],
    }, 'commands[0]');
    assert.ok(errors.some((e) => e.includes('subcommands')), 'Expected subcommands[1] error, got: ' + JSON.stringify(errors));
  });
});

describe('ADR-959: validateCrossCapability — duplicate family ownership', () => {
  test('duplicate family across two capabilities → error', () => {
    const capA = makeCommandCap('cap-a', [{ family: 'shared', module: 'a.cjs', router: 'rA' }]);
    const capB = makeCommandCap('cap-b', [{ family: 'shared', module: 'b.cjs', router: 'rB' }]);
    const capMap = new Map([['cap-a', capA], ['cap-b', capB]]);
    const errors = validateCrossCapability(capMap, new Set());
    assert.ok(
      errors.some((e) => e.includes('shared') && e.includes('cap-a') && e.includes('cap-b')),
      'Expected duplicate family error mentioning both caps, got: ' + JSON.stringify(errors),
    );
  });

  test('unique families in two capabilities → no error', () => {
    const capA = makeCommandCap('cap-a', [{ family: 'alpha', module: 'alpha.cjs', router: 'rA' }]);
    const capB = makeCommandCap('cap-b', [{ family: 'beta', module: 'beta.cjs', router: 'rB' }]);
    const capMap = new Map([['cap-a', capA], ['cap-b', capB]]);
    const errors = validateCrossCapability(capMap, new Set());
    assert.ok(
      !errors.some((e) => e.includes('owned by both')),
      'Expected no duplicate-ownership error, got: ' + JSON.stringify(errors),
    );
  });
});

describe('ADR-959: buildRegistry — commandFamilies index shape', () => {
  test('cap with valid commands entry produces commandFamilies entry', () => {
    const cap = makeCommandCap('test-cmd', [
      { family: 'myfamily', module: 'myfamily.cjs', router: 'routeMyFamily' },
    ]);
    const capMap = new Map([['test-cmd', cap]]);
    const registry = buildRegistry(capMap);
    assert.ok(registry.commandFamilies, 'commandFamilies must be present');
    const entry = registry.commandFamilies['myfamily'];
    assert.ok(entry, 'commandFamilies["myfamily"] must exist');
    assert.strictEqual(entry.capId, 'test-cmd');
    assert.strictEqual(entry.module, 'myfamily.cjs');
    assert.strictEqual(entry.router, 'routeMyFamily');
  });

  test('cap without commands → commandFamilies is empty', () => {
    const capDir = makeTempCapDir({ ui: UI_CAP });
    const { capMap } = loadAndValidate(new Set(), capDir);
    const registry = buildRegistry(capMap);
    assert.ok(registry.commandFamilies, 'commandFamilies must be present');
    assert.deepEqual(Object.keys(registry.commandFamilies), [], 'commandFamilies must be empty for real registry');
  });

  test('commandFamilies keys are sorted in serialized output (determinism)', () => {
    // Two caps with commands in z→a order; expect a→z in the commandFamilies section
    const capA = makeCommandCap('cap-a', [{ family: 'zebra', module: 'z.cjs', router: 'rZ' }]);
    const capB = makeCommandCap('cap-b', [{ family: 'alpha', module: 'a.cjs', router: 'rA' }]);
    const capMap = new Map([['cap-a', capA], ['cap-b', capB]]);
    const registry = buildRegistry(capMap);
    const serialized = serializeRegistry(registry, capMap);

    // Find the commandFamilies section specifically (not the full capabilities JSON)
    const cfStart = serialized.indexOf('const commandFamilies = ');
    assert.ok(cfStart >= 0, 'commandFamilies section must be present');
    const cfEnd = serialized.indexOf('\n};', cfStart) + 3; // closing }; of const assignment
    const cfSection = serialized.slice(cfStart, cfEnd);

    const alphaIdx = cfSection.indexOf('"alpha"');
    const zebraIdx = cfSection.indexOf('"zebra"');
    assert.ok(alphaIdx >= 0, '"alpha" must appear in commandFamilies section');
    assert.ok(zebraIdx >= 0, '"zebra" must appear in commandFamilies section');
    assert.ok(alphaIdx < zebraIdx, 'commandFamilies section must list "alpha" before "zebra" (sorted)');
  });
});

describe('ADR-959: validateCapability — commands field on feature role', () => {
  test('valid commands entry on feature cap passes validateCapability', () => {
    const cap = makeCommandCap('cmd-cap', [
      { family: 'testfamily', module: 'testfamily.cjs', router: 'routeTestFamily' },
    ]);
    const errors = validateCapability(cap, 'cmd-cap');
    assert.deepEqual(errors, [], 'Expected no errors: ' + JSON.stringify(errors));
  });

  test('commands: null on feature cap → error', () => {
    const cap = makeCommandCap('cmd-cap', null);
    const errors = validateCapability(cap, 'cmd-cap');
    assert.ok(errors.some((e) => e.includes('commands')), 'Expected commands error, got: ' + JSON.stringify(errors));
  });
});
