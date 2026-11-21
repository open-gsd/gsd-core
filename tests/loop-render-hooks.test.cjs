'use strict';

/**
 * loop-render-hooks.test.cjs — behavioral tests for loop-resolver.cjs.
 *
 * ADR-857 phase 3c.
 * Uses node:test + node:assert/strict.
 * Pure-function tests (resolveLoopHooks, renderLoopHooks) pass registry+config
 * directly — no I/O. End-to-end tests use cmdLoopRenderHooks + a temp project.
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const fc = require('./helpers/fast-check-setup.cjs');

const { cleanup, createTempDir, createTempProject } = require('./helpers.cjs');
const { splitLines } = require('../gsd-core/bin/lib/text-lines.cjs');

const {
  resolveLoopHooks,
  renderLoopHooks,
  resolveActiveHooksForPoint,
  PHASE_TOKEN_RE,
  PHASE_DROP,
  _getNestedConfigValue,
  _resolveActivationValue,
  _readRawConfigKey,
  CANONICAL_POINTS_FALLBACK,
  CANONICAL_POINTS,
} = require('../gsd-core/bin/lib/loop-resolver.cjs');

// The real registry for integration tests
const realRegistry = require('../gsd-core/bin/lib/capability-registry.cjs');

// ─── Synthetic registry fixtures ─────────────────────────────────────────────

/**
 * Build a minimal synthetic registry with a single step hook at a given point.
 * Optionally include a configSchema for testing default-based activation.
 */
function makeRegistry({ point = 'plan:pre', steps = [], contributions = [], gates = {}, configSchema = {} } = {}) {
  const byLoopPoint = {};
  for (const p of CANONICAL_POINTS_FALLBACK) {
    byLoopPoint[p] = { steps: [], contributions: [], gates: [] };
  }
  if (steps.length) byLoopPoint[point].steps = steps;
  if (contributions.length) byLoopPoint[point].contributions = contributions;
  if (gates[point]) byLoopPoint[point].gates = gates[point];
  return { byLoopPoint, configSchema };
}

// ─── Temp project helpers ─────────────────────────────────────────────────────

let tmpProjectDir;
// A project with NO .planning/config.json — relies on schema defaults
let tmpEmptyProjectDir;
// A project where ui_phase is explicitly false in root config
let tmpFalseConfigProjectDir;
// Runtime config dir whose surface disables the UI capability
let tmpUiDisabledConfigDir;

before(() => {
  tmpProjectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-resolver-test-'));
  const planningDir = path.join(tmpProjectDir, '.planning');
  fs.mkdirSync(planningDir, { recursive: true });
  // Write minimal config.json with all UI flags enabled
  fs.writeFileSync(
    path.join(planningDir, 'config.json'),
    JSON.stringify({ workflow: { ui_phase: true, ui_review: true, ui_safety_gate: true } }),
    'utf8',
  );

  // Empty project — no config.json: schema defaults drive activation
  tmpEmptyProjectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-resolver-empty-'));
  fs.mkdirSync(path.join(tmpEmptyProjectDir, '.planning'), { recursive: true });

  // False config project — ui_phase explicitly false in root config
  tmpFalseConfigProjectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-resolver-false-'));
  const falseConfigPlanningDir = path.join(tmpFalseConfigProjectDir, '.planning');
  fs.mkdirSync(falseConfigPlanningDir, { recursive: true });
  fs.writeFileSync(
    path.join(falseConfigPlanningDir, 'config.json'),
    JSON.stringify({ workflow: { ui_phase: false, ui_review: false, ui_safety_gate: false } }),
    'utf8',
  );

  tmpUiDisabledConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-resolver-ui-disabled-'));
  fs.writeFileSync(
    path.join(tmpUiDisabledConfigDir, '.gsd-surface.json'),
    JSON.stringify({
      baseProfile: 'full',
      disabledClusters: ['ui'],
      explicitAdds: [],
      explicitRemoves: [],
    }, null, 2),
    'utf8',
  );
});

after(() => {
  if (tmpProjectDir) cleanup(tmpProjectDir);
  if (tmpEmptyProjectDir) cleanup(tmpEmptyProjectDir);
  if (tmpFalseConfigProjectDir) cleanup(tmpFalseConfigProjectDir);
  if (tmpUiDisabledConfigDir) cleanup(tmpUiDisabledConfigDir);
});

// ─── 1. Canonical-point validation ───────────────────────────────────────────

describe('canonical point validation', () => {
  test('all 12 canonical points are accepted by resolveLoopHooks with empty registry', () => {
    const emptyRegistry = makeRegistry();
    const config = {};
    for (const p of CANONICAL_POINTS_FALLBACK) {
      const result = resolveLoopHooks({ point: p, registry: emptyRegistry, config });
      assert.strictEqual(result.point, p);
      assert.deepEqual(result.activeHooks, []);
    }
  });

  test('12 canonical points total', () => {
    assert.strictEqual(CANONICAL_POINTS_FALLBACK.length, 12);
  });

  test('invalid point throws with a clear message', () => {
    const emptyRegistry = makeRegistry();
    assert.throws(
      () => resolveLoopHooks({ point: 'plan:mid', registry: emptyRegistry, config: {} }),
      (err) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /Invalid loop point/);
        assert.match(err.message, /plan:mid/);
        return true;
      },
    );
  });

  test('empty string point throws', () => {
    const emptyRegistry = makeRegistry();
    assert.throws(
      () => resolveLoopHooks({ point: '', registry: emptyRegistry, config: {} }),
      /Invalid loop point/,
    );
  });

  test('close typo throws', () => {
    const emptyRegistry = makeRegistry();
    assert.throws(
      () => resolveLoopHooks({ point: 'plan:pre ', registry: emptyRegistry, config: {} }),
      /Invalid loop point/,
    );
  });

  // FIX 2: non-canonical point rejected even if the registry has it as a byLoopPoint key
  test('non-canonical point in registry byLoopPoint is still rejected', () => {
    // Craft a registry that has a synthetic non-canonical key in byLoopPoint
    const registry = {
      byLoopPoint: {
        // All canonical points (needed so the registry is well-formed)
        ...Object.fromEntries(CANONICAL_POINTS_FALLBACK.map(p => [p, { steps: [], contributions: [], gates: [] }])),
        // A non-canonical key that a malformed registry might inject
        'inject:arbitrary': { steps: [{ capId: 'evil', ref: { skill: 'bad' } }], contributions: [], gates: [] },
      },
    };
    assert.throws(
      () => resolveLoopHooks({ point: 'inject:arbitrary', registry, config: {} }),
      /Invalid loop point/,
    );
  });

  // FIX 2: all 12 canonical points are listed in the error message
  test('invalid point error lists the canonical 12', () => {
    const emptyRegistry = makeRegistry();
    assert.throws(
      () => resolveLoopHooks({ point: 'not:real', registry: emptyRegistry, config: {} }),
      (err) => {
        assert.ok(err instanceof Error);
        for (const p of CANONICAL_POINTS_FALLBACK) {
          assert.ok(err.message.includes(p), `Expected "${p}" in error message: ${err.message}`);
        }
        return true;
      },
    );
  });

  // CANONICAL_POINTS is derived from LOOP_HOST_CONTRACT, not from registry keys
  test('CANONICAL_POINTS and CANONICAL_POINTS_FALLBACK are the same 12 points', () => {
    assert.deepEqual(CANONICAL_POINTS, CANONICAL_POINTS_FALLBACK);
    assert.strictEqual(CANONICAL_POINTS.length, 12);
  });
});

// ─── 2. Activation tests ─────────────────────────────────────────────────────

describe('activation filter', () => {
  test('hook with no "when" is always active', () => {
    const registry = makeRegistry({
      steps: [{ capId: 'test-cap', point: 'plan:pre', ref: { skill: 'my-skill' } }],
    });
    const result = resolveLoopHooks({ point: 'plan:pre', registry, config: {} });
    assert.strictEqual(result.activeHooks.length, 1);
    assert.strictEqual(result.activeHooks[0].capId, 'test-cap');
  });

  test('hook with when="mytool.on", config{mytool:{on:true}} → active', () => {
    const registry = makeRegistry({
      steps: [{ capId: 'test-cap', point: 'plan:pre', ref: { skill: 'my-skill' }, when: 'mytool.on' }],
    });
    const config = { mytool: { on: true } };
    const result = resolveLoopHooks({ point: 'plan:pre', registry, config });
    assert.strictEqual(result.activeHooks.length, 1);
    assert.strictEqual(result.activeHooks[0].kind, 'step');
  });

  test('hook with when="mytool.on", config{mytool:{on:false}} → filtered', () => {
    const registry = makeRegistry({
      steps: [{ capId: 'test-cap', point: 'plan:pre', ref: { skill: 'my-skill' }, when: 'mytool.on' }],
    });
    const config = { mytool: { on: false } };
    const result = resolveLoopHooks({ point: 'plan:pre', registry, config });
    assert.strictEqual(result.activeHooks.length, 0);
  });

  test('hook with when="mytool.on", config{} (absent key) → filtered', () => {
    const registry = makeRegistry({
      steps: [{ capId: 'test-cap', point: 'plan:pre', ref: { skill: 'my-skill' }, when: 'mytool.on' }],
    });
    const result = resolveLoopHooks({ point: 'plan:pre', registry, config: {} });
    assert.strictEqual(result.activeHooks.length, 0);
  });

  test('hook with when="mytool.on", config{mytool:{}} → filtered (key absent)', () => {
    const registry = makeRegistry({
      steps: [{ capId: 'test-cap', point: 'plan:pre', ref: { skill: 'my-skill' }, when: 'mytool.on' }],
    });
    const config = { mytool: {} };
    const result = resolveLoopHooks({ point: 'plan:pre', registry, config });
    assert.strictEqual(result.activeHooks.length, 0);
  });

  // FIX 3: non-string `when` → INACTIVE (not always-active)
  test('hook with when=true (boolean) → inactive (FIX 3: malformed non-string when)', () => {
    const registry = makeRegistry({
      steps: [{ capId: 'test-cap', point: 'plan:pre', ref: { skill: 'my-skill' }, when: true }],
    });
    const result = resolveLoopHooks({ point: 'plan:pre', registry, config: {} });
    assert.strictEqual(result.activeHooks.length, 0, 'non-string when=true must be treated as inactive');
  });

  test('hook with when=42 (number) → inactive (FIX 3)', () => {
    const registry = makeRegistry({
      steps: [{ capId: 'test-cap', point: 'plan:pre', ref: { skill: 'my-skill' }, when: 42 }],
    });
    const result = resolveLoopHooks({ point: 'plan:pre', registry, config: {} });
    assert.strictEqual(result.activeHooks.length, 0, 'non-string when=42 must be inactive');
  });

  test('hook with when={} (object) → inactive (FIX 3)', () => {
    const registry = makeRegistry({
      steps: [{ capId: 'test-cap', point: 'plan:pre', ref: { skill: 'my-skill' }, when: {} }],
    });
    const result = resolveLoopHooks({ point: 'plan:pre', registry, config: {} });
    assert.strictEqual(result.activeHooks.length, 0, 'non-string when={} must be inactive');
  });

  // FIX 4: configSchema default=true → active with absent config (no cwd → level 4 applies)
  test('configSchema default=true + absent config → active', () => {
    const registry = makeRegistry({
      steps: [{ capId: 'test-cap', point: 'plan:pre', ref: { skill: 'my-skill' }, when: 'mytool.on' }],
      configSchema: {
        'mytool.on': { type: 'boolean', default: true, description: 'Enable mytool.' },
      },
    });
    const result = resolveLoopHooks({ point: 'plan:pre', registry, config: {} });
    assert.strictEqual(result.activeHooks.length, 1, 'schema default=true should activate the hook');
    assert.strictEqual(result.activeHooks[0].capId, 'test-cap');
  });

  // FIX 4: configSchema default=false → inactive with absent config
  test('configSchema default=false + absent config → inactive', () => {
    const registry = makeRegistry({
      steps: [{ capId: 'test-cap', point: 'plan:pre', ref: { skill: 'my-skill' }, when: 'mytool.on' }],
      configSchema: {
        'mytool.on': { type: 'boolean', default: false, description: 'Disabled by default.' },
      },
    });
    const result = resolveLoopHooks({ point: 'plan:pre', registry, config: {} });
    assert.strictEqual(result.activeHooks.length, 0, 'schema default=false should keep hook inactive');
  });

  // FIX 4: configSchema default=true but explicit config override=false → inactive (config wins)
  test('configSchema default=true but config override false → inactive (config wins)', () => {
    const registry = makeRegistry({
      steps: [{ capId: 'test-cap', point: 'plan:pre', ref: { skill: 'my-skill' }, when: 'mytool.on' }],
      configSchema: {
        'mytool.on': { type: 'boolean', default: true, description: 'Enabled by default.' },
      },
    });
    const config = { mytool: { on: false } };
    const result = resolveLoopHooks({ point: 'plan:pre', registry, config });
    assert.strictEqual(result.activeHooks.length, 0, 'explicit config=false overrides schema default=true');
  });
});

// ─── 2b. pointFrom gate (#3661, 50-test-matrix.md Section B) ────────────────

describe('activation filter: pointFrom gate (#3661, matrix Section B)', () => {
  test('B1: isActiveUnchangedForWhenOnlyStepTruthy — when-only step, when truthy → active (unchanged)', () => {
    const registry = makeRegistry({
      steps: [{ capId: 'test-cap', point: 'plan:pre', ref: { skill: 'my-skill' }, when: 'mytool.on' }],
    });
    const config = { mytool: { on: true } };
    const result = resolveLoopHooks({ point: 'plan:pre', registry, config });
    assert.strictEqual(result.activeHooks.length, 1);
  });

  test('B2: isActiveUnchangedForWhenOnlyStepFalsy — when-only step, when falsy → inactive (unchanged)', () => {
    const registry = makeRegistry({
      steps: [{ capId: 'test-cap', point: 'plan:pre', ref: { skill: 'my-skill' }, when: 'mytool.on' }],
    });
    const config = { mytool: { on: false } };
    const result = resolveLoopHooks({ point: 'plan:pre', registry, config });
    assert.strictEqual(result.activeHooks.length, 0);
  });

  test('B3: isActiveTrueWhenBothGatesPass — when truthy AND pointFrom matching point → active', () => {
    const registry = makeRegistry({
      steps: [{ capId: 'test-cap', point: 'plan:pre', ref: { skill: 'my-skill' }, when: 'mytool.on', pointFrom: 'mytool.point' }],
      configSchema: { 'mytool.point': { type: 'enum', values: ['plan:pre', 'plan:post'], default: 'plan:pre', description: 'x' } },
    });
    const config = { mytool: { on: true } };
    const result = resolveLoopHooks({ point: 'plan:pre', registry, config });
    assert.strictEqual(result.activeHooks.length, 1);
  });

  test('B4: isActiveFalseWhenPointFromMismatchesDespiteWhenTrue — AND semantics: pointFrom mismatch wins', () => {
    const registry = makeRegistry({
      steps: [{ capId: 'test-cap', point: 'plan:pre', ref: { skill: 'my-skill' }, when: 'mytool.on', pointFrom: 'mytool.point' }],
      configSchema: { 'mytool.point': { type: 'enum', values: ['plan:pre', 'plan:post'], default: 'plan:post', description: 'x' } },
    });
    const config = { mytool: { on: true } };
    const result = resolveLoopHooks({ point: 'plan:pre', registry, config });
    assert.strictEqual(result.activeHooks.length, 0);
  });

  test('B5: isActiveFalseWhenWhenFalseDespitePointFromMatch — AND semantics: when short-circuits', () => {
    const registry = makeRegistry({
      steps: [{ capId: 'test-cap', point: 'plan:pre', ref: { skill: 'my-skill' }, when: 'mytool.on', pointFrom: 'mytool.point' }],
      configSchema: { 'mytool.point': { type: 'enum', values: ['plan:pre', 'plan:post'], default: 'plan:pre', description: 'x' } },
    });
    const config = { mytool: { on: false } };
    const result = resolveLoopHooks({ point: 'plan:pre', registry, config });
    assert.strictEqual(result.activeHooks.length, 0);
  });

  test('B6: resolveLoopHooksSelectsExactlyOneOfTwoPointRegistrations — no cross-point leakage', () => {
    const byLoopPoint = {};
    for (const p of CANONICAL_POINTS_FALLBACK) byLoopPoint[p] = { steps: [], contributions: [], gates: [] };
    byLoopPoint['plan:pre'].steps = [
      { capId: 'test-cap', point: 'plan:pre', ref: { skill: 'a' }, when: 'mytool.on', pointFrom: 'mytool.point' },
    ];
    byLoopPoint['plan:post'].steps = [
      { capId: 'test-cap', point: 'plan:post', ref: { skill: 'a' }, when: 'mytool.on', pointFrom: 'mytool.point' },
    ];
    const registry = {
      byLoopPoint,
      configSchema: { 'mytool.point': { type: 'enum', values: ['plan:pre', 'plan:post'], default: 'plan:pre', description: 'x' } },
    };
    const config = { mytool: { on: true } };
    const resultPre = resolveLoopHooks({ point: 'plan:pre', registry, config });
    const resultPost = resolveLoopHooks({ point: 'plan:post', registry, config });
    assert.strictEqual(resultPre.activeHooks.length, 1, 'point A must have exactly one active hook');
    assert.strictEqual(resultPost.activeHooks.length, 0, 'point B must have no active hooks — no leakage');
  });

  test('B7: resolveLoopHooksBothPointsInactiveOnOutOfEnumValue — fail-closed on a typo', () => {
    const byLoopPoint = {};
    for (const p of CANONICAL_POINTS_FALLBACK) byLoopPoint[p] = { steps: [], contributions: [], gates: [] };
    byLoopPoint['plan:pre'].steps = [
      { capId: 'test-cap', point: 'plan:pre', ref: { skill: 'a' }, when: 'mytool.on', pointFrom: 'mytool.point' },
    ];
    byLoopPoint['plan:post'].steps = [
      { capId: 'test-cap', point: 'plan:post', ref: { skill: 'a' }, when: 'mytool.on', pointFrom: 'mytool.point' },
    ];
    const registry = {
      byLoopPoint,
      configSchema: { 'mytool.point': { type: 'enum', values: ['plan:pre', 'plan:post'], default: 'plan:pre', description: 'x' } },
    };
    const badConfig = { mytool: { on: true, point: 'bogus' } };
    const resultPre = resolveLoopHooks({ point: 'plan:pre', registry, config: badConfig });
    const resultPost = resolveLoopHooks({ point: 'plan:post', registry, config: badConfig });
    assert.strictEqual(resultPre.activeHooks.length, 0, 'an out-of-enum value must not revive the step at either point');
    assert.strictEqual(resultPost.activeHooks.length, 0, 'an out-of-enum value must not revive the step at either point');
  });

  test('B8: isActiveFalseWhenCapabilityInactiveDespitePointFromMatch — capability gate still cascades', () => {
    const registry = makeRegistry({
      steps: [{ capId: 'test-cap', point: 'plan:pre', ref: { skill: 'my-skill' }, when: 'mytool.on', pointFrom: 'mytool.point' }],
      configSchema: { 'mytool.point': { type: 'enum', values: ['plan:pre', 'plan:post'], default: 'plan:pre', description: 'x' } },
    });
    const config = { mytool: { on: true } };
    const capabilityStatesById = new Map([['test-cap', { enabled: true, active: false }]]);
    const result = resolveLoopHooks({ point: 'plan:pre', registry, config, capabilityStatesById });
    assert.strictEqual(
      result.activeHooks.length, 0,
      'capability-level active=false must suppress the hook regardless of pointFrom match',
    );
  });
});

// ─── 3. UI pilot integration tests ───────────────────────────────────────────

describe('UI pilot integration', () => {
  test('plan:pre with workflow.ui_phase=true → ui-phase step active', () => {
    const config = { workflow: { ui_phase: true, ui_review: true, ui_safety_gate: true } };
    const result = resolveLoopHooks({ point: 'plan:pre', registry: realRegistry, config });
    const uiStep = result.activeHooks.find(h => h.capId === 'ui' && h.kind === 'step');
    assert.ok(uiStep, 'Expected ui step at plan:pre');
    assert.deepEqual(uiStep.ref, { skill: 'ui-phase' });
    assert.ok(Array.isArray(uiStep.produces));
    assert.ok(uiStep.produces.includes('UI-SPEC.md'));
  });

  test('plan:pre with workflow.ui_phase=false → ui-phase step filtered', () => {
    const config = { workflow: { ui_phase: false, ui_review: true, ui_safety_gate: true } };
    const result = resolveLoopHooks({ point: 'plan:pre', registry: realRegistry, config });
    const uiStep = result.activeHooks.find(h => h.capId === 'ui' && h.kind === 'step');
    assert.strictEqual(uiStep, undefined, 'Expected ui step to be filtered');
  });

  // FIX 4 INVERSION: empty config + real registry → ui-phase IS active (schema default=true)
  test('plan:pre with empty config + real registry → ui-phase step active by default (FIX 4)', () => {
    // realRegistry has configSchema['workflow.ui_phase'].default === true
    // So with no config and no cwd, the schema default kicks in → active
    const result = resolveLoopHooks({ point: 'plan:pre', registry: realRegistry, config: {} });
    const uiStep = result.activeHooks.find(h => h.capId === 'ui' && h.kind === 'step');
    assert.ok(
      uiStep,
      'Expected ui step to be active by default (configSchema.default=true). Got: ' +
        JSON.stringify(result.activeHooks),
    );
    assert.strictEqual(uiStep.when, 'workflow.ui_phase');
  });

  test('execute:wave:post with workflow.ui_safety_gate=true → ui gate active', () => {
    const config = { workflow: { ui_phase: true, ui_review: true, ui_safety_gate: true } };
    const result = resolveLoopHooks({ point: 'execute:wave:post', registry: realRegistry, config });
    const uiGate = result.activeHooks.find(h => h.capId === 'ui' && h.kind === 'gate');
    assert.ok(uiGate, 'Expected ui gate at execute:wave:post');
    assert.strictEqual(uiGate.blocking, true);
    assert.strictEqual(uiGate.onError, 'halt');
  });

  test('execute:wave:post with workflow.ui_safety_gate=false → ui gate filtered', () => {
    const config = { workflow: { ui_phase: true, ui_review: true, ui_safety_gate: false } };
    const result = resolveLoopHooks({ point: 'execute:wave:post', registry: realRegistry, config });
    const uiGate = result.activeHooks.find(h => h.capId === 'ui' && h.kind === 'gate');
    assert.strictEqual(uiGate, undefined, 'Expected ui gate to be filtered');
  });

  // FIX 4: execute:wave:post with empty config → ui gate active by schema default
  test('execute:wave:post with empty config → ui gate active by schema default', () => {
    const result = resolveLoopHooks({ point: 'execute:wave:post', registry: realRegistry, config: {} });
    const uiGate = result.activeHooks.find(h => h.capId === 'ui' && h.kind === 'gate');
    assert.ok(uiGate, 'Expected ui gate active by default (configSchema.default=true)');
    assert.strictEqual(uiGate.blocking, true);
  });
});

// ─── 3b. #3661 — code-review capability.json + generated registry structural
//         assertions (50-test-matrix.md Section F, rows F2-F3) ────────────────
//
// Loads the REAL generated registry (built by `npm run build:lib` +
// `node scripts/gen-capability-registry.cjs --write`) — no source-grep, this
// is the same `realRegistry` object the "UI pilot integration" tests above
// already use for behavioral (not text) assertions.

describe('#3661: code-review capability.json + generated registry (matrix Section F, F2-F3)', () => {
  test('F2: registryConfigSchemaHasCodeReviewPointEnum', () => {
    const slice = realRegistry.configSchema['workflow.code_review_point'];
    assert.ok(slice, 'registry.configSchema must contain workflow.code_review_point');
    assert.strictEqual(slice.type, 'enum');
    assert.deepStrictEqual(slice.values, ['execute:post', 'execute:wave:post']);
    assert.strictEqual(slice.default, 'execute:post');
    assert.strictEqual(slice.owner, 'code-review');
  });

  test('F3: registryRegistersCodeReviewStepAtBothPoints', () => {
    const postSteps = realRegistry.byLoopPoint['execute:post'].steps;
    const wavePostSteps = realRegistry.byLoopPoint['execute:wave:post'].steps;
    assert.ok(Array.isArray(postSteps), 'execute:post.steps must be an array');
    assert.ok(Array.isArray(wavePostSteps), 'execute:wave:post.steps must be an array');

    const postStep = postSteps.find((s) => s.capId === 'code-review' && s.ref && s.ref.skill === 'code-review');
    const wavePostStep = wavePostSteps.find((s) => s.capId === 'code-review' && s.ref && s.ref.skill === 'code-review');
    assert.ok(postStep, 'execute:post.steps must contain a code-review step. Got: ' + JSON.stringify(postSteps));
    assert.ok(wavePostStep, 'execute:wave:post.steps must contain a code-review step. Got: ' + JSON.stringify(wavePostSteps));
  });

  test('F5: realRegistryProjectsSupportsReviewerLanesOnCodeReviewActiveHook', () => {
    const result = resolveLoopHooks({ point: 'execute:post', registry: realRegistry, config: { workflow: { code_review: true } } });
    const hook = result.activeHooks.find((h) => h.capId === 'code-review' && h.ref && h.ref.skill === 'code-review');
    assert.ok(hook, 'Expected an active code-review hook at execute:post. Got: ' + JSON.stringify(result.activeHooks));
    assert.strictEqual(hook.supportsReviewerLanes, true, 'Expected the real code-review active hook to carry supportsReviewerLanes: true');
  });

  // F4-F7 (CLI-behavioral: gsd_run loop render-hooks / config-set through the real
  // subprocess, against a temp git project) live in tests/code-review.test.cjs's
  // 'CR-CONFIG: config key registration' describe block, alongside the sibling
  // workflow.code_review / workflow.code_review_depth CLI round-trip tests.

});

// ─── #4209 DISP-02: step.supportsReviewerLanes projection (provider-neutral) ──

describe('#4209 DISP-02: step.supportsReviewerLanes projection (provider-neutral)', () => {
  test('projects literal true onto the active hook for a synthetic non-code-review step', () => {
    const registry = makeRegistry({
      point: 'execute:post',
      steps: [{ capId: 'synthetic-reviewer-cap', point: 'execute:post', ref: { skill: 'synthetic-skill' }, supportsReviewerLanes: true }],
    });
    const result = resolveLoopHooks({ point: 'execute:post', registry, config: {} });
    const hook = result.activeHooks.find((h) => h.capId === 'synthetic-reviewer-cap');
    assert.ok(hook, 'Expected the synthetic step to be active');
    assert.strictEqual(hook.supportsReviewerLanes, true);
  });

  test('omitted supportsReviewerLanes is inert (field absent on active hook)', () => {
    const registry = makeRegistry({
      point: 'execute:post',
      steps: [{ capId: 'synthetic-reviewer-cap', point: 'execute:post', ref: { skill: 'synthetic-skill' } }],
    });
    const result = resolveLoopHooks({ point: 'execute:post', registry, config: {} });
    const hook = result.activeHooks.find((h) => h.capId === 'synthetic-reviewer-cap');
    assert.ok(hook, 'Expected the synthetic step to be active');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(hook, 'supportsReviewerLanes'), false, 'Expected no supportsReviewerLanes key when omitted');
  });

  test('literal false is inert (field absent on active hook, not carried as false)', () => {
    const registry = makeRegistry({
      point: 'execute:post',
      steps: [{ capId: 'synthetic-reviewer-cap', point: 'execute:post', ref: { skill: 'synthetic-skill' }, supportsReviewerLanes: false }],
    });
    const result = resolveLoopHooks({ point: 'execute:post', registry, config: {} });
    const hook = result.activeHooks.find((h) => h.capId === 'synthetic-reviewer-cap');
    assert.ok(hook, 'Expected the synthetic step to be active');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(hook, 'supportsReviewerLanes'), false, 'Expected no supportsReviewerLanes key when false');
  });
});

// ─── 4. Ordering tests ────────────────────────────────────────────────────────

describe('hook ordering', () => {
  test('steps appear before contributions before gates', () => {
    const registry = makeRegistry({
      point: 'plan:pre',
      steps: [{ capId: 'c1', point: 'plan:pre', ref: { skill: 'sk1' } }],
      contributions: [{ capId: 'c2', point: 'plan:pre', into: 'planner' }],
      gates: { 'plan:pre': [{ capId: 'c3', point: 'plan:pre', check: { query: 'some-gate' }, blocking: false }] },
    });
    const config = {};
    const result = resolveLoopHooks({ point: 'plan:pre', registry, config });
    assert.strictEqual(result.activeHooks.length, 3);
    assert.strictEqual(result.activeHooks[0].kind, 'step');
    assert.strictEqual(result.activeHooks[1].kind, 'contribution');
    assert.strictEqual(result.activeHooks[2].kind, 'gate');
  });

  test('within steps, registry order is preserved', () => {
    const registry = makeRegistry({
      point: 'plan:pre',
      steps: [
        { capId: 'cap-a', point: 'plan:pre', ref: { skill: 'a' } },
        { capId: 'cap-b', point: 'plan:pre', ref: { skill: 'b' } },
        { capId: 'cap-c', point: 'plan:pre', ref: { skill: 'c' } },
      ],
    });
    const result = resolveLoopHooks({ point: 'plan:pre', registry, config: {} });
    assert.deepEqual(result.activeHooks.map(h => h.capId), ['cap-a', 'cap-b', 'cap-c']);
  });
});

// ─── 5. Envelope shape ────────────────────────────────────────────────────────

describe('envelope shape', () => {
  test('envelope has point, activeHooks, rendered from renderLoopHooks', () => {
    const registry = makeRegistry({
      steps: [{ capId: 'cap-a', point: 'plan:pre', ref: { skill: 'my-skill' }, produces: ['A.md'], consumes: ['B.md'] }],
    });
    const resolved = resolveLoopHooks({ point: 'plan:pre', registry, config: {} });
    const rendered = renderLoopHooks(resolved);
    assert.strictEqual(resolved.point, 'plan:pre');
    assert.ok(Array.isArray(resolved.activeHooks));
    assert.strictEqual(typeof rendered, 'string');
  });

  test('empty activeHooks → rendered is non-empty placeholder string', () => {
    const registry = makeRegistry(); // all empty
    const resolved = resolveLoopHooks({ point: 'plan:pre', registry, config: {} });
    const rendered = renderLoopHooks(resolved);
    assert.strictEqual(resolved.activeHooks.length, 0);
    assert.ok(rendered.length > 0, 'rendered should be a non-empty placeholder');
    assert.match(rendered, /plan:pre/);
  });

  test('rendered contains hook content when hooks are active', () => {
    const registry = makeRegistry({
      steps: [{ capId: 'ui', point: 'plan:pre', ref: { skill: 'ui-phase' }, produces: ['UI-SPEC.md'], consumes: ['CONTEXT.md'], when: 'workflow.ui_phase', onError: 'skip' }],
    });
    const config = { workflow: { ui_phase: true } };
    const resolved = resolveLoopHooks({ point: 'plan:pre', registry, config });
    const rendered = renderLoopHooks(resolved);
    assert.match(rendered, /ui-phase/);
    assert.match(rendered, /ui/);
    assert.match(rendered, /UI-SPEC\.md/);
  });

  test('rendered for UI pilot at plan:pre with all flags on', () => {
    const config = { workflow: { ui_phase: true, ui_review: true, ui_safety_gate: true } };
    const resolved = resolveLoopHooks({ point: 'plan:pre', registry: realRegistry, config });
    const rendered = renderLoopHooks(resolved);
    assert.match(rendered, /ui-phase/);
    assert.match(rendered, /UI-SPEC\.md/);
  });
});

// ─── 6. Malformed registry resilience ────────────────────────────────────────

describe('malformed registry resilience', () => {
  test('missing byLoopPoint → no throw, empty activeHooks', () => {
    const badRegistry = {}; // no byLoopPoint
    // No throw — but point validation falls back to CANONICAL_POINTS_FALLBACK
    const result = resolveLoopHooks({ point: 'plan:pre', registry: badRegistry, config: {} });
    assert.strictEqual(result.activeHooks.length, 0);
  });

  test('null hook in steps array → skipped', () => {
    const registry = makeRegistry({
      steps: [null, { capId: 'ok', point: 'plan:pre', ref: { skill: 'ok-skill' } }, undefined],
    });
    const result = resolveLoopHooks({ point: 'plan:pre', registry, config: {} });
    assert.strictEqual(result.activeHooks.length, 1);
    assert.strictEqual(result.activeHooks[0].capId, 'ok');
  });

  test('byLoopPoint[point] missing arrays → no throw, empty result', () => {
    const registry = { byLoopPoint: { 'plan:pre': {} } }; // no steps/contributions/gates keys
    const result = resolveLoopHooks({ point: 'plan:pre', registry, config: {} });
    assert.strictEqual(result.activeHooks.length, 0);
  });

  test('byLoopPoint[point] has non-array steps → treated as empty', () => {
    const registry = { byLoopPoint: { 'plan:pre': { steps: 'bad', contributions: [], gates: [] } } };
    const result = resolveLoopHooks({ point: 'plan:pre', registry, config: {} });
    assert.strictEqual(result.activeHooks.length, 0);
  });

  test('byLoopPoint[point] is null → no throw, empty result', () => {
    const registry = { byLoopPoint: { 'plan:pre': null } };
    const result = resolveLoopHooks({ point: 'plan:pre', registry, config: {} });
    assert.strictEqual(result.activeHooks.length, 0);
  });
});

// ─── 7. Prototype-pollution guard ────────────────────────────────────────────

describe('prototype-pollution guard', () => {
  test('when="__proto__.x" does not pollute Object.prototype', () => {
    const registry = makeRegistry({
      steps: [{ capId: 'attacker', point: 'plan:pre', ref: { skill: 'evil' }, when: '__proto__.x' }],
    });
    const config = { x: 'injected' };
    // Should not throw and should not activate (guard returns found:false)
    const result = resolveLoopHooks({ point: 'plan:pre', registry, config });
    assert.strictEqual(result.activeHooks.length, 0);
    // Object.prototype must not be polluted
    assert.strictEqual(({}).x, undefined);
  });

  test('when="constructor.x" does not pollute', () => {
    const registry = makeRegistry({
      steps: [{ capId: 'attacker', point: 'plan:pre', ref: { skill: 'evil' }, when: 'constructor.x' }],
    });
    const result = resolveLoopHooks({ point: 'plan:pre', registry, config: {} });
    assert.strictEqual(result.activeHooks.length, 0);
  });

  test('when="prototype.x" does not pollute', () => {
    const registry = makeRegistry({
      steps: [{ capId: 'attacker', point: 'plan:pre', ref: { skill: 'evil' }, when: 'prototype.x' }],
    });
    const result = resolveLoopHooks({ point: 'plan:pre', registry, config: {} });
    assert.strictEqual(result.activeHooks.length, 0);
  });

  test('_getNestedConfigValue: __proto__ segment returns found:false', () => {
    const r = _getNestedConfigValue({}, '__proto__.x');
    assert.strictEqual(r.found, false);
  });

  test('_getNestedConfigValue: constructor segment returns found:false', () => {
    const r = _getNestedConfigValue({}, 'constructor.toString');
    assert.strictEqual(r.found, false);
  });

  test('_getNestedConfigValue: normal dotted key traversal works', () => {
    const config = { workflow: { ui_phase: true } };
    const r = _getNestedConfigValue(config, 'workflow.ui_phase');
    assert.strictEqual(r.found, true);
    assert.strictEqual(r.value, true);
  });

  // FIX 4: raw config.json with __proto__ key does not pollute via _readRawConfigKey
  test('raw config.json with "__proto__" key does not pollute Object.prototype', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-resolver-proto-'));
    try {
      // Write a raw config.json containing __proto__ at top level and nested
      // (JSON.parse of {"__proto__":{"x":"polluted"}} does NOT set prototype in modern Node,
      // but we verify our guarded traversal returns found:false for such keys)
      const maliciousConfig = '{"__proto__":{"x":"polluted"},"workflow":{"ui_phase":true}}';
      fs.writeFileSync(path.join(tmpDir, 'config.json'), maliciousConfig, 'utf8');
      // _readRawConfigKey with '__proto__.x' should return found:false (guard)
      const r1 = _readRawConfigKey(path.join(tmpDir, 'config.json'), '__proto__.x');
      assert.strictEqual(r1.found, false, '__proto__ lookup must be guarded');
      // Normal key should work
      const r2 = _readRawConfigKey(path.join(tmpDir, 'config.json'), 'workflow.ui_phase');
      assert.strictEqual(r2.found, true);
      assert.strictEqual(r2.value, true);
      // Object.prototype must not be polluted
      assert.strictEqual(({}).x, undefined);
    } finally {
      cleanup(tmpDir);
    }
  });

  // FIX 4: _resolveActivationValue with cwd pointing to project with __proto__ config key
  test('_resolveActivationValue: raw config with __proto__ key does not pollute', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-resolver-proto2-'));
    try {
      const planningDir = path.join(tmpDir, '.planning');
      fs.mkdirSync(planningDir, { recursive: true });
      fs.writeFileSync(
        path.join(planningDir, 'config.json'),
        '{"__proto__":{"y":"polluted2"}}',
        'utf8',
      );
      const registry = makeRegistry({
        steps: [{ capId: 'test', point: 'plan:pre', ref: { skill: 'sk' }, when: '__proto__.y' }],
      });
      const result = resolveLoopHooks({ point: 'plan:pre', registry, config: {}, cwd: tmpDir });
      assert.strictEqual(result.activeHooks.length, 0, '__proto__ when must be inactive');
      assert.strictEqual(({}).y, undefined, 'Object.prototype.y must not be polluted');
    } finally {
      cleanup(tmpDir);
    }
  });
});

// ─── 7b. Raw config.json override paths (FIX 4) ──────────────────────────────

describe('raw config.json override paths (FIX 4)', () => {
  // FIX 4: user sets workflow.ui_phase=false in root config.json → hook filtered
  test('root config.json with ui_phase=false overrides schema default=true → inactive', () => {
    // tmpFalseConfigProjectDir has .planning/config.json { workflow: { ui_phase: false } }
    const result = resolveLoopHooks({
      point: 'plan:pre',
      registry: realRegistry,
      config: {}, // empty loadConfig result (simulating pre-cutover)
      cwd: tmpFalseConfigProjectDir,
    });
    const uiStep = result.activeHooks.find(h => h.capId === 'ui' && h.kind === 'step');
    assert.strictEqual(
      uiStep,
      undefined,
      'root config.json override false must beat schema default=true',
    );
  });

  // FIX 4: root config.json with ui_phase=true (explicit) → hook active
  test('root config.json with ui_phase=true → active (raw config read path)', () => {
    // tmpProjectDir has .planning/config.json { workflow: { ui_phase: true } }
    const result = resolveLoopHooks({
      point: 'plan:pre',
      registry: realRegistry,
      config: {}, // empty loadConfig result (simulating pre-cutover)
      cwd: tmpProjectDir,
    });
    const uiStep = result.activeHooks.find(h => h.capId === 'ui' && h.kind === 'step');
    assert.ok(uiStep, 'root config.json ui_phase=true should activate hook');
  });

  // FIX 4: no config.json at all → falls through to schema default=true → active
  test('no config.json → schema default=true → hook active', () => {
    // tmpEmptyProjectDir has .planning/ directory but no config.json
    const result = resolveLoopHooks({
      point: 'plan:pre',
      registry: realRegistry,
      config: {}, // empty loadConfig result
      cwd: tmpEmptyProjectDir,
    });
    const uiStep = result.activeHooks.find(h => h.capId === 'ui' && h.kind === 'step');
    assert.ok(uiStep, 'no config.json → schema default=true → hook should be active');
  });

  // FIX 4: _readRawConfigKey returns found:false for missing file (ENOENT — silent)
  test('_readRawConfigKey: missing file → found:false, no throw', () => {
    const result = _readRawConfigKey('/nonexistent/path/config.json', 'workflow.ui_phase');
    assert.strictEqual(result.found, false);
  });

  // FIX 4: _readRawConfigKey returns found:false for malformed JSON, warns once
  test('_readRawConfigKey: malformed JSON → found:false, no throw', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-resolver-malformed-'));
    try {
      const malformedPath = path.join(tmpDir, 'config.json');
      fs.writeFileSync(malformedPath, '{ invalid json }', 'utf8');
      const result = _readRawConfigKey(malformedPath, 'workflow.ui_phase');
      assert.strictEqual(result.found, false, 'malformed JSON should return found:false');
    } finally {
      cleanup(tmpDir);
    }
  });
});

// ─── 8. Renderer tests ────────────────────────────────────────────────────────

describe('renderLoopHooks', () => {
  test('#5360: every registered skill step renders a shipped capability skill', () => {
    let checked = 0;
    for (const [point, hooks] of Object.entries(realRegistry.byLoopPoint)) {
      for (const step of hooks.steps) {
        if (!step.ref?.skill) continue;
        const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'capabilities', step.capId, 'capability.json'), 'utf8'));
        assert.ok(manifest.skills.includes(step.ref.skill), `${step.capId} declares ${step.ref.skill}`);
        const rendered = renderLoopHooks({ point, activeHooks: [{ ...step, kind: 'step' }] });
        const id = rendered.split('\n')[0].split('skill:')[1].split(' ')[0];
        const stem = id.slice('gsd-'.length);
        assert.equal(stem, step.ref.skill);
        assert.ok(id.startsWith('gsd-'), `${id} has the shipped skill prefix`);
        assert.ok(fs.existsSync(path.join(__dirname, '..', 'skills', id, 'SKILL.md')), `${id} names a shipped skill`);
        checked += 1;
      }
    }
    assert.ok(checked > 0, 'the real registry must exercise skill dispatch');
  });

  test('skill step renders the invocable id while preserving the bare registry ref', () => {
    const registry = makeRegistry({
      point: 'plan:post',
      steps: [{ capId: 'tracker', point: 'plan:post', ref: { skill: 'beads-sync' } }],
    });
    const resolved = resolveLoopHooks({ point: 'plan:post', registry, config: {} });

    assert.strictEqual(renderLoopHooks(resolved), '### Step 1: skill:gsd-beads-sync (tracker)');
    assert.deepEqual(resolved.activeHooks[0].ref, { skill: 'beads-sync' });
    assert.deepEqual(registry.byLoopPoint['plan:post'].steps[0].ref, { skill: 'beads-sync' });
  });

  test('skill prefix projection is deterministic and does not mutate any hook refs', async () => {
    await fc.assert(fc.property(
      fc.constantFrom(...CANONICAL_POINTS),
      fc.array(
        fc.stringMatching(/^[a-z][a-z0-9-]{0,39}$/).filter((skill) => !skill.startsWith('gsd-')),
        { minLength: 1, maxLength: 8 },
      ),
      (point, skills) => {
        const steps = skills.map((skill, index) => ({ capId: `cap-${index}`, point, ref: { skill } }));
        steps.push(
          { capId: 'agent-cap', point, ref: { agent: 'gsd-phase-researcher' } },
          { capId: 'command-cap', point, ref: { command: 'tracker sync' } },
        );
        const registry = makeRegistry({ point, steps });
        const registryBefore = structuredClone(registry);
        const resolved = resolveLoopHooks({ point, registry, config: {} });
        const resolvedBefore = structuredClone(resolved);
        const expected = [
          ...skills.map((skill, index) => `### Step ${index + 1}: skill:gsd-${skill} (cap-${index})`),
          `### Step ${skills.length + 1}: agent:gsd-phase-researcher (agent-cap)`,
          `### Step ${skills.length + 2}: {"command":"tracker sync"} (command-cap)`,
        ].join('\n\n');

        assert.strictEqual(renderLoopHooks(resolved), expected);
        assert.strictEqual(renderLoopHooks(resolved), expected);
        assert.deepEqual(resolved, resolvedBefore);
        assert.deepEqual(registry, registryBefore);
      },
    ), { seed: 4030, numRuns: 100 });
  });

  test('step hook renders skill ref, capId, produces, consumes', () => {
    const resolved = {
      point: 'plan:pre',
      activeHooks: [{
        capId: 'ui',
        kind: 'step',
        ref: { skill: 'ui-phase' },
        when: 'workflow.ui_phase',
        produces: ['UI-SPEC.md'],
        consumes: ['CONTEXT.md'],
        onError: 'skip',
      }],
    };
    const rendered = renderLoopHooks(resolved);
    assert.match(rendered, /Step 1/);
    assert.match(rendered, /skill:gsd-ui-phase/);
    assert.match(rendered, /\(ui\)/);
    assert.match(rendered, /UI-SPEC\.md/);
    assert.match(rendered, /CONTEXT\.md/);
    assert.match(rendered, /workflow\.ui_phase/);
    assert.match(rendered, /skip/);
  });

  test('step hook renders agent ref and inline prompt fragment', () => {
    const registry = makeRegistry({
      point: 'plan:pre',
      steps: [{
        capId: 'research',
        point: 'plan:pre',
        ref: { agent: 'gsd-phase-researcher' },
        fragment: { inline: 'Research the phase before planning.' },
        produces: ['RESEARCH.md'],
        consumes: ['CONTEXT.md'],
        onError: 'skip',
      }],
    });
    const resolved = resolveLoopHooks({ point: 'plan:pre', registry, config: {} });
    assert.deepEqual(resolved.activeHooks[0].fragment, { inline: 'Research the phase before planning.' });

    const rendered = renderLoopHooks(resolved);
    assert.match(rendered, /agent:gsd-phase-researcher/);
    assert.match(rendered, /Research the phase before planning\./);
  });

  test('contribution hook renders into role', () => {
    const resolved = {
      point: 'plan:pre',
      activeHooks: [{
        capId: 'contrib-cap',
        kind: 'contribution',
        into: 'planner',
        fragment: { inline: 'Apply the project-specific planning guardrails.' },
      }],
    };
    const rendered = renderLoopHooks(resolved);
    assert.match(rendered, /contribution/);
    assert.match(rendered, /contrib-cap/);
    assert.match(rendered, /planner/);
    assert.match(rendered, /Apply the project-specific planning guardrails\./);
    assert.match(rendered, /<contribution from="contrib-cap" into="planner">/);
    assert.match(rendered, /<\/contribution>/);
    assert.doesNotMatch(rendered, /<contribution[^>]+\/>/);
  });

  test('resolveLoopHooks preserves contribution fragment data', () => {
    const registry = makeRegistry({
      point: 'plan:pre',
      contributions: [{
        capId: 'contrib-cap',
        point: 'plan:pre',
        into: 'planner',
        fragment: { inline: 'Use artifact-backed evidence.' },
        produces: ['PLAN-NOTES.md'],
        consumes: ['CONTEXT.md'],
        when: 'workflow.contrib',
        onError: 'halt',
      }],
      configSchema: {
        'workflow.contrib': { type: 'boolean', default: true, description: 'Enable test contribution.' },
      },
    });
    const resolved = resolveLoopHooks({ point: 'plan:pre', registry, config: {} });
    assert.strictEqual(resolved.activeHooks.length, 1);
    assert.deepEqual(resolved.activeHooks[0].fragment, { inline: 'Use artifact-backed evidence.' });
    assert.deepEqual(resolved.activeHooks[0].produces, ['PLAN-NOTES.md']);
    assert.deepEqual(resolved.activeHooks[0].consumes, ['CONTEXT.md']);
    assert.strictEqual(resolved.activeHooks[0].onError, 'halt');
  });

  test('gate hook renders check, blocking, onError', () => {
    const resolved = {
      point: 'execute:wave:post',
      activeHooks: [{
        capId: 'ui',
        kind: 'gate',
        check: { query: 'ui.safety-gate' },
        blocking: true,
        onError: 'halt',
      }],
    };
    const rendered = renderLoopHooks(resolved);
    assert.match(rendered, /Gate/);
    assert.match(rendered, /ui/);
    assert.match(rendered, /blocking=true/);
    assert.match(rendered, /halt/);
  });

  test('multiple hooks in order render with correct ordinals', () => {
    const resolved = {
      point: 'plan:pre',
      activeHooks: [
        { capId: 'cap-a', kind: 'step', ref: { skill: 'a' }, produces: ['A.md'], consumes: [] },
        { capId: 'cap-b', kind: 'step', ref: { skill: 'b' }, produces: ['B.md'], consumes: ['A.md'] },
      ],
    };
    const rendered = renderLoopHooks(resolved);
    assert.match(rendered, /Step 1/);
    assert.match(rendered, /Step 2/);
    const idx1 = rendered.indexOf('Step 1');
    const idx2 = rendered.indexOf('Step 2');
    assert.ok(idx1 < idx2, 'Step 1 should appear before Step 2');
  });

  test('empty hooks returns placeholder containing the point name', () => {
    const rendered = renderLoopHooks({ point: 'ship:post', activeHooks: [] });
    assert.match(rendered, /ship:post/);
    assert.ok(rendered.length > 0);
  });

  test('rendered is deterministic (same input → same output)', () => {
    const config = { workflow: { ui_phase: true, ui_review: true, ui_safety_gate: true } };
    const resolved = resolveLoopHooks({ point: 'plan:pre', registry: realRegistry, config });
    const r1 = renderLoopHooks(resolved);
    const r2 = renderLoopHooks(resolved);
    assert.strictEqual(r1, r2);
  });
});

// ─── 9. End-to-end cmdLoopRenderHooks (via gsd-tools subprocess) ─────────────

const { runHook, runNode } = require('./helpers/process-seam.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { isolatedEnv } = require('./helpers/isolated-env.cjs');
// A child gets the developer's machine only through this helper (CONTRIBUTING.md, #4635): the fixture
// home is its HOME and its GSD_HOME.
const fxEnv = (fx) => isolatedEnv({ home: fx.home, override: { GSD_HOME: fx.home } });
const ROOT = path.resolve(__dirname, '..');
const GSD_TOOLS = path.join(ROOT, 'gsd-core', 'bin', 'gsd-tools.cjs');
const JQ_STUB = path.join(ROOT, 'tests', 'helpers', 'jq-subset-stub.cjs');
// The call-site tables and the call grammar belong to the static check that scans them (ADR-6315); the e2e tests read them from there.
// Loaded on first use, so a base without the check still loads this file; each describe that reads the check fails as a unit there.
const phaseSites = new Proxy({}, { get: (_, key) => require('../scripts/static-checks/render-hooks-phase-sites.cjs')[key] });

describe('cmdLoopRenderHooks end-to-end (via gsd-tools)', () => {
  test('CLI exposes the invocable skill id in rendered text and a bare ref in both JSON modes', () => {
    const envelopes = [];
    for (const flags of [[], ['--raw']]) {
      const result = runNode(
        [GSD_TOOLS, 'loop', 'render-hooks', 'plan:pre', '--cwd', tmpProjectDir, ...flags],
        { cwd: ROOT, timeoutMs: PROBE_TIMEOUT_MS },
      );
      assert.strictEqual(result.exitCode, 0, 'Expected exit 0. stderr: ' + result.stderr);
      const envelope = JSON.parse(result.stdout.trim());
      const uiStep = envelope.activeHooks.find(h => h.capId === 'ui' && h.kind === 'step');
      assert.ok(uiStep, 'Expected the UI skill step in activeHooks');
      assert.deepEqual(uiStep.ref, { skill: 'ui-phase' });
      assert.ok(envelope.rendered.includes('skill:gsd-ui-phase (ui)'));
      assert.ok(!envelope.rendered.includes('skill:ui-phase (ui)'));
      envelopes.push(envelope);
    }
    assert.deepEqual(envelopes[0].activeHooks, envelopes[1].activeHooks);
    assert.strictEqual(envelopes[0].rendered, envelopes[1].rendered);
  });

  test('loop render-hooks plan:pre returns JSON envelope with ui-phase step active', () => {
    const result = runNode(
      [GSD_TOOLS, 'loop', 'render-hooks', 'plan:pre', '--cwd', tmpProjectDir],
      { cwd: ROOT, timeoutMs: PROBE_TIMEOUT_MS },
    );
    assert.strictEqual(result.exitCode, 0, 'Expected exit 0. stderr: ' + (result.stderr || ''));
    const envelope = JSON.parse(result.stdout.trim());
    assert.strictEqual(envelope.point, 'plan:pre');
    assert.ok(Array.isArray(envelope.activeHooks));
    assert.strictEqual(typeof envelope.rendered, 'string');
    // With ui_phase=true in tmpProjectDir config, ui-phase step should be active
    const uiStep = envelope.activeHooks.find(h => h.capId === 'ui' && h.kind === 'step');
    assert.ok(uiStep, 'Expected ui step in activeHooks. Got: ' + JSON.stringify(envelope.activeHooks));
    assert.match(envelope.rendered, /ui-phase/);
  });

  // FIX 4: schema-default activation — no config.json in project → ui-phase step active by default
  test('loop render-hooks plan:pre with no config.json → ui-phase step active by schema default', () => {
    const result = runNode(
      [GSD_TOOLS, 'loop', 'render-hooks', 'plan:pre', '--cwd', tmpEmptyProjectDir],
      { cwd: ROOT, timeoutMs: PROBE_TIMEOUT_MS },
    );
    assert.strictEqual(result.exitCode, 0, 'Expected exit 0. stderr: ' + (result.stderr || ''));
    const envelope = JSON.parse(result.stdout.trim());
    const uiStep = envelope.activeHooks.find(h => h.capId === 'ui' && h.kind === 'step');
    assert.ok(
      uiStep,
      'Expected ui step active by default. Got: ' + JSON.stringify(envelope.activeHooks),
    );
    assert.match(envelope.rendered, /ui-phase/);
  });

  test('loop render-hooks plan:pre with ui capability disabled in surface → ui hooks absent', () => {
    const result = runNode(
      [
        GSD_TOOLS,
        'loop',
        'render-hooks',
        'plan:pre',
        '--cwd',
        tmpEmptyProjectDir,
        '--config-dir',
        tmpUiDisabledConfigDir,
      ],
      { cwd: ROOT, timeoutMs: PROBE_TIMEOUT_MS },
    );
    assert.strictEqual(result.exitCode, 0, 'Expected exit 0. stderr: ' + (result.stderr || ''));
    const envelope = JSON.parse(result.stdout.trim());
    const uiHooks = envelope.activeHooks.filter(h => h.capId === 'ui');
    assert.deepStrictEqual(
      uiHooks,
      [],
      'UI hooks must be absent when the UI capability is disabled at the runtime surface',
    );
  });

  // FIX 4: explicit false in config.json overrides schema default
  test('loop render-hooks plan:pre with ui_phase=false in config.json → ui-phase step absent', () => {
    const result = runNode(
      [GSD_TOOLS, 'loop', 'render-hooks', 'plan:pre', '--cwd', tmpFalseConfigProjectDir],
      { cwd: ROOT, timeoutMs: PROBE_TIMEOUT_MS },
    );
    assert.strictEqual(result.exitCode, 0, 'Expected exit 0. stderr: ' + (result.stderr || ''));
    const envelope = JSON.parse(result.stdout.trim());
    const uiStep = envelope.activeHooks.find(h => h.capId === 'ui' && h.kind === 'step');
    assert.strictEqual(
      uiStep,
      undefined,
      'ui-phase step should be absent when config.json sets ui_phase=false',
    );
  });

  test('loop render-hooks invalid-point exits non-zero', () => {
    const result = runNode(
      [GSD_TOOLS, 'loop', 'render-hooks', 'plan:mid', '--cwd', tmpProjectDir],
      { cwd: ROOT, timeoutMs: PROBE_TIMEOUT_MS },
    );
    assert.notStrictEqual(result.exitCode, 0, 'Expected non-zero exit for invalid point');
    assert.match(result.stderr, /plan:mid|Invalid loop point/);
  });
});

// ─── 10. --active-cap flag (scanner-safe boolean derivation) ──────────────────

describe('--active-cap flag (loop render-hooks)', () => {
  // Temp project with tdd_mode=true in config
  let tddOnDir;
  // Temp project with tdd_mode=false in config
  let tddOffDir;

  before(() => {
    tddOnDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-active-cap-tdd-on-'));
    const planOn = path.join(tddOnDir, '.planning');
    fs.mkdirSync(planOn, { recursive: true });
    fs.writeFileSync(
      path.join(planOn, 'config.json'),
      JSON.stringify({ workflow: { tdd_mode: true } }),
      'utf8',
    );

    tddOffDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-active-cap-tdd-off-'));
    const planOff = path.join(tddOffDir, '.planning');
    fs.mkdirSync(planOff, { recursive: true });
    fs.writeFileSync(
      path.join(planOff, 'config.json'),
      JSON.stringify({ workflow: { tdd_mode: false } }),
      'utf8',
    );
  });

  after(() => {
    if (tddOnDir) cleanup(tddOnDir);
    if (tddOffDir) cleanup(tddOffDir);
  });

  test('--active-cap tdd with tdd_mode=true → stdout trimmed === "true", exit 0', () => {
    const result = runNode(
      [GSD_TOOLS, 'loop', 'render-hooks', 'execute:post', '--active-cap', 'tdd', '--cwd', tddOnDir],
      { cwd: ROOT, timeoutMs: PROBE_TIMEOUT_MS },
    );
    assert.strictEqual(result.exitCode, 0, 'Expected exit 0. stderr: ' + (result.stderr || ''));
    assert.strictEqual(result.stdout.trim(), 'true', 'Expected stdout "true" when tdd_mode=true');
  });

  test('--active-cap tdd with tdd_mode=false → stdout trimmed === "false", exit 0', () => {
    const result = runNode(
      [GSD_TOOLS, 'loop', 'render-hooks', 'execute:post', '--active-cap', 'tdd', '--cwd', tddOffDir],
      { cwd: ROOT, timeoutMs: PROBE_TIMEOUT_MS },
    );
    assert.strictEqual(result.exitCode, 0, 'Expected exit 0. stderr: ' + (result.stderr || ''));
    assert.strictEqual(result.stdout.trim(), 'false', 'Expected stdout "false" when tdd_mode=false');
  });

  test('--active-cap <nonexistent-cap> → stdout trimmed === "false", exit 0', () => {
    const result = runNode(
      [GSD_TOOLS, 'loop', 'render-hooks', 'execute:post', '--active-cap', 'no-such-capability-xyz', '--cwd', tddOffDir],
      { cwd: ROOT, timeoutMs: PROBE_TIMEOUT_MS },
    );
    assert.strictEqual(result.exitCode, 0, 'Expected exit 0 for unknown capId. stderr: ' + (result.stderr || ''));
    assert.strictEqual(result.stdout.trim(), 'false', 'Expected stdout "false" for unknown capId');
  });

  test('--active-cap with no value → non-zero exit and error message', () => {
    const result = runNode(
      [GSD_TOOLS, 'loop', 'render-hooks', 'execute:post', '--active-cap', '--cwd', tddOffDir],
      { cwd: ROOT, timeoutMs: PROBE_TIMEOUT_MS },
    );
    assert.notStrictEqual(result.exitCode, 0, 'Expected non-zero exit when --active-cap has no value');
    assert.match(result.stderr, /active-cap/i, 'Expected error message referencing --active-cap');
  });

  test('--active-cap output is exactly "true" or "false" (no JSON envelope, clean for shell capture)', () => {
    // The entire stdout must be just "true" or "false" + newline — no envelope object
    const result = runNode(
      [GSD_TOOLS, 'loop', 'render-hooks', 'execute:post', '--active-cap', 'tdd', '--cwd', tddOnDir],
      { cwd: ROOT, timeoutMs: PROBE_TIMEOUT_MS },
    );
    assert.strictEqual(result.exitCode, 0, 'Expected exit 0. stderr: ' + (result.stderr || ''));
    // Must be exactly "true" or "false" — not a JSON object/envelope
    const trimmed = result.stdout.trim();
    assert.ok(
      trimmed === 'true' || trimmed === 'false',
      `stdout must be "true" or "false", got: ${JSON.stringify(result.stdout)}`,
    );
    // Must not be a JSON object (no envelope with point/activeHooks/rendered keys)
    let parsed;
    try { parsed = JSON.parse(trimmed); } catch { parsed = null; }
    assert.ok(
      typeof parsed !== 'object' || parsed === null,
      'stdout must not be a JSON object/envelope when --active-cap is used',
    );
  });
});

// ─── Phase 4 regression: loop-resolver gates on state.active (not state.enabled) ─────
//
// FAIL-FIRST PROOF (what would fail against the OLD state.enabled check):
//   Scenario: capability has activationKey set; it is installed + surfaced (enabled=true)
//   but the activationKey resolves to false (active=false). The capability has a hook
//   WITHOUT a `when` guard (unconditional). With old state.enabled check:
//     state.enabled=true → state.enabled !== false → true → hook IS rendered (BUG).
//   With new state.active check:
//     state.active=false → state.active === true → false → hook NOT rendered (CORRECT).
//
// This test uses resolveLoopHooks directly with a synthetic registry and a
// capabilityStatesById map that models the above scenario: enabled=true, active=false.
// It would FAIL against the OLD `state.enabled !== false` code and PASS against the
// NEW `state.active === true` code.

describe('Phase 4 regression: capabilityStatesById gates on active (not enabled) for config-disabled capability', () => {
  test('[regression] enabled=true active=false + no `when` guard → hook NOT rendered (state.active gate)', () => {
    // Fail-first: with OLD `state.enabled !== false`, enabled=true → hook IS rendered (BUG).
    // With NEW `state.active === true`, active=false → hook NOT rendered (CORRECT).
    const registry = makeRegistry({
      point: 'plan:pre',
      steps: [{ capId: 'test-cap', ref: { skill: 'gsd-test-skill' } }],
      // No `when` → unconditional hook (no per-hook config gate to fall back on)
    });

    const capabilityStatesById = new Map([
      // enabled=true (installed+surfaced), active=false (activationKey resolved to false)
      // This models a capability like intel/graphify that is surfaced but config-disabled.
      ['test-cap', { enabled: true, active: false }],
    ]);

    const result = resolveLoopHooks({
      point: 'plan:pre',
      registry,
      config: {},  // config doesn't matter — capability already resolved active=false
      capabilityStatesById,
    });

    assert.strictEqual(
      result.activeHooks.length,
      0,
      'Hook must NOT be rendered when state.active=false, even if enabled=true and no `when` guard — ' +
      'OLD state.enabled check would include this hook (BUG: enabled=true passes enabled!==false); ' +
      'NEW state.active check correctly suppresses it (active=false fails active===true)',
    );
  });

  test('[positive control] enabled=true active=true + no `when` guard → hook IS rendered', () => {
    // Confirms the fixture is sound: same hook, same registry, but active=true → rendered.
    // This test must PASS against BOTH old and new code (it's the unbroken branch).
    const registry = makeRegistry({
      point: 'plan:pre',
      steps: [{ capId: 'test-cap', ref: { skill: 'gsd-test-skill' } }],
    });

    const capabilityStatesById = new Map([
      ['test-cap', { enabled: true, active: true }],
    ]);

    const result = resolveLoopHooks({
      point: 'plan:pre',
      registry,
      config: {},
      capabilityStatesById,
    });

    assert.strictEqual(
      result.activeHooks.length,
      1,
      'Hook MUST be rendered when state.active=true and no `when` guard (positive control)',
    );
    assert.strictEqual(result.activeHooks[0].capId, 'test-cap');
  });
});

// ─── ADR-1244 D2: load-failed capability gates FAIL OPEN with a loud warning (#2009) ──

describe('ADR-1244 D2: load-failed capability gates fail OPEN with a loud warning (#2009)', () => {
  // Decision (#2009): a capability that fails to LOAD must not block the loop.
  // cmdLoopRenderHooks injects NO gate (the loop proceeds — fail open) and emits a
  // loud warning naming the load reason and the exact `gsd capability remove <id>`
  // remediation, both to STDERR (the channel host workflows actually surface) and
  // in the envelope's `warnings` array. Previously it injected a blocking=true,
  // onError=halt gate that halted every declared point project-wide.

  // Helper: write an overlay cap with an incompatible engines.gsd (→ skipped at load)
  // that declares gate(s) at the given point(s). `capId` may be an invalid id to
  // exercise the sanitization path.
  function writeSkippedGateCap(overlayHome, capId, gatePoints) {
    const capDir = path.join(overlayHome, '.gsd', 'capabilities', capId);
    fs.mkdirSync(capDir, { recursive: true });
    const capManifest = {
      id: capId,
      role: 'feature',
      version: '1.0.0',
      title: 'Load-Failed Gate Cap',
      description: 'ADR-1244 D2 fail-open wiring test',
      tier: 'standard',
      requires: [],
      engines: { gsd: '>=99.0.0' },  // intentionally incompatible → always skipped at load
      runtimeCompat: { supported: ['*'], unsupported: [] },
      skills: [], agents: [], hooks: [], config: {}, steps: [], contributions: [],
      gates: gatePoints.map((point) => ({ point, check: { query: 'always-pass' }, blocking: true, onError: 'halt' })),
    };
    fs.writeFileSync(path.join(capDir, 'capability.json'), JSON.stringify(capManifest), 'utf8');
  }

  function renderHooks(overlayHome, point, extraArgs = []) {
    const result = runNode(
      [GSD_TOOLS, 'loop', 'render-hooks', point, '--cwd', overlayHome, ...extraArgs],
      { cwd: ROOT, timeoutMs: PROBE_TIMEOUT_MS, env: { ...process.env, GSD_HOME: overlayHome } },
    );
    assert.strictEqual(result.exitCode, 0, `Expected exit 0 at ${point}. stderr: ` + (result.stderr || ''));
    return result;
  }

  function parseEnvelope(result) {
    try {
      return JSON.parse(result.stdout.trim());
    } catch {
      assert.fail('loop render-hooks output must be valid JSON; got: ' + result.stdout.slice(0, 300));
    }
  }

  test('load-failed gate-kind overlay cap → NO gate injected (fail open) + loud warning on stderr and in envelope', (t) => {
    const overlayHome = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-fail-open-'));
    t.after(() => cleanup(overlayHome));

    const capId = 'load-failed-gate-cap';
    writeSkippedGateCap(overlayHome, capId, ['execute:wave:post']);

    const result = renderHooks(overlayHome, 'execute:wave:post');
    const envelope = parseEnvelope(result);

    // AC2 / AC-a: fail OPEN — NO gate (blocking or otherwise) is injected for the
    // load-failed cap, so the loop proceeds.
    const anyGate = Array.isArray(envelope.activeHooks)
      ? envelope.activeHooks.find((h) => h.capId === capId)
      : undefined;
    assert.strictEqual(
      anyGate, undefined,
      'no hook must be injected for a load-failed cap (fail open). Got: ' + JSON.stringify(envelope.activeHooks),
    );

    // AC-b: a loud warning is surfaced in the envelope `warnings` channel...
    const warnEnv = (envelope.warnings || []).find((w) => w.includes(capId));
    assert.ok(warnEnv, 'envelope.warnings must name the load-failed cap. Got: ' + JSON.stringify(envelope.warnings));
    // AC1: ...carrying the exact remediation, and making clear the gate is not enforced.
    assert.ok(
      warnEnv.includes(`gsd capability remove ${capId}`),
      'warning must include the `gsd capability remove <id>` remediation. Got: ' + warnEnv,
    );
    assert.match(warnEnv, /skipped|not enforced|failing open/i, 'warning must say the gate is not enforced. Got: ' + warnEnv);

    // ...and ALSO to stderr (the channel host workflows actually see).
    assert.ok(
      result.stderr.includes(`gsd capability remove ${capId}`),
      'stderr must carry the loud fail-open warning with remediation. Got: ' + result.stderr,
    );
  });

  test('load-failed cap declaring gates at ship:pre AND verify:post → neither point blocks (project can ship & verify)', (t) => {
    const overlayHome = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-fail-open-2pt-'));
    t.after(() => cleanup(overlayHome));

    const capId = 'load-failed-two-point-cap';
    writeSkippedGateCap(overlayHome, capId, ['ship:pre', 'verify:post']);

    for (const point of ['ship:pre', 'verify:post']) {
      const result = renderHooks(overlayHome, point);
      const envelope = parseEnvelope(result);
      const injected = envelope.activeHooks.find((h) => h.capId === capId);
      assert.strictEqual(
        injected, undefined,
        `${point} must NOT inject any hook for a load-failed cap (fail open). Got: ` + JSON.stringify(envelope.activeHooks),
      );
      const warn = (envelope.warnings || []).find((w) => w.includes(`gsd capability remove ${capId}`));
      assert.ok(warn, `${point} must surface a fail-open warning with remediation. Got: ` + JSON.stringify(envelope.warnings));
    }
  });

  test('security: an invalid (non-kebab) capability id is withheld — no runnable remove command is rendered (#2009 review)', (t) => {
    const overlayHome = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-fail-open-evil-'));
    t.after(() => cleanup(overlayHome));

    // A directory name that is a valid POSIX filename but NOT a valid capability
    // id, and contains a shell metacharacter. It must never appear inside a
    // runnable `gsd capability remove <id>` command in the surfaced warning.
    const evilId = 'Bad;Cap';
    writeSkippedGateCap(overlayHome, evilId, ['ship:pre']);

    const result = renderHooks(overlayHome, 'ship:pre');
    const envelope = parseEnvelope(result);

    const combined = (envelope.warnings || []).join('\n') + '\n' + result.stderr;
    // The raw metacharacter id must not be embedded in a runnable remove command.
    assert.ok(
      !combined.includes(`gsd capability remove ${evilId}`),
      'invalid capability id must NOT be placed in a runnable remove command. Got: ' + combined,
    );
    // A warning is still surfaced (fail-open is loud), using the withheld-id form.
    assert.match(
      combined, /invalid id \(withheld\)/,
      'an invalid id must be reported via the withheld-id placeholder. Got: ' + combined,
    );
  });
});

// ─── #4030: --phase → derived context: { phase, phaseDir } ──────────────────

// Every point the CLI scopes to a phase; the per-point CLI and handler tests iterate it.
const PHASE_SCOPED_POINTS = [
  'discuss:pre', 'discuss:post',
  'plan:pre', 'plan:post',
  'execute:pre', 'execute:wave:pre', 'execute:wave:post', 'execute:post',
  'verify:pre', 'verify:post',
];

// The resolver tags each way it drops a phase context with a typed reason code
// (ADR-4030) and lists the values its warning echoes in `phaseEchoed`; tests assert the code
// and those fields, never the warning text.
function dropOf(dir, opts) {
  return resolveActiveHooksForPoint(dir, 'plan:pre', opts).phaseDrop;
}

// Value level: the expansion must yield the bare workstream name (last word of GSD_WS) or nothing.
test('[unit] WS_EXPANSION expands GSD_WS to --ws=<name>, and to nothing when unset', () => {
  const sh = (override) => runHook('-c', [`printf '%s' ${phaseSites.WS_EXPANSION}`], { interpreter: 'bash', env: isolatedEnv({ home: os.tmpdir(), override }), timeoutMs: PROBE_TIMEOUT_MS }).stdout;
  assert.strictEqual(sh({ GSD_WS: '--ws b' }), '--ws=b');
  assert.strictEqual(sh({ GSD_WS: 'a b' }), '--ws=b');
  assert.strictEqual(sh({}), '');
});
// Turn the tail of a render-hooks call line into argv, substituting a real
// token for the phase variable and the fingerprint path.
function callArgv(rest, tok = '05') {
  return (rest
    .replace(phaseSites.WS_EXPANSION, '') // unset GSD_WS expands to nothing
    .replace(/\s+\d*>\S+/g, '') // a shell redirection is no argument
    .replace(/--after-fingerprint\s+"[^"]*"/, '--after-fingerprint .planning/phases/05-widgets')
    .replace(/"\$\{?\w+\}?"/g, `"${tok}"`)
    .match(/"[^"]*"|\S+/g) || []).map((a) => a.replace(/"/g, ''));
}

test('callArgv drops a shell redirection from the argument tail', () => {
  assert.deepStrictEqual(callArgv(' --raw --phase "${P}" 2>/dev/null', '02'), ['--raw', '--phase', '02']);
});

function makePhaseProject(...phaseDirNames) {
  const dir = createTempProject('loop-phase-ctx-');
  try {
    for (const name of phaseDirNames) {
      fs.mkdirSync(path.join(dir, '.planning', 'phases', name), { recursive: true });
    }
  } catch (err) {
    cleanup(dir); // the caller never gets `dir`, so it cannot register the cleanup itself
    throw err;
  }
  return dir;
}

function renderWithPhase(projectDir, point, extraArgs = [], env = isolatedEnv({ home: projectDir })) {
  return runNode(
    [GSD_TOOLS, 'loop', 'render-hooks', point, '--cwd', projectDir, ...extraArgs],
    { cwd: ROOT, timeoutMs: PROBE_TIMEOUT_MS, env },
  );
}

// The envelope of a render that must succeed: a failed CLI reports its stderr and a malformed
// envelope reports its stdout, not a SyntaxError or a TypeError at the first property read.
function envelopeFromResult(result, label) {
  assert.strictEqual(result.exitCode, 0, `${label}: stderr: ${result.stderr}`);
  const envelope = JSON.parse(result.stdout.trim());
  assert.ok(Array.isArray(envelope.activeHooks), `${label}: envelope shape, stdout: ${result.stdout}`);
  return envelope;
}

function renderEnvelope(projectDir, point, extraArgs = [], env = undefined) {
  return envelopeFromResult(renderWithPhase(projectDir, point, [...extraArgs, '--raw'], env), `${point} ${extraArgs.join(' ')}`);
}

// The `context` of a render that must resolve: a drop reports the stdout, not a TypeError at the read.
function contextOf(result) {
  const { context } = envelopeFromResult(result, 'context render');
  assert.ok(context, `no context in the envelope, stdout: ${result.stdout}`);
  return context;
}

describe('cmdLoopRenderHooks --phase (#4030)', () => {
  test('[happy] --phase matching exactly one directory adds context:{phase,phaseDir}', (t) => {
    const dir = makePhaseProject('05-widgets');
    t.after(() => cleanup(dir));
    const envelope = renderEnvelope(dir, 'plan:pre', ['--phase', '05']);
    assert.strictEqual(envelope.point, 'plan:pre');
    assert.ok(Array.isArray(envelope.activeHooks));
    assert.strictEqual(typeof envelope.rendered, 'string');
    assert.deepStrictEqual(envelope.context, { phase: '05', phaseDir: '.planning/phases/05-widgets' });
    assert.strictEqual(envelope.warnings, undefined);
  });

  test('[workstream] --ws scopes --phase to the workstream phases dir when both trees hold the number', (t) => {
    const dir = makePhaseProject('05-root');
    t.after(() => cleanup(dir));
    fs.mkdirSync(path.join(dir, '.planning', 'workstreams', 'alpha', 'phases', '05-alpha'), { recursive: true });
    const envelope = renderEnvelope(dir, 'plan:pre', ['--phase', '05', '--ws=alpha']);
    assert.deepStrictEqual(envelope.context, { phase: '05', phaseDir: '.planning/workstreams/alpha/phases/05-alpha' });
    const root = renderEnvelope(dir, 'plan:pre', ['--phase', '05']);
    assert.strictEqual(root.context?.phaseDir, '.planning/phases/05-root');
  });

  test('[bva] --phase omitted preserves the exact legacy envelope shape — no context key at all', (t) => {
    const dir = makePhaseProject('05-widgets');
    t.after(() => cleanup(dir));
    const envelope = renderEnvelope(dir, 'plan:pre');
    assert.deepStrictEqual(Object.keys(envelope).filter((k) => k !== 'warnings').sort(), ['activeHooks', 'point', 'rendered'],
      'omitting --phase must leave exactly the legacy keys (no context, no phaseDrop)');
  });

  test('[negative] --phase with no matching directory omits context and appends a warning, still exits 0', (t) => {
    const dir = makePhaseProject('05-widgets');
    t.after(() => cleanup(dir));
    const envelope = renderEnvelope(dir, 'plan:pre', ['--phase', '99']);
    assert.ok(!Object.prototype.hasOwnProperty.call(envelope, 'context'));
    assert.ok(Array.isArray(envelope.warnings) && envelope.warnings.length > 0);
    assert.strictEqual(dropOf(dir, { phase: '99' }), PHASE_DROP.UNRESOLVED);
  });

  test('[negative] --phase matching only an archived milestone phase omits context, not the archived path', (t) => {
    const dir = makePhaseProject();
    t.after(() => cleanup(dir));
    // Archive shape: <planning>/milestones/vX.Y-phases/<phase-dir>/ — no matching
    // dir under .planning/phases/, so guardedFindPhase falls through to this.
    fs.mkdirSync(path.join(dir, '.planning', 'milestones', 'v1.0-phases', '05-widgets'), { recursive: true });
    const envelope = renderEnvelope(dir, 'plan:pre', ['--phase', '05']);
    assert.ok(!Object.prototype.hasOwnProperty.call(envelope, 'context'),
      'an archived-only match must not surface a .planning/milestones/ path as context.phaseDir');
    assert.ok(Array.isArray(envelope.warnings) && envelope.warnings.length > 0);
    assert.strictEqual(dropOf(dir, { phase: '05' }), PHASE_DROP.ARCHIVED);
  });

  test('[bva] --phase matching two directories (ambiguous) omits context with AMBIGUOUS drop and a warning, exits 0 not thrown', (t) => {
    const dir = makePhaseProject('05-widgets', '05-gadgets');
    t.after(() => cleanup(dir));
    const envelope = renderEnvelope(dir, 'plan:pre', ['--phase', '05']);
    assert.ok(!Object.prototype.hasOwnProperty.call(envelope, 'context'));
    assert.ok(Array.isArray(envelope.warnings) && envelope.warnings.length > 0);
    assert.strictEqual(dropOf(dir, { phase: '05' }), PHASE_DROP.AMBIGUOUS);
  });

  test('[negative] bare --phase with no value degrades like an omitted flag, never a hard error', (t) => {
    // #4030: --phase/--phase-dir are the two graceful value flags — an
    // empty or missing value must never turn a call that would otherwise still
    // produce every activeHooks entry into a total failure. Unlike the four
    // other render-hooks value flags, a workflow's `--phase "${PHASE_NUMBER}"`
    // with an unset variable must not drop the whole hook envelope for a call site.
    const dir = makePhaseProject('05-widgets');
    t.after(() => cleanup(dir));
    const envelope = renderEnvelope(dir, 'plan:pre', ['--phase']);
    assert.ok(!Object.prototype.hasOwnProperty.call(envelope, 'context'));
    assert.ok(!Object.prototype.hasOwnProperty.call(envelope, 'warnings'),
      'a bare --phase must be silent, exactly like omitting the flag entirely');
  });

  test('[negative] --phase "" (explicit empty string, space form) warns, never a hard error', (t) => {
    // The flag seam (emptyEqFlags) distinguishes "explicit empty value" (--phase "") from
    // "flag never given" (bare --phase) — only the latter stays silent. An
    // explicit empty string reaches the resolver as '', which guardedFindPhase
    // treats as any other unresolvable token: a warning, never a hard error and
    // never a dropped envelope. This is the CLI path all real call sites use —
    // an unset `${PHASE_NUMBER}` in a workflow must be diagnosable, not silent.
    const dir = makePhaseProject('05-widgets');
    t.after(() => cleanup(dir));
    const envelope = renderEnvelope(dir, 'plan:pre', ['--phase', '']);
    assert.ok(!Object.prototype.hasOwnProperty.call(envelope, 'context'));
    assert.ok(Array.isArray(envelope.warnings) && envelope.warnings.length > 0,
      'an explicit empty --phase must warn, not go silent');
    assert.strictEqual(dropOf(dir, { phase: '' }), PHASE_DROP.INVALID_TOKEN);
  });

  test('[negative] --phase= (explicit empty string, equals form) warns, never a hard error', (t) => {
    const dir = makePhaseProject('05-widgets');
    t.after(() => cleanup(dir));
    const envelope = renderEnvelope(dir, 'plan:pre', ['--phase=']);
    assert.ok(!Object.prototype.hasOwnProperty.call(envelope, 'context'));
    assert.ok(Array.isArray(envelope.warnings) && envelope.warnings.length > 0,
      'an explicit empty --phase= must warn, not go silent');
  });

  test('[negative] resolveActiveHooksForPoint called in-process with phase: \'\' warns the same way', (t) => {
    // This exported function is its own boundary (an in-process caller does not
    // go through the CLI flag seam) and must not silently swallow an explicit empty string the way
    // a bare, truly-absent --phase does. An empty phase fails PHASE_TOKEN_RE
    // before any lookup and drops as INVALID_TOKEN with a warning, as on the
    // CLI path.
    const dir = makePhaseProject('05-widgets');
    t.after(() => cleanup(dir));
    const result = resolveActiveHooksForPoint(dir, 'plan:pre', { phase: '' });
    assert.strictEqual(result.context, undefined);
    assert.strictEqual(result.phaseDrop, PHASE_DROP.INVALID_TOKEN);
  });

  test('[negative] resolveActiveHooksForPoint called in-process with phaseDir: \'\' and no phase warns', (t) => {
    const dir = makePhaseProject('05-widgets');
    t.after(() => cleanup(dir));
    const result = resolveActiveHooksForPoint(dir, 'plan:pre', { phaseDir: '' });
    assert.strictEqual(result.context, undefined);
    assert.strictEqual(result.phaseDrop, PHASE_DROP.PHASE_DIR_ALONE);
  });

  // The #6100 flag seam (CLI_SURFACE['loop.render-hooks']) owns the occurrence rule, like
  // every other verb: the first occurrence wins, whichever form it uses.
  test('[bva] the first --phase occurrence wins, whichever form it uses', (t) => {
    const dir = makePhaseProject('05-widgets', '07-gadgets');
    t.after(() => cleanup(dir));
    for (const [argv, want] of [
      [['--phase', '07', '--phase=05', '--raw'], '07'],
      [['--phase=05', '--phase', '07', '--raw'], '05'],
    ]) {
      const result = renderWithPhase(dir, 'plan:pre', argv);
      assert.strictEqual(result.exitCode, 0, 'stderr: ' + result.stderr);
      assert.strictEqual(contextOf(result).phase, want,
        `the first occurrence must win for ${argv.join(' ')}`);
    }
  });

  test('[bva] the = form trims a padded token; the space form reaches the resolver as typed', (t) => {
    const dir = makePhaseProject('05-widgets');
    t.after(() => cleanup(dir));
    const trimmed = renderWithPhase(dir, 'plan:pre', ['--phase=  05  ', '--raw']);
    assert.strictEqual(trimmed.exitCode, 0, 'stderr: ' + trimmed.stderr);
    assert.strictEqual(contextOf(trimmed).phase, '05',
      'the = form trims, so a padded token still resolves');

    const envelope = renderEnvelope(dir, 'plan:pre', ['--phase', '  05  ']);
    assert.ok(!('context' in envelope), 'a padded space-form token is not a phase token');
    assert.ok((envelope.warnings || []).length > 0, 'the drop warns');
    assert.strictEqual(dropOf(dir, { phase: '  05  ' }), PHASE_DROP.INVALID_TOKEN);
  });

  test('[bva] --phase=05 equals-form parses identically to the space-separated form', (t) => {
    const dir = makePhaseProject('05-widgets');
    t.after(() => cleanup(dir));
    const envelope = renderEnvelope(dir, 'plan:pre', ['--phase=05']);
    assert.deepStrictEqual(envelope.context, { phase: '05', phaseDir: '.planning/phases/05-widgets' });
  });

  test('[happy] --after-fingerprint with --phase keeps context in the envelope', (t) => {
    const dir = makePhaseProject('05-widgets');
    t.after(() => cleanup(dir));
    const envelope = renderEnvelope(dir, 'verify:post',
      ['--after-fingerprint', path.join(dir, '.planning', 'phases', '05-widgets'), '--phase', '05']);
    assert.deepStrictEqual(envelope.context,
      { phase: '05', phaseDir: '.planning/phases/05-widgets' });
  });

  test('[happy] --phase composes with --active-cap without interference', (t) => {
    const dir = makePhaseProject('02-alpha');
    t.after(() => cleanup(dir));
    const withPhase = renderWithPhase(dir, 'plan:pre', ['--phase', '02', '--active-cap', 'tdd']);
    const without = renderWithPhase(dir, 'plan:pre', ['--active-cap', 'tdd']);
    assert.strictEqual(withPhase.exitCode, 0, 'stderr: ' + withPhase.stderr);
    assert.strictEqual(typeof JSON.parse(withPhase.stdout.trim()), 'boolean');
    assert.strictEqual(withPhase.stdout.trim(), without.stdout.trim(), '--phase must not change the --active-cap answer');
  });

  test('[hostile] a foreign-project-code-prefixed --phase token does not reopen #2237 — guardedFindPhase rejects it same as init.*', (t) => {
    const dir = makePhaseProject('05-widgets');
    fs.writeFileSync(path.join(dir, '.planning', 'config.json'), JSON.stringify({ project_code: 'MINE' }));
    t.after(() => cleanup(dir));
    const envelope = renderEnvelope(dir, 'plan:pre', ['--phase', 'OTHER-05']);
    assert.ok(!Object.prototype.hasOwnProperty.call(envelope, 'context'),
      'a foreign-prefixed token must not silently resolve to this project\'s same-numbered phase directory');
    assert.ok((envelope.warnings || []).length > 0);
    assert.strictEqual(dropOf(dir, { phase: 'OTHER-05' }), PHASE_DROP.UNRESOLVED);
  });

  // #4030 acceptance criterion: the workflow-supplied phase must reach the
  // dispatch envelope unchanged at EVERY phase-scoped point, not just the two
  // sampled above — a point wired in the resolver but broken at the CLI seam
  // would otherwise ship silently.
  for (const point of PHASE_SCOPED_POINTS) {
    test(`[happy] ${point} carries --phase through to context unchanged`, (t) => {
      const dir = makePhaseProject('05-widgets');
      t.after(() => cleanup(dir));
      const envelope = renderEnvelope(dir, point, ['--phase', '05']);
      assert.strictEqual(envelope.point, point);
      assert.deepStrictEqual(
        envelope.context,
        { phase: '05', phaseDir: '.planning/phases/05-widgets' },
        `${point} must surface the caller's phase, not infer one`,
      );
    });
  }

  test('[bva] decimal phase tokens resolve, per GSD\'s phase-number contract', (t) => {
    const dir = makePhaseProject('07.5-tuning');
    t.after(() => cleanup(dir));
    assert.deepStrictEqual(
      renderEnvelope(dir, 'plan:pre', ['--phase', '07.5']).context,
      { phase: '07.5', phaseDir: '.planning/phases/07.5-tuning' },
    );
  });

  // #4030 condition 1: four hostile --phase shapes (traversal, traversal with a phase suffix, absolute path, absolute phase-shaped path), asserted
  // even though this design makes them unreachable rather than merely rejected —
  // `--phase` takes a token, never a path, and phaseDir is the directory the
  // locator matched. "Unreachable by construction" is a claim, so it gets tests:
  // traversal and absolute-path substitution here, symlink escape and nonexistent
  // paths below.
  for (const [label, token] of [
    ['traversal', '../../etc'],
    ['traversal with a real phase suffix', '../05-widgets'],
    ['absolute-path substitution', '/etc'],
    ['absolute path to a phase-shaped dir outside the project', '/tmp/.planning/phases/05-widgets'],
  ]) {
    test(`[hostile] --phase ${label} resolves nothing and never escapes the project`, (t) => {
      const dir = makePhaseProject('05-widgets');
      t.after(() => cleanup(dir));
      const envelope = renderEnvelope(dir, 'plan:pre', ['--phase', token]);
      assert.ok(!Object.prototype.hasOwnProperty.call(envelope, 'context'),
        `${token} must not resolve to a phase directory`);
      assert.ok((envelope.warnings || []).length > 0);
      assert.strictEqual(dropOf(dir, { phase: token }), PHASE_DROP.INVALID_TOKEN);
    });
  }

  test('[hostile] a resolved phaseDir is always project-relative, never absolute', (t) => {
    const dir = makePhaseProject('05-widgets');
    t.after(() => cleanup(dir));
    const result = renderWithPhase(dir, 'plan:pre', ['--phase', '05', '--raw']);
    assert.strictEqual(result.exitCode, 0, 'stderr: ' + result.stderr);
    const { phaseDir } = contextOf(result);
    assert.strictEqual(phaseDir, '.planning/phases/05-widgets');
    assert.ok(!path.isAbsolute(phaseDir), 'phaseDir must never be absolute');
    assert.ok(!phaseDir.includes('..'), 'phaseDir must never contain a parent-dir segment');
  });

  // Skipped on Windows: creating a DIRECTORY symlink needs elevation or
  // Developer Mode there, so setup would throw EPERM before the assertion runs.
  // Same guard the sibling symlink tests use (tests/capability-consent.test.cjs).
  test('[negative] the phase locator skips a symlinked child directory, so it is not resolved into context', {
    skip: process.platform === 'win32' ? 'directory symlinks require elevation on Windows' : false,
  }, (t) => {
    const dir = makePhaseProject('05-widgets');
    const outside = createTempDir('loop-phase-outside-');
    t.after(() => { cleanup(dir); cleanup(outside); });
    fs.mkdirSync(path.join(outside, '99-evil'), { recursive: true });
    fs.symlinkSync(path.join(outside, '99-evil'), path.join(dir, '.planning', 'phases', '99-evil'), 'dir');
    const envelope = renderEnvelope(dir, 'plan:pre', ['--phase', '99']);
    assert.ok(!Object.prototype.hasOwnProperty.call(envelope, 'context'),
      'a symlinked phase dir must not become a resolved phaseDir');
    // The locator never lists a symlinked child, so the drop is UNRESOLVED, not ESCAPES_ROOT.
    assert.strictEqual(dropOf(dir, { phase: '99' }), PHASE_DROP.UNRESOLVED);
  });

  // #4030 acceptance criterion: the workflow-supplied phase must reach a
  // SYNTHETIC THIRD-PARTY step handler unchanged, at every phase-scoped point.
  // The tests above use the real registry; these register an overlay capability
  // nobody ships, so what is asserted is the envelope a third-party step is
  // dispatched from — its step entry and the phase side by side — not merely
  // that the resolver echoes a flag. The handler argv itself is asserted by the
  // [projection] test below.
  //
  // GLOBAL scope (under GSD_HOME) is trusted without a consent record
  // (ADR-1244 / #1459), which is what makes an overlay usable as a fixture here.
  function makeThirdPartyStepFixture(points) {
    const home = createTempDir('loop-phase-3p-home-');
    try {
      return { home, project: writeThirdPartyStepFixture(home, points) };
    } catch (err) {
      cleanup(home); // the caller never gets `home`, so it cannot register the cleanup itself
      throw err;
    }
  }

  function writeThirdPartyStepFixture(home, points) {
    const capDir = path.join(home, '.gsd', 'capabilities', 'phase-probe');
    fs.mkdirSync(capDir, { recursive: true });
    fs.writeFileSync(path.join(capDir, 'capability.json'), JSON.stringify({
      id: 'phase-probe',
      title: 'Phase Probe',
      version: '1.0.0',
      role: 'feature',
      tier: 'full',
      description: 'Third-party capability declaring one step per phase-scoped point (#4030 fixture).',
      engines: { gsd: '>=1.7.0' },
      requires: [],
      runtimeCompat: { supported: ['claude', 'codex'], unsupported: [] },
      skills: [],
      agents: [],
      config: {},
      steps: points.map((point) => ({
        point,
        ref: { command: 'phase probe' },
        produces: [],
        consumes: [],
        onError: 'skip',
      })),
      contributions: [],
      gates: [],
    }), 'utf8');

    return makePhaseProject('05-widgets');
  }

  // The fixture's third-party step hook of an envelope; its absence fails here, not as a TypeError in runHandler.
  function probeOf(envelope, where) {
    const hook = envelope.activeHooks.find((h) => h.capId === 'phase-probe');
    assert.ok(hook, `${where}: the third-party step must be dispatched; got ${JSON.stringify(envelope.activeHooks)}`);
    return hook;
  }

  for (const point of PHASE_SCOPED_POINTS) {
    test(`[happy] ${point}: a third-party step hook and the caller's phase arrive in one envelope`, (t) => {
      const fx = makeThirdPartyStepFixture(PHASE_SCOPED_POINTS);
      t.after(() => { cleanup(fx.home); cleanup(fx.project); });

      const envelope = renderEnvelope(fx.project, point, ['--phase', '05'], fxEnv(fx));
      const probe = probeOf(envelope, point);
      assert.strictEqual(probe.kind, 'step');
      assert.strictEqual(probe.ref.command, 'phase probe');

      assert.deepStrictEqual(
        envelope.context,
        { phase: '05', phaseDir: '.planning/phases/05-widgets' },
        `${point} must deliver the caller's phase unchanged alongside the third-party handler`,
      );
    });
  }

  test('[bva] a third-party handler sees no context when the caller passes no phase', (t) => {
    const fx = makeThirdPartyStepFixture(['plan:pre']);
    t.after(() => { cleanup(fx.home); cleanup(fx.project); });

    const envelope = renderEnvelope(fx.project, 'plan:pre', [], fxEnv(fx));
    probeOf(envelope, 'plan:pre without --phase');
    assert.ok(!Object.prototype.hasOwnProperty.call(envelope, 'context'),
      'no phase in means no context out — the handler must not receive an inferred one');
  });

  // #4030 AC5: STATE.md names a different phase; the handler must still get
  // only the caller's token, and STATE must stay untouched.
  test('[happy] third-party handler receives --phase 02, not STATE.md current_phase 01', (t) => {
    const fx = makeThirdPartyStepFixture(['plan:pre']);
    t.after(() => { cleanup(fx.home); cleanup(fx.project); });
    for (const n of ['01-alpha', '02-beta']) fs.mkdirSync(path.join(fx.project, '.planning', 'phases', n));
    const statePath = path.join(fx.project, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, 'current_phase: 01\n');
    const before = fs.readFileSync(statePath);

    const envelope = renderEnvelope(fx.project, 'plan:pre', ['--phase', '02'], fxEnv(fx));
    probeOf(envelope, 'plan:pre --phase 02');
    assert.deepStrictEqual(envelope.context, { phase: '02', phaseDir: '.planning/phases/02-beta' });
    assert.deepStrictEqual(fs.readFileSync(statePath), before, 'STATE.md must stay byte-identical');
  });

  // Run a site's own PHASE_NUMBER bind line in a fresh bash (each fence is its own shell)
  // with only what its fence supplies, and return the value it yields.
  function boundPhase(fx, file, bindLine, args = /execute-phase/.test(file) ? '02 --wave 2 --auto' : '02') {
    const initQuery = file.endsWith('verify-work.md') ? phaseSites.VERIFY_WORK_INIT
      : `INIT=$(gsd_run query ${file.endsWith('plan-phase.md') ? 'init.plan-phase' : 'init.phase-op'} 02)`;
    const script = [
      `gsd_run() { node "${GSD_TOOLS}" "$@"; }`,
      // The Tester Image ships no jq: fall back to the subset stub, which knows the phase-bind filter.
      `command -v jq >/dev/null 2>&1 || jq() { node "${JQ_STUB}" "$@"; }`,
      `GSD_ARGS='${args}'`, 'PHASE_ARG=02', 'GSD_WS=""',
      bindLine.includes('$INIT') ? initQuery : ':',
      bindLine.includes('${1}') ? phaseSites.ARGS_BIND.join('\n') : ':',
      bindLine.includes('${PHASE}') ? 'PHASE=02' : ':',
      bindLine,
      'printf %s "$PHASE_NUMBER"',
    ].join('\n');
    const r = runHook('-c', [script], { interpreter: 'bash', cwd: fx.project, env: fxEnv(fx), timeoutMs: PROBE_TIMEOUT_MS });
    assert.strictEqual(r.exitCode, 0, `${file}: bind failed: ${r.stderr}`);
    return r.stdout;
  }

  // The dispatch contract, read lazily and once: a describe-level read would fail the whole block at
  // registration (RULESET.TESTS.guard-toplevel-readFileSync).
  let dispatchMdCache;
  const dispatchMdOnce = () => (dispatchMdCache ??= fs.readFileSync(path.join(ROOT, 'gsd-core/references/loop-hook-dispatch.md'), 'utf8'));

  // #4030 AC4: run each real call site's own arguments (not a hand-written
  // --phase), so a site with a wrong flag or variable fails here. Its phase
  // variable is replaced by the token its own bind line yields.
  for (const [file, point] of phaseSites.SITES) {
    test(`[e2e] ${file} :: ${point} call site binds its phase var and its argv puts the phase in the envelope beside a third-party step`, (t) => {
      const fx = makeThirdPartyStepFixture(PHASE_SCOPED_POINTS);
      t.after(() => { cleanup(fx.home); cleanup(fx.project); });
      for (const n of ['01-alpha', '02-beta']) fs.mkdirSync(path.join(fx.project, '.planning', 'phases', n));
      const statePath = path.join(fx.project, '.planning', 'STATE.md');
      fs.writeFileSync(statePath, 'current_phase: 01\n');
      const stateBefore = fs.readFileSync(statePath);
      const dispatchMd = dispatchMdOnce();
      const lines = splitLines(fs.readFileSync(path.join(ROOT, file), 'utf8'));
      let seen = 0;
      let tok = '02'; // a host-bound site (HOST_BOUND) takes the loop variable's value
      // The fence structure of each site is scripts/static-checks/render-hooks-phase-sites.cjs (scanSiteFences);
      // this test runs what that scan accepts: the site's own bind line and its own argv.
      phaseSites.callSites(lines, point).forEach(({ m, idx }) => { // idx: a wrapped call's first physical line
        seen++;
        const phaseVar = phaseSites.phaseVarOf(m[1]);
        assert.notStrictEqual(phaseVar, null, `${file}:${idx + 1} ${point}: --phase must take a quoted variable`);
        const b = phaseSites.phaseVarBinding(lines, idx, phaseVar);
        if (!phaseSites.HOST_BOUND.has(`${file} :: ${point}`)) {
          assert.notStrictEqual(b.line, -1, `${file}:${idx + 1} ${point}: ${phaseVar} is never assigned in a bash block before this call`);
          const bindLine = lines[b.line].trim();
          tok = boundPhase(fx, file, bindLine);
          // Flags BEFORE the phase: ARGS_BIND must skip them (and --wave's value) and bind the positional token.
          if (bindLine.includes('${1}')) {
            assert.strictEqual(boundPhase(fx, file, bindLine, '--wave 3 --auto 02'), '02', `${file}:${idx + 1} ${point}: a leading flag leaked into the phase bind`);
          }
        }
        const result = runNode(
          [GSD_TOOLS, 'loop', 'render-hooks', point, ...callArgv(m[1], tok), '--cwd', fx.project],
          { cwd: ROOT, timeoutMs: PROBE_TIMEOUT_MS, env: fxEnv(fx) },
        );
        const envelope = envelopeFromResult(result, `${file} ${point}`);
        const hook = envelope.activeHooks.find((h) => h.capId === 'phase-probe');
        assert.ok(hook, `${file} ${point}: the third-party handler must be dispatched`);
        assert.strictEqual(tok, '02', `${file}:${idx + 1} ${point}: the bind must yield the call's own phase, not STATE.current_phase`);
        assert.deepStrictEqual(envelope.context, { phase: '02', phaseDir: '.planning/phases/02-beta' },
          `${file} ${point}: the call site's phase must reach the handler unchanged`);
        assert.deepStrictEqual(runHandler(dispatchMd, envelope, hook, tok), ['phase', 'probe', '--phase', '02', '--raw'],
          `${file} ${point}: the handler must receive the call site's phase`);
        assert.deepStrictEqual(fs.readFileSync(statePath), stateBefore, 'STATE.md must stay byte-identical');
      });
      assert.ok(seen > 0, `no ${point} call site in ${file}`);
    });
  }

  // The phase-argument table of the dispatch contract (loop-hook-dispatch.md, ref.command):
  // one row per envelope shape, naming the phaseDrop codes it covers and the template to fill.
  // The in-context phase-token check the contract tells the agent to make, between ^ and $.
  const TOKEN_CHECK_RE = /in-context against\s+`\^([^`]{1,100})\$`/;
  function dispatchTable(dispatchMd) {
    const lines = splitLines(dispatchMd).map((l) => l.trim());
    const head = lines.findIndex((l) => l.startsWith('| Envelope |'));
    assert.notStrictEqual(head, -1, 'dispatch contract lost its phase-argument table');
    const rows = [];
    for (let i = head + 2; i < lines.length && lines[i].startsWith('|'); i++) {
      const [env, arg, tpl] = lines[i].split('|').slice(1, -1).map((c) => c.trim());
      rows.push({ env, arg, template: tpl.replace(/`/g, ''), codes: [...env.matchAll(/`([A-Z_]+)`/g)].map((m) => m[1]) });
    }
    return rows;
  }

  // Run the handler line the projected dispatch contract builds from an envelope: pick the table row,
  // check the phase value in-context (as the contract tells the agent), fill the template under the row's
  // comment, and run it with bash against a recording gsd_run (a synthetic third-party handler).
  function runHandler(dispatchMd, envelope, hook, phaseNumber) {
    const rows = dispatchTable(dispatchMd);
    const row = envelope.context ? rows.find((x) => x.env.startsWith('`context` present'))
      : envelope.phaseDrop ? rows.find((x) => x.codes.includes(envelope.phaseDrop))
        : rows.find((x) => x.env.startsWith('no `context`'));
    assert.ok(row, `dispatch table has no row for ${JSON.stringify(envelope.phaseDrop)}`);
    const value = envelope.context ? envelope.context.phase : row.arg.includes('PHASE_NUMBER') ? phaseNumber : undefined;
    const tokenMatch = dispatchMd.match(TOKEN_CHECK_RE);
    assert.ok(tokenMatch, `loop-hook-dispatch.md lost the in-context token-check sentence ${TOKEN_CHECK_RE}`);
    const tokenRe = new RegExp(`^${tokenMatch[1]}$`);
    const template = value !== undefined && value !== '' && tokenRe.test(value) ? row.template : 'context absent, no PHASE_NUMBER';
    const lines = splitLines(dispatchMd).map((l) => l.trim());
    const at = lines.indexOf(`# ${template}`);
    assert.notStrictEqual(at, -1, `dispatch contract lost its "# ${template}" branch`);
    const filled = lines[at + 1]
      .replace('${ref.command}', hook.ref.command)
      .replace('${context.phase}', envelope.context ? envelope.context.phase : '')
      .replace('${PHASE_NUMBER}', phaseNumber ?? '');
    const recDir = createTempDir('loop-handler-rec-');
    try {
      const rec = path.join(recDir, 'argv');
      const r = runHook('-c', [`gsd_run() { printf '%s\\n' "$@" > "$REC"; }\n${filled}`], { interpreter: 'bash', env: isolatedEnv({ home: recDir, override: { REC: rec } }), timeoutMs: PROBE_TIMEOUT_MS });
      assert.strictEqual(r.exitCode, 0, `handler line failed: ${r.stderr}`);
      return splitLines(fs.readFileSync(rec, 'utf8')).filter((l, i, all) => i < all.length - 1 || l !== '');
    } finally { cleanup(recDir); }
  }

  // #4030 AC8: the installer projects workflows and references per runtime.
  // For Claude Code and Codex, run each projected call site through the CLI
  // with a third-party step registered, then build that step's argv from the
  // projected dispatch contract: the phase must land in the handler's argv.
  test('[projection] Claude Code and Codex: each projected call site\'s phase reaches a third-party ref.command handler argv', (t) => {
    const prev = process.env.GSD_TEST_MODE;
    process.env.GSD_TEST_MODE = '1';
    t.after(() => { if (prev === undefined) delete process.env.GSD_TEST_MODE; else process.env.GSD_TEST_MODE = prev; });
    const { copyWithPathReplacement } = require('../bin/install.js');
    const fx = makeThirdPartyStepFixture(PHASE_SCOPED_POINTS);
    t.after(() => { cleanup(fx.home); cleanup(fx.project); });
    const env = fxEnv(fx);
    for (const [runtime, prefix] of [['claude', '~/.claude/'], ['codex', '~/.codex/']]) {
      const dest = createTempDir(`loop-phase-proj-${runtime}-`);
      t.after(() => cleanup(dest));
      for (const sub of ['workflows', 'references']) {
        copyWithPathReplacement(path.join(ROOT, 'gsd-core', sub), path.join(dest, sub), prefix, runtime, false, false, dest);
      }
      const dispatchMd = fs.readFileSync(path.join(dest, 'references', 'loop-hook-dispatch.md'), 'utf8');
      // ref.skill / ref.agent dispatch is prose: pin that each branch still tells
      // the agent to pass the phase on, in the projected contract.
      const bullet = (start, end) => {
        assert.ok(dispatchMd.includes(start) && dispatchMd.includes(end), `${runtime}: dispatch contract lost "${start}" or "${end}"`);
        return dispatchMd.slice(dispatchMd.indexOf(start), dispatchMd.indexOf(end));
      };
      assert.ok(bullet('- `ref.skill` present', '- `ref.agent` present').includes('args="${context.phase}"'),
        `${runtime}: the ref.skill branch lost args="\${context.phase}"`);
      const agentBranch = bullet('- `ref.agent` present', '- `ref.command` present');
      assert.ok(agentBranch.includes('context.phase') && agentBranch.includes('context.phaseDir'),
        `${runtime}: the ref.agent branch lost context.phase/context.phaseDir`);
      for (const [file, point, expectedCount] of phaseSites.SITES) {
        const projected = fs.readFileSync(path.join(dest, file.replace(/^gsd-core\//, '')), 'utf8');
        const { bare, withPhase } = phaseSites.phaseSiteCounts(projected, point);
        assert.strictEqual(bare.length, expectedCount, `${runtime}: ${file} ${point} call site count changed`);
        assert.strictEqual(withPhase.length, expectedCount, `${runtime}: ${file} ${point} lost --phase`);
        for (const m of bare) {
          const result = runNode(
            [GSD_TOOLS, 'loop', 'render-hooks', point, ...callArgv(m[1]), '--cwd', fx.project],
            { cwd: ROOT, timeoutMs: PROBE_TIMEOUT_MS, env },
          );
          const envelope = envelopeFromResult(result, `${runtime}: ${file} ${point}`);
          const hook = envelope.activeHooks.find((h) => h.capId === 'phase-probe');
          assert.ok(hook, `${runtime}: ${file} ${point}: the third-party step must be dispatched`);
          assert.deepStrictEqual(runHandler(dispatchMd, envelope, hook, undefined), ['phase', 'probe', '--phase', '05', '--raw'],
            `${runtime}: ${file} ${point}: the handler must receive the call site's phase`);
        }
      }
      // With no context, the contract falls back to the host's PHASE_NUMBER,
      // else passes no phase flag at all — never an empty token.
      const bareEnv = renderEnvelope(fx.project, 'plan:pre', [], env);
      const hook = probeOf(bareEnv, `${runtime}: plan:pre without --phase`);
      assert.deepStrictEqual(runHandler(dispatchMd, bareEnv, hook, '07'), ['phase', 'probe', '--phase', '07', '--raw']);
      assert.deepStrictEqual(runHandler(dispatchMd, bareEnv, hook, undefined), ['phase', 'probe', '--raw']);
      // An unrelated warning (capability load failure) does not mean --phase was rejected: the fallback stays.
      assert.deepStrictEqual(runHandler(dispatchMd, { ...bareEnv, warnings: ['capability x failed to load'] }, hook, '07'), ['phase', 'probe', '--phase', '07', '--raw']);
      // --phase was passed but dropped (warning). Only the project-state drops (UNRESOLVED, ARCHIVED,
      // AMBIGUOUS, CONFIG_FAULT) keep the host's PHASE_NUMBER; ESCAPES_ROOT, DIR_MISMATCH,
      // PHASE_DIR_ALONE and INVALID_TOKEN pass none, so a rejected token's phase never reaches the handler.
      const rejectedEnv = renderEnvelope(fx.project, 'plan:pre', ['--phase', '99'], env);
      assert.ok(rejectedEnv.warnings && rejectedEnv.warnings.length, 'an unmatched --phase warns');
      assert.strictEqual(rejectedEnv.phaseDrop, 'UNRESOLVED');
      // UNRESOLVED means no phase directory yet (ROADMAP-only phases): the host's own PHASE_NUMBER stands in.
      assert.deepStrictEqual(runHandler(dispatchMd, rejectedEnv, hook, '07'), ['phase', 'probe', '--phase', '07', '--raw']);
      // Every other drop passes no phase.
      const unsafeEnv = renderEnvelope(fx.project, 'plan:pre', ['--phase', 'a;id'], env);
      assert.strictEqual(unsafeEnv.phaseDrop, 'INVALID_TOKEN');
      assert.deepStrictEqual(runHandler(dispatchMd, unsafeEnv, hook, '07'), ['phase', 'probe', '--raw']);
      // A custom phase id outside the token grammar (`+`, `@`, ...) drops as INVALID_TOKEN before any
      // lookup: no phase argument. The host's own PHASE_NUMBER fails the same in-context check, so the
      // project-state rows (no drop, UNRESOLVED) pass none for it too; '07' above is their positive control.
      assert.deepStrictEqual(runHandler(dispatchMd, bareEnv, hook, 'ab+cd'), ['phase', 'probe', '--raw']);
      assert.deepStrictEqual(runHandler(dispatchMd, rejectedEnv, hook, 'ab+cd'), ['phase', 'probe', '--raw']);
      // A custom id inside the grammar is the positive control: it reaches the handler.
      for (const [id, expected] of [['ab+cd', ['phase', 'probe', '--raw']], ['ab-cd', ['phase', 'probe', '--phase', 'ab-cd', '--raw']]]) {
        fs.mkdirSync(path.join(fx.project, '.planning', 'phases', id), { recursive: true });
        const customEnv = renderEnvelope(fx.project, 'plan:pre', ['--phase', id], env);
        assert.deepStrictEqual(runHandler(dispatchMd, customEnv, hook, id), expected, `${runtime}: custom id ${id}`);
      }
    }
  });

  test('[property] any --phase/--phase-dir input yields context only for the real phase directory', (t) => {
    const dir = makePhaseProject('05-widgets');
    t.after(() => cleanup(dir));
    t.mock.method(process.stderr, 'write', () => true); // unresolvable tokens warn; keep output quiet
    fc.assert(fc.property(
      fc.oneof(fc.string(), fc.constantFrom('05', '5', '005', '05-widgets', '../05', '')),
      fc.option(fc.string(), { nil: undefined }),
      (phase, phaseDir) => {
        const { context } = resolveActiveHooksForPoint(dir, 'plan:pre', { phase, phaseDir });
        if (context !== undefined) {
          assert.deepStrictEqual(context, { phase: '05', phaseDir: '.planning/phases/05-widgets' });
        }
        // A --phase-dir that names no phase directory of this project never yields a context (it is a cross-check).
        if (phaseDir !== undefined && phaseDir !== '' && !phaseDir.includes('05-widgets')) assert.strictEqual(context, undefined);
      },
    ), { seed: 4030, numRuns: 100 });
  });

  test('[property] every spelling of the real phase yields context with the real directory', (t) => {
    const dir = makePhaseProject('05-widgets');
    t.after(() => cleanup(dir));
    fc.assert(fc.property(fc.constantFrom('05', '5', '005', '05-widgets'), (phase) => {
      const { context } = resolveActiveHooksForPoint(dir, 'plan:pre', { phase });
      assert.ok(context, `${phase} must resolve`);
      assert.strictEqual(context.phaseDir, '.planning/phases/05-widgets');
      assert.strictEqual(typeof context.phase, 'string');
    }), { seed: 4030, numRuns: 20 });
  });

  // The flag seam is exercised through the CLI (few runs: each is a subprocess).
  test('[property] --phase= trims its padding, the space form takes a plain token, and a --value is an unknown flag', (t) => {
    const dir = makePhaseProject('05-widgets');
    t.after(() => cleanup(dir));
    const pad = fc.stringMatching(/^[ \t]{0,3}$/);
    const spaced = renderWithPhase(dir, 'plan:pre', ['--phase', '05', '--raw']);
    assert.strictEqual(spaced.exitCode, 0, spaced.stderr);
    assert.strictEqual(contextOf(spaced).phase, '05');
    fc.assert(fc.property(pad, pad, fc.stringMatching(/^[a-zA-Z0-9._=-]{0,8}$/), (l, r, junk) => {
      const ok = renderWithPhase(dir, 'plan:pre', [`--phase=${l}05${r}`, '--raw']);
      assert.strictEqual(ok.exitCode, 0, ok.stderr);
      assert.strictEqual(contextOf(ok).phase, '05');
      // `--x` prefix: no gsd-tools global flag (--ws, --cwd=, --h, ...) starts with it, so the value stays a plain --value.
      const bad = runNode(
        [GSD_TOOLS, 'loop', 'render-hooks', 'plan:pre', '--cwd', dir, '--phase', `--x${junk}`, '--raw'],
        { cwd: ROOT, timeoutMs: PROBE_TIMEOUT_MS, env: isolatedEnv({ home: dir, override: { GSD_JSON_ERRORS: '1' } }) },
      );
      assert.notStrictEqual(bad.exitCode, 0, 'a --value after --phase is an unknown flag, like on every other verb');
      assert.ok(bad.stderr.trim().startsWith('{'), `stderr is not a JSON error: ${bad.stderr}`);
      assert.strictEqual(JSON.parse(bad.stderr.trim()).reason, 'usage');
    }), { seed: 4030, numRuns: 12, examples: [['', '', 'ws=..'], ['', '', 'cwd=x']] });
  });

  // #4030: --phase-dir is accepted, but only as a check against what --phase
  // resolved to. It is never an independent path, so nothing here needs
  // confinement — the emitted phaseDir is always locator-produced.
  test('[happy] --phase-dir agreeing with the resolved directory yields context', (t) => {
    const dir = makePhaseProject('05-widgets');
    t.after(() => cleanup(dir));
    assert.deepStrictEqual(
      renderEnvelope(dir, 'plan:pre', ['--phase', '05', '--phase-dir', '.planning/phases/05-widgets']).context,
      { phase: '05', phaseDir: '.planning/phases/05-widgets' },
    );
  });

  test('[negative] an incoherent --phase / --phase-dir pair is rejected, though both are in-project', (t) => {
    const dir = makePhaseProject('05-widgets', '07-other');
    t.after(() => cleanup(dir));
    const envelope = renderEnvelope(dir, 'plan:pre', ['--phase', '05', '--phase-dir', '.planning/phases/07-other']);
    assert.ok(!Object.prototype.hasOwnProperty.call(envelope, 'context'),
      'a directory naming a different phase than the token must not produce context');
    assert.ok((envelope.warnings || []).length > 0);
    assert.strictEqual(dropOf(dir, { phase: '05', phaseDir: '.planning/phases/07-other' }), PHASE_DROP.DIR_MISMATCH);
  });

  test('[negative] an incoherent pair is still rejected when the filesystem reports ino 0 (FAT32/exFAT/SMB)', (t) => {
    const dir = makePhaseProject('05-widgets', '07-other');
    t.after(() => cleanup(dir));
    const realStat = fs.statSync;
    t.mock.method(fs, 'statSync', (p, ...rest) => {
      const st = realStat(p, ...rest);
      return st && st.isDirectory() ? Object.assign(Object.create(Object.getPrototypeOf(st)), st, { ino: rest[0] && rest[0].bigint ? 0n : 0 }) : st;
    });
    const result = resolveActiveHooksForPoint(dir, 'plan:pre', { phase: '05', phaseDir: '.planning/phases/07-other' });
    assert.strictEqual(result.context, undefined);
    assert.strictEqual(result.phaseDrop, PHASE_DROP.DIR_MISMATCH);
    const same = resolveActiveHooksForPoint(dir, 'plan:pre', { phase: '05', phaseDir: '.planning/phases/05-widgets' });
    assert.deepStrictEqual(same.context, { phase: '05', phaseDir: '.planning/phases/05-widgets' });
  });

  test('[hostile] an out-of-project --phase-dir is rejected by disagreement, not by confinement', (t) => {
    const dir = makePhaseProject('05-widgets');
    t.after(() => cleanup(dir));
    for (const outside of ['/tmp', '/etc', '../../etc', '.planning/phases/../../..']) {
      const envelope = renderEnvelope(dir, 'plan:pre', ['--phase', '05', '--phase-dir', outside]);
      assert.ok(!Object.prototype.hasOwnProperty.call(envelope, 'context'),
        `${outside} must never produce context`);
      assert.strictEqual(envelope.phaseDrop, PHASE_DROP.DIR_MISMATCH, `${outside} is rejected by disagreement`);
    }
  });

  test('[bva] --phase-dir accepts any spelling of the SAME directory, and still emits the locator form', (t) => {
    const dir = makePhaseProject('05-widgets');
    t.after(() => cleanup(dir));
    // Sibling commands take absolute paths (resolvePath, check-command-router),
    // so a caller following that convention must not silently lose its context.
    // Comparison is on resolved paths; the emitted value is unchanged.
    for (const spelling of [
      '.planning/phases/05-widgets',
      '.planning/phases/05-widgets/',
      './.planning/phases/05-widgets',
      '.planning//phases/05-widgets',
      '.planning/phases/07/../05-widgets',
      path.join(dir, '.planning', 'phases', '05-widgets'),
    ]) {
      assert.deepStrictEqual(
        renderEnvelope(dir, 'plan:pre', ['--phase', '05', '--phase-dir', spelling]).context,
        { phase: '05', phaseDir: '.planning/phases/05-widgets' },
        `${spelling} names the resolved directory, so it must match and emit the locator's form`,
      );
    }
  });

  // The comparison is filesystem identity (dev+ino), not pathname equality: a symlink spelling of the same
  // directory matches. Positive control: a symlink to ANOTHER phase directory is a DIR_MISMATCH.
  test('[bva] --phase-dir given as a symlink to the same directory matches; to another directory it does not', { skip: process.platform === 'win32' && 'symlinks need privileges on Windows' }, (t) => {
    const dir = makePhaseProject('05-widgets', '06-gadgets');
    t.after(() => cleanup(dir));
    fs.symlinkSync(path.join(dir, '.planning', 'phases', '05-widgets'), path.join(dir, 'same-link'), 'dir');
    fs.symlinkSync(path.join(dir, '.planning', 'phases', '06-gadgets'), path.join(dir, 'other-link'), 'dir');
    const same = renderEnvelope(dir, 'plan:pre', ['--phase', '05', '--phase-dir', 'same-link']);
    assert.deepStrictEqual(same.context, { phase: '05', phaseDir: '.planning/phases/05-widgets' });
    const other = renderEnvelope(dir, 'plan:pre', ['--phase', '05', '--phase-dir', 'other-link']);
    assert.strictEqual(other.context, undefined);
    assert.strictEqual(other.phaseDrop, 'DIR_MISMATCH');
  });

  // The negative input matrix of the --phase flag at the CLI: each row drops, never fails the render.
  test('[negative] a whitespace-only --phase and a malformed --phase== drop as INVALID_TOKEN with exit 0', (t) => {
    const dir = makePhaseProject('05-widgets');
    t.after(() => cleanup(dir));
    for (const argv of [['--phase', '  '], ['--phase=  '], ['--phase==1'], ['--phase', '=1']]) {
      const env = renderEnvelope(dir, 'plan:pre', argv);
      assert.strictEqual(env.context, undefined, argv.join(' '));
      assert.strictEqual(env.phaseDrop, 'INVALID_TOKEN', argv.join(' '));
    }
  });

  test('[negative] --phase-dir without --phase is refused rather than trusted', (t) => {
    const dir = makePhaseProject('05-widgets');
    t.after(() => cleanup(dir));
    const envelope = renderEnvelope(dir, 'plan:pre', ['--phase-dir', '.planning/phases/05-widgets']);
    assert.ok(!Object.prototype.hasOwnProperty.call(envelope, 'context'),
      'a lone --phase-dir must never become the context source');
    assert.ok((envelope.warnings || []).length > 0);
    assert.strictEqual(dropOf(dir, { phaseDir: '.planning/phases/05-widgets' }), PHASE_DROP.PHASE_DIR_ALONE);
  });

  test('[negative] bare --phase-dir with no value degrades like an omitted flag, never a hard error', (t) => {
    const dir = makePhaseProject('05-widgets');
    t.after(() => cleanup(dir));
    const envelope = renderEnvelope(dir, 'plan:pre', ['--phase', '05', '--phase-dir']);
    // --phase alone still resolves — a bare trailing --phase-dir just contributes nothing.
    assert.deepStrictEqual(envelope.context, { phase: '05', phaseDir: '.planning/phases/05-widgets' });
  });

  test('[bva] an empty or root --phase-dir next to a resolvable --phase drops as DIR_MISMATCH', (t) => {
    const dir = makePhaseProject('05-widgets');
    t.after(() => cleanup(dir));
    for (const dirArgs of [['--phase-dir='], ['--phase-dir', ''], ['--phase-dir', '/']]) {
      const envelope = renderEnvelope(dir, 'plan:pre', ['--phase', '05', ...dirArgs]);
      assert.ok(!Object.prototype.hasOwnProperty.call(envelope, 'context'), dirArgs.join(' '));
    }
    assert.strictEqual(dropOf(dir, { phase: '05', phaseDir: '' }), PHASE_DROP.DIR_MISMATCH);
    assert.strictEqual(dropOf(dir, { phase: '05', phaseDir: '/' }), PHASE_DROP.DIR_MISMATCH);
  });

  test('[bva] an ambiguous token yields no context even when --phase-dir names a candidate', (t) => {
    const dir = makePhaseProject('05-widgets', '05-gadgets');
    t.after(() => cleanup(dir));
    const envelope = renderEnvelope(dir, 'plan:pre', ['--phase', '05', '--phase-dir', '.planning/phases/05-gadgets']);
    assert.ok(!Object.prototype.hasOwnProperty.call(envelope, 'context'),
      'the directory must not break an ambiguity tie — init.* does not either (#2237)');
    assert.ok((envelope.warnings || []).length > 0);
    assert.strictEqual(dropOf(dir, { phase: '05', phaseDir: '.planning/phases/05-gadgets' }), PHASE_DROP.AMBIGUOUS);
  });

  test('[happy] context is resolved from --phase alone, and STATE.md is neither read back nor written', (t) => {
    const dir = makePhaseProject('02-beta');
    t.after(() => cleanup(dir));
    const statePath = path.join(dir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, 'current_phase: 01\n');
    const before = fs.readFileSync(statePath);
    const result = renderWithPhase(dir, 'plan:pre', ['--phase', '02', '--raw']);
    assert.strictEqual(result.exitCode, 0, 'stderr: ' + result.stderr);
    assert.strictEqual(contextOf(result).phase, '02',
      'the emitted phase is the caller\'s token, not STATE.current_phase (01)');
    assert.deepStrictEqual(fs.readFileSync(statePath), before, 'STATE.md must stay byte-identical');
  });

  test('[phaseDrop] dispatch table codes equal PHASE_DROP', () => {
    const rows = dispatchTable(dispatchMdOnce());
    // sorted with duplicates kept: every code appears in exactly one row, hence maps to exactly one argument
    assert.deepStrictEqual(rows.flatMap((x) => x.codes).sort(), Object.keys(PHASE_DROP).sort());
  });

  // The host keeps its own phase for a drop that comes from project state, not from the caller's input.
  const HOST_PHASE_DROPS = ['UNRESOLVED', 'ARCHIVED', 'AMBIGUOUS', 'CONFIG_FAULT'];
  for (const code of Object.keys(PHASE_DROP)) {
    test(`[phaseDrop] ${code} gives a ref.command handler ${HOST_PHASE_DROPS.includes(code) ? 'the host phase' : 'no phase'}`, () => {
      const argv = runHandler(dispatchMdOnce(), { phaseDrop: code }, { ref: { command: 'phase probe' } }, '07');
      assert.deepStrictEqual(
        argv,
        HOST_PHASE_DROPS.includes(code) ? ['phase', 'probe', '--phase', '07', '--raw'] : ['phase', 'probe', '--raw'],
      );
    });
  }

  test('[phaseDrop] envelope carries phaseDrop for a dropped token', (t) => {
    const dir = makePhaseProject('01-alpha', '02-beta');
    t.after(() => cleanup(dir));
    const env = (args) => renderEnvelope(dir, 'plan:pre', args);
    assert.strictEqual(env(['--phase', '99']).phaseDrop, 'UNRESOLVED');
    assert.strictEqual(env(['--phase', '02', '--phase-dir', '.planning/phases/01-alpha']).phaseDrop, 'DIR_MISMATCH');
    assert.ok(!Object.prototype.hasOwnProperty.call(env(['--phase', '02']), 'phaseDrop'), 'a resolved token carries no phaseDrop');
  });

  test('[phaseDrop] an unresolved phase reaches the discuss:pre handler', (t) => {
    const fx = makeThirdPartyStepFixture(PHASE_SCOPED_POINTS);
    t.after(() => { cleanup(fx.home); cleanup(fx.project); });
    const envelope = renderEnvelope(fx.project, 'discuss:pre', ['--phase', '03'], fxEnv(fx));
    assert.strictEqual(envelope.context, undefined);
    const hook = probeOf(envelope, 'discuss:pre --phase 03');
    assert.deepStrictEqual(runHandler(dispatchMdOnce(), envelope, hook, '03'), ['phase', 'probe', '--phase', '03', '--raw']);
  });

  test('[bva] a token of 63 or 64 characters reaches the lookup; 65 is an INVALID_TOKEN', (t) => {
    const dir = makePhaseProject('05-widgets');
    t.after(() => cleanup(dir));
    for (const [length, drop] of [[63, PHASE_DROP.UNRESOLVED], [64, PHASE_DROP.UNRESOLVED], [65, PHASE_DROP.INVALID_TOKEN]]) {
      assert.strictEqual(dropOf(dir, { phase: 'a'.repeat(length) }), drop, `${length} characters`);
    }
  });

  test('[phase token] dispatch contract regex equals PHASE_TOKEN_RE.source', () => {
    const m = dispatchMdOnce().match(TOKEN_CHECK_RE);
    assert.ok(m, 'dispatch contract lost its in-context phase-token check');
    assert.strictEqual(`^${m[1]}$`, PHASE_TOKEN_RE.source);
  });

  // loop-resolver destructures guardedFindPhase at load: wrap the locator's export (t.mock.method restores it
  // when the test ends, whatever throws), then reload the resolver so it binds the wrapper. The cache entry
  // is dropped in t.after, registered before the reload.
  function resolverWithLocator(t, wrap) {
    const lib = (n) => path.join(ROOT, 'gsd-core/bin/lib', n);
    const loc = require(lib('phase-locator.cjs'));
    t.after(() => { delete require.cache[require.resolve(lib('loop-resolver.cjs'))]; });
    t.mock.method(loc, 'guardedFindPhase', wrap(loc.guardedFindPhase));
    delete require.cache[require.resolve(lib('loop-resolver.cjs'))];
    return require(lib('loop-resolver.cjs'));
  }

  test('[phase token] hostile custom id never reaches context', (t) => {
    const calls = [];
    const fresh = resolverWithLocator(t, (orig) => (...a) => { calls.push(a[1]); return orig(...a); });
    const customProject = (name) => {
      const dir = makePhaseProject(name);
      t.after(() => cleanup(dir));
      fs.writeFileSync(path.join(dir, '.planning', 'config.json'), JSON.stringify({ phase_naming: 'custom' }));
      return dir;
    };
    // positive control: a safe token on a safe directory is looked up and resolves
    const ok = customProject('05-x');
    const good = fresh.resolveActiveHooksForPoint(ok, 'plan:pre', { phase: '05' });
    assert.deepStrictEqual(calls, ['05']);
    assert.deepStrictEqual(good.context, { phase: '05', phaseDir: '.planning/phases/05-x' });
    for (const id of ['a`id`', 'a;id', 'AB$(id)']) {
      calls.length = 0;
      const dir = customProject(id + '-hostile');
      const hostile = fresh.resolveActiveHooksForPoint(dir, 'plan:pre', { phase: id });
      assert.strictEqual(hostile.context, undefined, id);
      assert.strictEqual(hostile.phaseDrop, PHASE_DROP.INVALID_TOKEN, id);
      assert.deepStrictEqual(calls, [], `${id}: no lookup before the token check`);
      const cli = renderEnvelope(dir, 'plan:pre', ['--phase', id]);
      assert.strictEqual(cli.context, undefined);
      assert.strictEqual(cli.phaseDrop, 'INVALID_TOKEN');
      // a safe token on the same fixture is still looked up and merely unresolved
      assert.strictEqual(fresh.resolveActiveHooksForPoint(dir, 'plan:pre', { phase: 'a' }).phaseDrop, PHASE_DROP.UNRESOLVED);
    }
  });

  test('[config] unusable config.json fails --phase closed', (t) => {
    const unparseable = makePhaseProject('02-beta');
    const unreadable = makePhaseProject('02-beta');
    t.after(() => { cleanup(unparseable); cleanup(unreadable); });
    fs.writeFileSync(path.join(unparseable, '.planning', 'config.json'), '{bad');
    fs.mkdirSync(path.join(unreadable, '.planning', 'config.json'));
    for (const [dir, reason] of [[unparseable, 'config_unparseable'], [unreadable, 'config_unreadable']]) {
      const env = renderEnvelope(dir, 'plan:pre', ['--phase', '02']);
      assert.strictEqual(env.context, undefined);
      assert.strictEqual(env.phaseDrop, 'CONFIG_FAULT');
      assert.ok(Array.isArray(env.warnings), `envelope has no warnings array: ${JSON.stringify(env)}`);
      assert.ok(env.warnings.length > 0, `a drop for ${reason} carries a warning`);
    }
  });

  // A hostile GSD_WORKSTREAM never gets this far through the CLI (gsd-tools rejects it at entry, with or
  // without --phase), so the lookup throw is pinned in-process: planningDir throws inside guardedFindPhase.
  test('[config] a throw from the phase lookup degrades --phase to a typed CONFIG_FAULT drop', (t) => {
    let hostile = false;
    const fresh = resolverWithLocator(t, (orig) => (...a) => {
      if (hostile) throw new Error('GSD_WORKSTREAM contains invalid path characters: ../x');
      return orig(...a);
    });
    const dir = makePhaseProject('02-beta');
    t.after(() => cleanup(dir));
    // positive control: the same project resolves while the lookup does not throw
    assert.deepStrictEqual(fresh.resolveActiveHooksForPoint(dir, 'plan:pre', { phase: '02' }).context, { phase: '02', phaseDir: '.planning/phases/02-beta' });
    hostile = true;
    const r = fresh.resolveActiveHooksForPoint(dir, 'plan:pre', { phase: '02' });
    assert.strictEqual(r.context, undefined);
    assert.strictEqual(r.phaseDrop, PHASE_DROP.CONFIG_FAULT);
    assert.ok(r.warnings.length > 0, 'a drop carries a warning');
  });

  test('[phase token] a locator value that differs from the validated token is dropped as INVALID_TOKEN', (t) => {
    let returned;
    const fresh = resolverWithLocator(t, (orig) => (...a) => ({ ...orig(...a), phase_number: returned }));
    const dir = makePhaseProject('02-beta');
    t.after(() => cleanup(dir));
    returned = '02';
    assert.deepStrictEqual(fresh.resolveActiveHooksForPoint(dir, 'plan:pre', { phase: '02' }).context, { phase: '02', phaseDir: '.planning/phases/02-beta' });
    for (const bad of ['02;id', '$(id)', '`id`', '', 'a'.repeat(65)]) {
      returned = bad;
      const r = fresh.resolveActiveHooksForPoint(dir, 'plan:pre', { phase: '02' });
      assert.strictEqual(r.context, undefined, JSON.stringify(bad));
      assert.strictEqual(r.phaseDrop, PHASE_DROP.INVALID_TOKEN, JSON.stringify(bad));
    }
  });

  test('[phaseDrop] the ambiguous drop lists at most 5 candidates and counts the rest', (t) => {
    const echoedMore = (n) => {
      const dir = makePhaseProject(...Array.from({ length: n }, (_, i) => `05-${String.fromCharCode(97 + i)}`));
      t.after(() => cleanup(dir));
      const env = renderEnvelope(dir, 'plan:pre', ['--phase', '05']);
      assert.strictEqual(env.phaseDrop, PHASE_DROP.AMBIGUOUS);
      assert.ok(Array.isArray(env.phaseEchoed), `envelope has no phaseEchoed array: ${JSON.stringify(env).slice(0, 200)}`);
      // phaseEchoed leads with the --phase token; the candidates follow, at most 5.
      return { listed: env.phaseEchoed.length - 1, more: env.phaseMore };
    };
    assert.deepStrictEqual(echoedMore(4), { listed: 4, more: undefined });
    assert.deepStrictEqual(echoedMore(5), { listed: 5, more: undefined });
    assert.deepStrictEqual(echoedMore(6), { listed: 5, more: 1 });
    assert.deepStrictEqual(echoedMore(7), { listed: 5, more: 2 });
  });
});

// #4030: confinement by realpath, same-directory by dev+ino, boundary rows.
describe('cmdLoopRenderHooks --phase confinement and --phase-dir identity (#4030)', () => {
  const symlinkSkip = process.platform === 'win32' ? 'directory symlinks require elevation on Windows' : false;
  const mk = (t, ...names) => {
    const dir = makePhaseProject(...names);
    t.after(() => cleanup(dir));
    return dir;
  };
  const runText = (dir, args) => {
    const r = renderWithPhase(dir, 'plan:pre', [...args, '--raw']);
    assert.strictEqual(r.exitCode, 0, 'stderr: ' + r.stderr);
    return r.stdout;
  };
  const run = (dir, args) => renderEnvelope(dir, 'plan:pre', args);

  test('[hostile] a symlinked .planning/phases parent yields no context and a warning, hooks still dispatch', { skip: symlinkSkip }, (t) => {
    const dir = createTempDir('loop-phase-conf-');
    const outside = createTempDir('loop-phase-outside-');
    t.after(() => { cleanup(dir); cleanup(outside); });
    fs.mkdirSync(path.join(outside, '07-evil'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
    fs.symlinkSync(outside, path.join(dir, '.planning', 'phases'), 'dir');
    const env = run(dir, ['--phase', '07']);
    assert.ok(!Object.prototype.hasOwnProperty.call(env, 'context'));
    assert.ok((env.warnings || []).length > 0);
    assert.strictEqual(dropOf(dir, { phase: '07' }), PHASE_DROP.ESCAPES_ROOT);
    assert.ok(Array.isArray(env.activeHooks));
  });

  // ADR-4908: a `.planning` symlinked to a store outside the checkout is a supported layout;
  // confinement is against the store (ProjectContext.planningRoot), not the checkout.
  test('[happy] symlinked .planning store resolves', { skip: symlinkSkip }, (t) => {
    const dir = createTempDir('loop-phase-conf-');
    const store = createTempDir('loop-phase-store-');
    t.after(() => { cleanup(dir); cleanup(store); });
    fs.mkdirSync(path.join(store, 'phases', '02-x'), { recursive: true });
    fs.symlinkSync(store, path.join(dir, '.planning'), 'dir');
    const env = run(dir, ['--phase', '02']);
    assert.deepStrictEqual(env.context, { phase: '02', phaseDir: '.planning/phases/02-x' });
    assert.ok(!Object.prototype.hasOwnProperty.call(env, 'phaseDrop'));
  });

  test('[hostile] a symlinked .planning store whose phases link leaves the store yields no context and a warning', { skip: symlinkSkip }, (t) => {
    const dir = createTempDir('loop-phase-conf-');
    const store = createTempDir('loop-phase-store-');
    const outside = createTempDir('loop-phase-outside-');
    t.after(() => { cleanup(dir); cleanup(store); cleanup(outside); });
    fs.mkdirSync(path.join(outside, '07-evil'), { recursive: true });
    fs.symlinkSync(outside, path.join(store, 'phases'), 'dir');
    fs.symlinkSync(store, path.join(dir, '.planning'), 'dir');
    const env = run(dir, ['--phase', '07']);
    assert.ok(!Object.prototype.hasOwnProperty.call(env, 'context'));
    assert.ok((env.warnings || []).length > 0);
    assert.strictEqual(dropOf(dir, { phase: '07' }), PHASE_DROP.ESCAPES_ROOT);
  });

  test('[hostile] a symlinked workstream that leaves the planning root yields no context and ESCAPES_ROOT', { skip: symlinkSkip }, (t) => {
    const dir = createTempDir('loop-phase-conf-');
    const outside = createTempDir('loop-phase-outside-');
    t.after(() => { cleanup(dir); cleanup(outside); });
    fs.mkdirSync(path.join(outside, 'phases', '05-evil'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.planning', 'workstreams'), { recursive: true });
    fs.symlinkSync(outside, path.join(dir, '.planning', 'workstreams', 'alpha'), 'dir');
    const env = run(dir, ['--phase', '05', '--ws=alpha']);
    assert.ok(!Object.prototype.hasOwnProperty.call(env, 'context'));
    const prior = process.env.GSD_WORKSTREAM;
    t.after(() => { if (prior === undefined) delete process.env.GSD_WORKSTREAM; else process.env.GSD_WORKSTREAM = prior; });
    process.env.GSD_WORKSTREAM = 'alpha';
    assert.strictEqual(dropOf(dir, { phase: '05' }), PHASE_DROP.ESCAPES_ROOT);
  });

  // Every echoed value in a warning is a JSON string capped at 80 characters
  // with no control characters. Read them from the typed `phaseEchoed` field and
  // assert on length and code points, never on prose or raw stdout bytes.
  const echoed = (out) => {
    const { phaseEchoed } = JSON.parse(out.trim());
    assert.ok(Array.isArray(phaseEchoed), `envelope has no phaseEchoed array: ${out.slice(0, 200)}`);
    return phaseEchoed.map((v) => v.slice(1, -1)); // the escaped form as printed, never decoded back
  };
  // The error codes a filesystem uses to refuse a directory name; any other setup error fails the test.
  const FS_REFUSED_NAME = new Set(['EINVAL', 'ENOENT', 'EILSEQ']);
  const hasControl = (v) => [...v].some((c) => { const n = c.codePointAt(0); return n <= 0x1f || (n >= 0x7f && n <= 0x9f); });
  const archivedProject = (t, name) => {
    const dir = mk(t);
    fs.mkdirSync(path.join(dir, '.planning', 'milestones', 'v1.0-phases', name), { recursive: true });
    return dir;
  };
  const escapingProject = (t, name) => {
    const dir = createTempDir('loop-phase-conf-');
    const outside = createTempDir('loop-phase-outside-');
    t.after(() => { cleanup(dir); cleanup(outside); });
    fs.mkdirSync(path.join(outside, name), { recursive: true });
    fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
    fs.symlinkSync(outside, path.join(dir, '.planning', 'phases'), 'dir');
    return dir;
  };
  const ambiguousProject = (t, name) => mk(t, name, '05-b');
  const unresolvedProject = (t) => mk(t, '01-x');
  const mismatchProject = (t, name) => mk(t, name);
  const branches = [
    ['ARCHIVED', archivedProject, PHASE_DROP.ARCHIVED, {}],
    ['ESCAPES_ROOT', escapingProject, PHASE_DROP.ESCAPES_ROOT, { skip: symlinkSkip }],
  ];
  for (const [label, project, drop, opts] of branches) {
    for (const n of [79, 80, 81, 200]) {
      test(`[bva] ${label} echoes the directory capped at 80 (directory echo length ${n})`, opts, (t) => {
        const prefix = label === 'ARCHIVED' ? '.planning/milestones/v1.0-phases/' : '.planning/phases/';
        const name = '05-' + 'a'.repeat(n - prefix.length - 3);
        const dir = project(t, name);
        assert.strictEqual(dropOf(dir, { phase: '05' }), drop);
        const values = echoed(runText(dir, ['--phase', '05']));
        assert.strictEqual(values[1].length, Math.min(n, 80));
        assert.ok(values.every((v) => v.length <= 80));
      });
    }
    test(`[hostile] ${label} echoes no control characters`, opts, (t) => {
      const name = '05-a\u001b[31m\nb';
      let dir;
      try { dir = project(t, name); } catch (err) { if (!FS_REFUSED_NAME.has(err.code)) throw err; t.skip('FS refuses control characters'); return; }
      assert.strictEqual(dropOf(dir, { phase: '05' }), drop);
      const values = echoed(runText(dir, ['--phase', '05']));
      assert.ok(values.length > 1 && values.every((v) => !hasControl(v)), 'echoed values (token and directory) must be single-line and escaped');
    });
  }

  const NAME = (n) => '05-' + 'a'.repeat(n - 3);
  for (const n of [79, 80, 81, 200]) {
    test(`[bva] AMBIGUOUS echoes each candidate name capped at 80 (name length ${n})`, (t) => {
      const dir = ambiguousProject(t, NAME(n));
      assert.strictEqual(dropOf(dir, { phase: '05' }), PHASE_DROP.AMBIGUOUS);
      const values = echoed(runText(dir, ['--phase', '05']));
      assert.ok(values.some((v) => v.length === Math.min(n, 80)));
      assert.ok(values.every((v) => v.length <= 80));
    });
    test(`[bva] DIR_MISMATCH echoes --phase-dir capped at 80 (value length ${n})`, (t) => {
      const dir = mismatchProject(t, NAME(n));
      const args = { phase: '05', phaseDir: 'z'.repeat(n) };
      assert.strictEqual(dropOf(dir, args), PHASE_DROP.DIR_MISMATCH);
      const values = echoed(runText(dir, ['--phase', '05', '--phase-dir', args.phaseDir]));
      assert.strictEqual(values[0].length, Math.min(n, 80));
      assert.ok(values.every((v) => v.length <= 80));
    });
    test(`[bva] INVALID_TOKEN echoes the --phase token capped at 80 (token length ${n})`, (t) => {
      const token = '9' + 'q'.repeat(n - 1);
      const dir = unresolvedProject(t);
      assert.strictEqual(dropOf(dir, { phase: token }), PHASE_DROP.INVALID_TOKEN);
      const values = echoed(runText(dir, ['--phase', token]));
      assert.strictEqual(values[0].length, Math.min(n, 80));
      assert.ok(values.every((v) => v.length <= 80));
    });
  }
  test('[hostile] AMBIGUOUS echoes no control characters (checked after JSON.parse)', (t) => {
    let dir;
    try { dir = ambiguousProject(t, '05-a\u001b[31m\nb'); } catch (err) { if (!FS_REFUSED_NAME.has(err.code)) throw err; t.skip('FS refuses control characters'); return; }
    assert.strictEqual(dropOf(dir, { phase: '05' }), PHASE_DROP.AMBIGUOUS);
    const values = echoed(runText(dir, ['--phase', '05']));
    assert.ok(values.length > 0 && values.every((v) => !hasControl(v)), 'echoed values must be escaped');
  });
  test('[hostile] INVALID_TOKEN and DIR_MISMATCH echo no control characters', (t) => {
    const token = '9a\u001b[31m\nb';
    assert.strictEqual(dropOf(unresolvedProject(t), { phase: token }), PHASE_DROP.INVALID_TOKEN);
    const unresolved = echoed(runText(unresolvedProject(t), ['--phase', token]));
    assert.ok(unresolved.length > 0 && unresolved.every((v) => !hasControl(v)));
    const mismatch = echoed(runText(mismatchProject(t, '05-x'), ['--phase', '05', '--phase-dir', token]));
    assert.ok(mismatch.length > 0 && mismatch.every((v) => !hasControl(v)));
  });

  test('[hostile] a bidi override and a zero-width character in --phase are escaped in the warning', (t) => {
    const [bidi, zeroWidth] = [String.fromCharCode(0x202e), String.fromCharCode(0x200b)];
    const token = `9a${bidi}b${zeroWidth}c`;
    const r = resolveActiveHooksForPoint(unresolvedProject(t), 'plan:pre', { phase: token });
    assert.strictEqual(r.phaseDrop, PHASE_DROP.INVALID_TOKEN);
    const [w] = r.phaseEchoed;
    assert.ok(!w.includes(bidi) && !w.includes(zeroWidth), 'no raw bidi or zero-width character in the echoed token');
    assert.ok(w.includes('\\u202e') && w.includes('\\u200b'), 'both are escaped as \\uXXXX');
  });

  // 0/1/2 directory matches x --phase-dir (match | mismatch)
  test('[bva] 0 matches + --phase-dir: warning, no context', (t) => {
    const r = resolveActiveHooksForPoint(mk(t), 'plan:pre', { phase: '05', phaseDir: '.planning/phases/05-x' });
    assert.strictEqual(r.context, undefined);
    assert.strictEqual(r.phaseDrop, PHASE_DROP.UNRESOLVED);
  });
  test('[bva] 1 match + matching --phase-dir: context', (t) => {
    const env = run(mk(t, '05-x'), ['--phase', '05', '--phase-dir', '.planning/phases/05-x']);
    assert.deepStrictEqual(env.context, { phase: '05', phaseDir: '.planning/phases/05-x' });
  });
  test('[bva] 1 match + mismatching (nonexistent) --phase-dir: warning, no context', (t) => {
    const r = resolveActiveHooksForPoint(mk(t, '05-x'), 'plan:pre', { phase: '05', phaseDir: '.planning/phases/05-nope' });
    assert.strictEqual(r.context, undefined);
    assert.strictEqual(r.phaseDrop, PHASE_DROP.DIR_MISMATCH);
  });
  test('[bva] 2 matches + matching --phase-dir: ambiguous, no context', (t) => {
    const r = resolveActiveHooksForPoint(mk(t, '05-x', '05-y'), 'plan:pre', { phase: '05', phaseDir: '.planning/phases/05-x' });
    assert.strictEqual(r.context, undefined);
    assert.strictEqual(r.phaseDrop, PHASE_DROP.AMBIGUOUS);
  });
  test('[bva] 2 matches + mismatching --phase-dir: ambiguous, no context', (t) => {
    const r = resolveActiveHooksForPoint(mk(t, '05-x', '05-y'), 'plan:pre', { phase: '05', phaseDir: '.planning/phases/05-z' });
    assert.strictEqual(r.context, undefined);
    assert.strictEqual(r.phaseDrop, PHASE_DROP.AMBIGUOUS);
  });

  // dev+ino identity: a case-variant spelling matches only where the FS says it is the same dir.
  test('[bva] --phase-dir case variant matches iff the filesystem treats it as the same directory', (t) => {
    const dir = mk(t, '05-widgets');
    const insensitive = fs.existsSync(path.join(dir, '.planning', 'PHASES'));
    if (!insensitive) { t.skip('case-sensitive filesystem'); return; }
    const env = run(dir, ['--phase', '05', '--phase-dir', '.planning/PHASES/05-Widgets']);
    assert.deepStrictEqual(env.context, { phase: '05', phaseDir: '.planning/phases/05-widgets' });
  });
  test('[negative] --phase-dir case variant is rejected on a case-sensitive filesystem', (t) => {
    const dir = mk(t, '05-widgets');
    if (fs.existsSync(path.join(dir, '.planning', 'PHASES'))) { t.skip('case-insensitive filesystem'); return; }
    const env = run(dir, ['--phase', '05', '--phase-dir', '.planning/PHASES/05-Widgets']);
    assert.ok(!('context' in env));
  });
});
