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

const { cleanup, createTempDir, createTempProject } = require('./helpers.cjs');
const fc = require('./helpers/fast-check-setup.cjs');
const { splitLines } = require('../gsd-core/bin/lib/text-lines.cjs');
const { escapeRegex } = require('../gsd-core/bin/lib/pattern.cjs');

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
    assert.match(rendered, /skill:ui-phase/);
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
const ROOT = path.resolve(__dirname, '..');
const GSD_TOOLS = path.join(ROOT, 'gsd-core', 'bin', 'gsd-tools.cjs');

describe('cmdLoopRenderHooks end-to-end (via gsd-tools)', () => {
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

// [file, point, count] tuples: how many render-hooks <point> occurrences that
// file has, and how many of them must carry --phase. Both counts are
// asserted so a call site that gains a --phase-less duplicate is caught
// too, not just a wholesale removal.
const SITES = [
  ['gsd-core/workflows/discuss-phase.md', 'discuss:pre', 1],
  ['gsd-core/workflows/discuss-phase.md', 'discuss:post', 1],
  ['gsd-core/workflows/plan-phase.md', 'plan:pre', 4],
  ['gsd-core/workflows/plan-phase.md', 'plan:post', 1],
  ['gsd-core/workflows/execute-phase.md', 'execute:post', 1],
  ['gsd-core/workflows/execute-phase.md', 'execute:wave:pre', 1],
  ['gsd-core/workflows/execute-phase.md', 'execute:wave:post', 1],
  ['gsd-core/workflows/execute-phase/steps/verify-phase-goal.md', 'execute:post', 1],
  ['gsd-core/workflows/execute-phase/steps/verify-phase-goal.md', 'verify:post', 1],
  ['gsd-core/workflows/verify-work.md', 'verify:pre', 1],
  ['gsd-core/workflows/verify-work.md', 'verify:post', 1],
  ['gsd-core/workflows/secure-phase.md', 'verify:post', 1],
  ['gsd-core/workflows/validate-phase.md', 'verify:post', 1],
  ['gsd-core/workflows/autonomous.md', 'execute:post', 1],
  ['gsd-core/workflows/autonomous.md', 'verify:post', 1],
  ['gsd-core/workflows/code-review-fix.md', 'execute:post', 1],
  ['gsd-core/references/autonomous-ui-design-contract.md', 'plan:pre', 1],
];

// Matches one `render-hooks <point>` call site and captures its argument tail.
function callRe(point) {
  return new RegExp(`render-hooks ${escapeRegex(point)}\\b([^)\\n]*)`);
}

// The resolver tags each way it drops a phase context with a typed reason code
// (ADR-4030); tests assert the code, never the warning text.
function dropOf(dir, opts) {
  return resolveActiveHooksForPoint(dir, 'plan:pre', opts).phaseDrop;
}

// Collects the `render-hooks <point>` call sites in a workflow file and how
// many carry --phase. --active-cap lines are excluded: that mode returns only
// 'true'/'false' for one capability's activation (unaffected by phase) and
// never reads `context` (#4030); a hook-dispatch call site fetching the JSON
// envelope for actual dispatch is what these tables pin, not every
// render-hooks use.
function phaseSiteCounts(content, point) {
  const bare = splitLines(content).map((l) => !l.includes('--active-cap') && l.match(callRe(point))).filter(Boolean);
  return { bare, withPhase: bare.filter((m) => /--phase /.test(m[1])) };
}

// Static check (no bash interpreter): the last `name=` assignment before
// lines[idx] inside a bash/sh fence. `line` is its index (-1: none, so the var
// would expand empty and degrade to `--phase ""`); `sameFence` says whether it
// sits in the call's own fence. A `name="{placeholder}"` line is text the agent
// fills in, not a shell binding, so it never counts.
function phaseVarBinding(lines, idx, name) {
  const assign = new RegExp(`^\\s*(?:export\\s+|local\\s+)?${escapeRegex(name)}=(?!"?\\{)`);
  let inBash = false;
  let fence = -1;
  let found = { line: -1, fence: -1 };
  for (let i = 0; i < idx; i++) {
    const f = lines[i].match(/^\s*```(\w*)/);
    if (f) {
      inBash = !inBash && (f[1] === 'bash' || f[1] === 'sh');
      if (inBash) fence = i;
    } else if (inBash && assign.test(lines[i])) found = { line: i, fence };
  }
  return { line: found.line, sameFence: found.line !== -1 && inBash && found.fence === fence };
}

// Sites whose phase variable is bound in an EARLIER fence of the same file,
// keyed `file :: point` -> the exact binding line they rely on. Each fence runs
// as its own shell, so the dispatching agent carries the resolved token across
// (as it does `{phase_dir}`); a missed carry degrades to `--phase ""`, which
// warns and omits context (ADR-4030). Every other site binds in its own fence;
// the variables that binding reads are pinned in SRC_CROSS_FENCE.
// Pins the exact PHASE_NUMBER binding line each cross-fence site relies on; `--pick` is gsd-tools' own field extractor (verify-work.md's verify:pre binds from $INIT with jq instead).
const phaseBind = (arg) => `PHASE_NUMBER=$(gsd_run query init.phase-op \${GSD_WS:+--ws=\${GSD_WS##* }} "${arg}" --pick phase_number)`;
// Where the call's fence already holds INIT, the bind reads the phase from it (the verify-work form).
const INIT_JQ_BIND = `PHASE_NUMBER=$(printf '%s' "$INIT" | jq -r '.phase_number // empty')`;
// Fences with no INIT take the first positional token of $GSD_ARGS: it skips every flag and the value of --ws and --wave.
const ARGS_BIND = [
  'read -ra _gsd_argv <<<"$GSD_ARGS"; set -- "${_gsd_argv[@]}"',
  'while [ "$#" -gt 0 ]; do case "$1" in --ws|--wave) shift; [ "$#" -gt 0 ] && shift;; -*) shift;; *) break;; esac; done',
];
const INIT_BIND = phaseBind('${1}');
const VERIFY_BIND = `PHASE_NUMBER=\${PHASE_NUMBER:-$(${phaseBind('${1}').slice('PHASE_NUMBER=$('.length, -1)})}`;
const CROSS_FENCE = {
  'gsd-core/workflows/discuss-phase.md :: discuss:pre': INIT_JQ_BIND,
  'gsd-core/workflows/discuss-phase.md :: discuss:post': INIT_JQ_BIND,
  'gsd-core/workflows/plan-phase.md :: plan:pre': INIT_JQ_BIND,
  'gsd-core/workflows/plan-phase.md :: plan:post': INIT_JQ_BIND,
  'gsd-core/workflows/execute-phase.md :: execute:wave:pre': INIT_BIND,
  'gsd-core/workflows/execute-phase.md :: execute:wave:post': INIT_BIND,
  'gsd-core/workflows/execute-phase/steps/verify-phase-goal.md :: verify:post': VERIFY_BIND,
  'gsd-core/workflows/execute-phase/steps/verify-phase-goal.md :: execute:post': VERIFY_BIND,
  // verify-work's verify:pre fence binds PHASE_NUMBER from $INIT itself (#5289), before the call; verify:post carries that line.
  'gsd-core/workflows/verify-work.md :: verify:post': INIT_JQ_BIND,
  'gsd-core/workflows/secure-phase.md :: verify:post': INIT_JQ_BIND,
  'gsd-core/workflows/validate-phase.md :: verify:post': INIT_JQ_BIND,
  'gsd-core/workflows/code-review-fix.md :: execute:post': INIT_JQ_BIND,
};

// Sites that pass the autonomous driver's own loop variable. It is never
// shell-assigned (the host substitutes it, as in every other command of those
// files), and it always names the phase being driven: deriving the token from
// $PHASE_STATE instead named the NEXT phase once step 3a rebound it while the
// background execute of this one was still running.
const HOST_PHASE_VAR = 'PHASE_NUM';
const HOST_BOUND = new Set([
  'gsd-core/workflows/autonomous.md :: execute:post',
  'gsd-core/workflows/autonomous.md :: verify:post',
  'gsd-core/references/autonomous-ui-design-contract.md :: plan:pre',
]);

// True when `name` is assigned again later in the SAME fence as lines[idx]: each
// fence is its own shell, so a read before that assignment sees it unset.
function assignedLaterInFence(lines, idx, name) {
  const assign = new RegExp(`^\\s*(?:export\\s+|local\\s+)?${escapeRegex(name)}=`);
  for (let i = idx + 1; i < lines.length && !/^\s*```/.test(lines[i]); i++) if (assign.test(lines[i])) return true;
  return false;
}

// A Read-loaded file (a steps/ file or a reference) is not textually substituted, so each of its
// fences that captures $ARGUMENTS tells the agent to write the parent's argument string there.
const READ_LOADED_NOTE = "# #4772: this file is Read, not textually substituted - write the parent command's original argument string in place of $ARGUMENTS so --ws reaches the query.";
// The lines of the fence that holds lines[idx].
function fenceOf(lines, idx) {
  let s = idx;
  while (s > 0 && !/^\s*```/.test(lines[s - 1])) s--;
  let e = idx;
  while (e < lines.length && !/^\s*```/.test(lines[e])) e++;
  return lines.slice(s, e);
}

// Like CROSS_FENCE, for the variable the phase binding READS: the same sites
// that bind PHASE_NUMBER in their own fence still rely on the host carrying
// $INIT/$PHASE_STATE from an earlier one. Keyed `file :: point` -> exact line.
// verify-work binds PHASE_NUMBER from $INIT (#5289), which its first fence assigns.
const VERIFY_WORK_INIT = 'INIT=$(gsd_run query init.verify-work "${PHASE_ARG}" ${GSD_WS:+--ws=${GSD_WS##* }})';
const SRC_CROSS_FENCE = {
  'gsd-core/workflows/verify-work.md :: verify:pre': VERIFY_WORK_INIT,
  'gsd-core/workflows/verify-work.md :: verify:post': VERIFY_WORK_INIT,
};

const WS_EXPANSION = '${GSD_WS:+--ws=${GSD_WS##* }}';
// Value level: the expansion must yield the bare workstream name (last word of GSD_WS) or nothing.
test('[unit] WS_EXPANSION expands GSD_WS to --ws=<name>, and to nothing when unset', () => {
  const sh = (env) => runHook('-c', [`printf '%s' ${WS_EXPANSION}`], { interpreter: 'bash', env, timeoutMs: PROBE_TIMEOUT_MS }).stdout;
  assert.strictEqual(sh({ GSD_WS: '--ws b' }), '--ws=b');
  assert.strictEqual(sh({ GSD_WS: 'a b' }), '--ws=b');
  assert.strictEqual(sh({}), '');
});
// Turn the tail of a render-hooks call line into argv, substituting a real
// token for the phase variable and the fingerprint path.
function callArgv(rest, tok = '05') {
  return (rest
    .replace(WS_EXPANSION, '') // unset GSD_WS expands to nothing
    .replace(/--after-fingerprint\s+"[^"]*"/, '--after-fingerprint .planning/phases/05-widgets')
    .replace(/"\$\{?\w+\}?"/g, `"${tok}"`)
    .match(/"[^"]*"|\S+/g) || []).map((a) => a.replace(/"/g, ''));
}

describe('phaseVarBinding (static assignment check)', () => {
  const call = 'X=$(gsd_run loop render-hooks plan:pre --raw --phase "${P}")';
  const lines = (...l) => l.join('\n').split('\n');
  test('accepts an assignment in a bash fence before the call', () => {
    const l = lines('```bash', 'P=$(echo 05)', call, '```');
    assert.deepStrictEqual(phaseVarBinding(l, 2, 'P'), { line: 1, sameFence: true });
  });
  test('rejects a call with no assignment anywhere', () => {
    assert.strictEqual(phaseVarBinding(lines('```bash', call, '```'), 1, 'P').line, -1);
  });
  test('rejects an assignment that comes after the call', () => {
    assert.strictEqual(phaseVarBinding(lines('```bash', call, 'P=05', '```'), 1, 'P').line, -1);
  });
  test('rejects an assignment outside a bash fence', () => {
    assert.strictEqual(phaseVarBinding(lines('P=05', '```bash', call, '```'), 2, 'P').line, -1);
  });
  test('rejects an agent-filled placeholder as the only assignment', () => {
    assert.strictEqual(phaseVarBinding(lines('```bash', 'P="{phase_number}"', call, '```'), 2, 'P').line, -1);
  });
  test('reports an assignment in an earlier fence as cross-fence', () => {
    assert.deepStrictEqual(phaseVarBinding(lines('```bash', 'P=05', '```', 'prose', '```bash', call, '```'), 5, 'P'),
      { line: 1, sameFence: false });
  });
  test('a real workflow with its phase assignments stripped fails the check', () => {
    const real = splitLines(fs.readFileSync(path.join(ROOT, 'gsd-core/workflows/validate-phase.md'), 'utf8'));
    const idx = real.findIndex((l) => l.includes('render-hooks verify:post') && !l.includes('--active-cap'));
    assert.notStrictEqual(phaseVarBinding(real, idx, 'PHASE_NUMBER').line, -1, 'the real workflow assigns PHASE_NUMBER');
    const stripped = real.filter((l) => !/^\s*PHASE_NUMBER=/.test(l));
    const sidx = stripped.findIndex((l) => l.includes('render-hooks verify:post') && !l.includes('--active-cap'));
    assert.strictEqual(phaseVarBinding(stripped, sidx, 'PHASE_NUMBER').line, -1);
  });
});

describe('cmdLoopRenderHooks --phase (#4030)', () => {
  function makePhaseProject(...phaseDirNames) {
    const dir = createTempProject('loop-phase-ctx-');
    for (const name of phaseDirNames) {
      fs.mkdirSync(path.join(dir, '.planning', 'phases', name), { recursive: true });
    }
    return dir;
  }

  function renderWithPhase(projectDir, point, extraArgs = []) {
    return runNode(
      [GSD_TOOLS, 'loop', 'render-hooks', point, '--cwd', projectDir, ...extraArgs],
      { cwd: ROOT, timeoutMs: PROBE_TIMEOUT_MS },
    );
  }

  test('[happy] --phase matching exactly one directory adds context:{phase,phaseDir}', (t) => {
    const dir = makePhaseProject('05-widgets');
    t.after(() => cleanup(dir));
    const result = renderWithPhase(dir, 'plan:pre', ['--phase', '05', '--raw']);
    assert.strictEqual(result.exitCode, 0, 'stderr: ' + result.stderr);
    const envelope = JSON.parse(result.stdout.trim());
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
    const envelope = JSON.parse(renderWithPhase(dir, 'plan:pre', ['--phase', '05', '--ws=alpha', '--raw']).stdout.trim());
    assert.deepStrictEqual(envelope.context, { phase: '05', phaseDir: '.planning/workstreams/alpha/phases/05-alpha' });
    const root = JSON.parse(renderWithPhase(dir, 'plan:pre', ['--phase', '05', '--raw']).stdout.trim());
    assert.strictEqual(root.context.phaseDir, '.planning/phases/05-root');
  });

  test('[bva] --phase omitted preserves the exact legacy envelope shape — no context key at all', (t) => {
    const dir = makePhaseProject('05-widgets');
    t.after(() => cleanup(dir));
    const result = renderWithPhase(dir, 'plan:pre', ['--raw']);
    assert.strictEqual(result.exitCode, 0, 'stderr: ' + result.stderr);
    const envelope = JSON.parse(result.stdout.trim());
    assert.ok(!Object.prototype.hasOwnProperty.call(envelope, 'context'),
      'omitting --phase must not add a context key');
  });

  test('[negative] --phase with no matching directory omits context and appends a warning, still exits 0', (t) => {
    const dir = makePhaseProject('05-widgets');
    t.after(() => cleanup(dir));
    const result = renderWithPhase(dir, 'plan:pre', ['--phase', '99', '--raw']);
    assert.strictEqual(result.exitCode, 0, 'stderr: ' + result.stderr);
    const envelope = JSON.parse(result.stdout.trim());
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
    const result = renderWithPhase(dir, 'plan:pre', ['--phase', '05', '--raw']);
    assert.strictEqual(result.exitCode, 0, 'stderr: ' + result.stderr);
    const envelope = JSON.parse(result.stdout.trim());
    assert.ok(!Object.prototype.hasOwnProperty.call(envelope, 'context'),
      'an archived-only match must not surface a .planning/milestones/ path as context.phaseDir');
    assert.ok(Array.isArray(envelope.warnings) && envelope.warnings.length > 0);
    assert.strictEqual(dropOf(dir, { phase: '05' }), PHASE_DROP.ARCHIVED);
  });

  test('[bva] --phase matching two directories (ambiguous) omits context with AMBIGUOUS drop and a warning, exits 0 not thrown', (t) => {
    const dir = makePhaseProject('05-widgets', '05-gadgets');
    t.after(() => cleanup(dir));
    const result = renderWithPhase(dir, 'plan:pre', ['--phase', '05', '--raw']);
    assert.strictEqual(result.exitCode, 0, 'stderr: ' + result.stderr);
    const envelope = JSON.parse(result.stdout.trim());
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
    const result = renderWithPhase(dir, 'plan:pre', ['--phase', '--raw']);
    assert.strictEqual(result.exitCode, 0, 'stderr: ' + result.stderr);
    const envelope = JSON.parse(result.stdout.trim());
    assert.ok(!Object.prototype.hasOwnProperty.call(envelope, 'context'));
    assert.ok(!Object.prototype.hasOwnProperty.call(envelope, 'warnings'),
      'a bare --phase must be silent, exactly like omitting the flag entirely');
  });

  test('[negative] --phase "" (explicit empty string, space form) warns, never a hard error', (t) => {
    // readOptionalFlag distinguishes "explicit empty value" (--phase "") from
    // "flag never given" (bare --phase) — only the latter stays silent. An
    // explicit empty string reaches the resolver as '', which guardedFindPhase
    // treats as any other unresolvable token: a warning, never a hard error and
    // never a dropped envelope. This is the CLI path all real call sites use —
    // an unset `${PHASE_NUMBER}` in a workflow must be diagnosable, not silent.
    const dir = makePhaseProject('05-widgets');
    t.after(() => cleanup(dir));
    const result = renderWithPhase(dir, 'plan:pre', ['--phase', '', '--raw']);
    assert.strictEqual(result.exitCode, 0, 'stderr: ' + result.stderr);
    const envelope = JSON.parse(result.stdout.trim());
    assert.ok(!Object.prototype.hasOwnProperty.call(envelope, 'context'));
    assert.ok(Array.isArray(envelope.warnings) && envelope.warnings.length > 0,
      'an explicit empty --phase must warn, not go silent');
    assert.strictEqual(dropOf(dir, { phase: '' }), PHASE_DROP.INVALID_TOKEN);
  });

  test('[negative] --phase= (explicit empty string, equals form) warns, never a hard error', (t) => {
    const dir = makePhaseProject('05-widgets');
    t.after(() => cleanup(dir));
    const result = renderWithPhase(dir, 'plan:pre', ['--phase=', '--raw']);
    assert.strictEqual(result.exitCode, 0, 'stderr: ' + result.stderr);
    const envelope = JSON.parse(result.stdout.trim());
    assert.ok(!Object.prototype.hasOwnProperty.call(envelope, 'context'));
    assert.ok(Array.isArray(envelope.warnings) && envelope.warnings.length > 0,
      'an explicit empty --phase= must warn, not go silent');
  });

  test('[negative] resolveActiveHooksForPoint called in-process with phase: \'\' warns the same way', (t) => {
    // This exported function is its own boundary (an in-process caller does not
    // go through readOptionalFlag) and must not silently swallow an explicit empty string the way
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

  // Parser quirk, pinned so a later "cleanup" cannot change it silently: the `=`
  // form wins over the space form regardless of position. Both forms trim.
  test('[bva] --phase= equals-form takes precedence over a space-form occurrence, whatever the order', (t) => {
    const dir = makePhaseProject('05-widgets', '07-gadgets');
    t.after(() => cleanup(dir));
    for (const argv of [
      ['--phase', '07', '--phase=05', '--raw'],
      ['--phase=05', '--phase', '07', '--raw'],
    ]) {
      const result = renderWithPhase(dir, 'plan:pre', argv);
      assert.strictEqual(result.exitCode, 0, 'stderr: ' + result.stderr);
      assert.strictEqual(JSON.parse(result.stdout.trim()).context.phase, '05',
        `the = form must win for ${argv.join(' ')}`);
    }
  });

  test('[bva] both forms trim a padded token', (t) => {
    const dir = makePhaseProject('05-widgets');
    t.after(() => cleanup(dir));
    const trimmed = renderWithPhase(dir, 'plan:pre', ['--phase=  05  ', '--raw']);
    assert.strictEqual(trimmed.exitCode, 0, 'stderr: ' + trimmed.stderr);
    assert.strictEqual(JSON.parse(trimmed.stdout.trim()).context.phase, '05',
      'the = form trims, so a padded token still resolves');

    const spaced = renderWithPhase(dir, 'plan:pre', ['--phase', '  05  ', '--raw']);
    assert.strictEqual(spaced.exitCode, 0, 'stderr: ' + spaced.stderr);
    assert.strictEqual(JSON.parse(spaced.stdout.trim()).context.phase, '05',
      'the space form trims too, so both forms agree on a padded token');
  });

  test('[bva] --phase=05 equals-form parses identically to the space-separated form', (t) => {
    const dir = makePhaseProject('05-widgets');
    t.after(() => cleanup(dir));
    const result = renderWithPhase(dir, 'plan:pre', ['--phase=05', '--raw']);
    assert.strictEqual(result.exitCode, 0, 'stderr: ' + result.stderr);
    const envelope = JSON.parse(result.stdout.trim());
    assert.deepStrictEqual(envelope.context, { phase: '05', phaseDir: '.planning/phases/05-widgets' });
  });

  test('[happy] --after-fingerprint with --phase keeps context in the envelope', (t) => {
    const dir = makePhaseProject('05-widgets');
    t.after(() => cleanup(dir));
    const result = renderWithPhase(dir, 'verify:post',
      ['--after-fingerprint', path.join(dir, '.planning', 'phases', '05-widgets'), '--phase', '05', '--raw']);
    assert.strictEqual(result.exitCode, 0, 'stderr: ' + result.stderr);
    assert.deepStrictEqual(JSON.parse(result.stdout.trim()).context,
      { phase: '05', phaseDir: '.planning/phases/05-widgets' });
  });

  test('[happy] --phase composes with --active-cap without interference', (t) => {
    const dir = makePhaseProject('02-alpha');
    t.after(() => cleanup(dir));
    const result = renderWithPhase(dir, 'plan:pre', ['--phase', '02', '--active-cap', 'tdd']);
    assert.strictEqual(result.exitCode, 0, 'stderr: ' + result.stderr);
    assert.strictEqual(typeof JSON.parse(result.stdout.trim()), 'boolean');
  });

  test('[hostile] a foreign-project-code-prefixed --phase token does not reopen #2237 — guardedFindPhase rejects it same as init.*', (t) => {
    const dir = makePhaseProject('05-widgets');
    fs.writeFileSync(path.join(dir, '.planning', 'config.json'), JSON.stringify({ project_code: 'MINE' }));
    t.after(() => cleanup(dir));
    const result = renderWithPhase(dir, 'plan:pre', ['--phase', 'OTHER-05', '--raw']);
    assert.strictEqual(result.exitCode, 0, 'stderr: ' + result.stderr);
    const envelope = JSON.parse(result.stdout.trim());
    assert.ok(!Object.prototype.hasOwnProperty.call(envelope, 'context'),
      'a foreign-prefixed token must not silently resolve to this project\'s same-numbered phase directory');
    assert.ok((envelope.warnings || []).length > 0);
    assert.strictEqual(dropOf(dir, { phase: 'OTHER-05' }), PHASE_DROP.UNRESOLVED);
  });

  // #4030 acceptance criterion: the workflow-supplied phase must reach the
  // dispatch envelope unchanged at EVERY phase-scoped point, not just the two
  // sampled above — a point wired in the resolver but broken at the CLI seam
  // would otherwise ship silently.
  for (const point of [
    'discuss:pre', 'discuss:post',
    'plan:pre', 'plan:post',
    'execute:wave:pre', 'execute:wave:post', 'execute:post',
    'verify:pre', 'verify:post',
  ]) {
    test(`[happy] ${point} carries --phase through to context unchanged`, (t) => {
      const dir = makePhaseProject('05-widgets');
      t.after(() => cleanup(dir));
      const result = renderWithPhase(dir, point, ['--phase', '05', '--raw']);
      assert.strictEqual(result.exitCode, 0, 'stderr: ' + result.stderr);
      const envelope = JSON.parse(result.stdout.trim());
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
    const result = renderWithPhase(dir, 'plan:pre', ['--phase', '07.5', '--raw']);
    assert.strictEqual(result.exitCode, 0, 'stderr: ' + result.stderr);
    assert.deepStrictEqual(
      JSON.parse(result.stdout.trim()).context,
      { phase: '07.5', phaseDir: '.planning/phases/07.5-tuning' },
    );
  });

  // #4030 condition 1: the four hostile shapes the triage comment named, asserted
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
      const result = renderWithPhase(dir, 'plan:pre', ['--phase', token, '--raw']);
      assert.strictEqual(result.exitCode, 0, 'stderr: ' + result.stderr);
      const envelope = JSON.parse(result.stdout.trim());
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
    const { phaseDir } = JSON.parse(result.stdout.trim()).context;
    assert.strictEqual(phaseDir, '.planning/phases/05-widgets');
    assert.ok(!path.isAbsolute(phaseDir), 'phaseDir must never be absolute');
    assert.ok(!phaseDir.includes('..'), 'phaseDir must never contain a parent-dir segment');
  });

  // Skipped on Windows: creating a DIRECTORY symlink needs elevation or
  // Developer Mode there, so setup would throw EPERM before the assertion runs.
  // Same guard the sibling symlink tests use (tests/capability-consent.test.cjs).
  test('[negative] a symlinked phase directory is not resolved into context', {
    skip: process.platform === 'win32' ? 'directory symlinks require elevation on Windows' : false,
  }, (t) => {
    const dir = makePhaseProject('05-widgets');
    const outside = createTempDir('loop-phase-outside-');
    t.after(() => { cleanup(dir); cleanup(outside); });
    fs.mkdirSync(path.join(outside, '99-evil'), { recursive: true });
    fs.symlinkSync(path.join(outside, '99-evil'), path.join(dir, '.planning', 'phases', '99-evil'), 'dir');
    const result = renderWithPhase(dir, 'plan:pre', ['--phase', '99', '--raw']);
    assert.strictEqual(result.exitCode, 0, 'stderr: ' + result.stderr);
    const envelope = JSON.parse(result.stdout.trim());
    assert.ok(!Object.prototype.hasOwnProperty.call(envelope, 'context'),
      'a symlinked phase dir must not become a resolved phaseDir');
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

    const project = makePhaseProject('05-widgets');
    return { home, project };
  }

  const PHASE_SCOPED_POINTS = [
    'discuss:pre', 'discuss:post',
    'plan:pre', 'plan:post',
    'execute:wave:pre', 'execute:wave:post', 'execute:post',
    'verify:pre', 'verify:post',
  ];

  for (const point of PHASE_SCOPED_POINTS) {
    test(`[happy] ${point}: a third-party step hook and the caller's phase arrive in one envelope`, (t) => {
      const fx = makeThirdPartyStepFixture(PHASE_SCOPED_POINTS);
      t.after(() => { cleanup(fx.home); cleanup(fx.project); });

      const result = runNode(
        [GSD_TOOLS, 'loop', 'render-hooks', point, '--cwd', fx.project, '--raw', '--phase', '05'],
        { cwd: ROOT, timeoutMs: PROBE_TIMEOUT_MS, env: { ...process.env, GSD_HOME: fx.home } },
      );
      assert.strictEqual(result.exitCode, 0, 'stderr: ' + result.stderr);
      const envelope = JSON.parse(result.stdout.trim());

      const probe = (envelope.activeHooks || []).find((h) => h.capId === 'phase-probe');
      assert.ok(probe, `the third-party step must be dispatched at ${point}; got ${JSON.stringify(envelope.activeHooks)}`);
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

    const result = runNode(
      [GSD_TOOLS, 'loop', 'render-hooks', 'plan:pre', '--cwd', fx.project, '--raw'],
      { cwd: ROOT, timeoutMs: PROBE_TIMEOUT_MS, env: { ...process.env, GSD_HOME: fx.home } },
    );
    assert.strictEqual(result.exitCode, 0, 'stderr: ' + result.stderr);
    const envelope = JSON.parse(result.stdout.trim());
    assert.ok((envelope.activeHooks || []).some((h) => h.capId === 'phase-probe'),
      'the third-party step still dispatches without --phase');
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

    const result = runNode(
      [GSD_TOOLS, 'loop', 'render-hooks', 'plan:pre', '--cwd', fx.project, '--raw', '--phase', '02'],
      { cwd: ROOT, timeoutMs: PROBE_TIMEOUT_MS, env: { ...process.env, GSD_HOME: fx.home } },
    );
    assert.strictEqual(result.exitCode, 0, 'stderr: ' + result.stderr);
    const envelope = JSON.parse(result.stdout.trim());
    assert.ok((envelope.activeHooks || []).some((h) => h.capId === 'phase-probe'), 'the third-party step must dispatch');
    assert.deepStrictEqual(envelope.context, { phase: '02', phaseDir: '.planning/phases/02-beta' });
    assert.deepStrictEqual(fs.readFileSync(statePath), before, 'STATE.md must stay byte-identical');
  });

  // The two-line positional-token normalizer must sit verbatim at both sites that have no INIT in their fence.
  test('[phase binding] ARGS_BIND appears verbatim at execute-phase and verify-phase-goal', () => {
    for (const file of ['gsd-core/workflows/execute-phase.md', 'gsd-core/workflows/execute-phase/steps/verify-phase-goal.md']) {
      const lines = splitLines(fs.readFileSync(path.join(ROOT, file), 'utf8')).map((l) => l.trim());
      const at = lines.indexOf(ARGS_BIND[0]);
      assert.notStrictEqual(at, -1, `${file} lost ARGS_BIND`);
      assert.strictEqual(lines[at + 1], ARGS_BIND[1], `${file}: ARGS_BIND line 2 changed`);
    }
  });

  test('[e2e] every CROSS_FENCE key still names a SITES row', () => {
    const rows = new Set(SITES.map(([f, p]) => `${f} :: ${p}`));
    assert.deepStrictEqual(Object.keys(CROSS_FENCE).filter((k) => !rows.has(k)), []);
    assert.deepStrictEqual(Object.keys(SRC_CROSS_FENCE).filter((k) => !rows.has(k)), []);
  });

  // #4030 AC4: run each real call site's own arguments (not a hand-written
  // --phase), so a site with a wrong flag or variable fails here. The phase
  // variable must be bound in the call's own fence, or in an earlier one the
  // site is listed for in CROSS_FENCE; only then is it replaced by a real token.
  // Run a site's own PHASE_NUMBER bind line in a fresh bash (the carry: each fence is its own shell)
  // with only what its fence supplies, and return the value it yields.
  function boundPhase(fx, file, bindLine) {
    const args = /execute-phase/.test(file) ? '02 --wave 2 --auto' : '02';
    const initQuery = file.endsWith('verify-work.md') ? VERIFY_WORK_INIT
      : `INIT=$(gsd_run query ${file.endsWith('plan-phase.md') ? 'init.plan-phase' : 'init.phase-op'} 02)`;
    const script = [
      `gsd_run() { node "${GSD_TOOLS}" "$@"; }`,
      `GSD_ARGS='${args}'`, 'PHASE_ARG=02', 'GSD_WS=""',
      bindLine.includes('$INIT') ? initQuery : ':',
      bindLine.includes('${1}') ? ARGS_BIND.join('\n') : ':',
      bindLine,
      'printf %s "$PHASE_NUMBER"',
    ].join('\n');
    const r = runHook('-c', [script], { interpreter: 'bash', cwd: fx.project, env: { ...process.env, GSD_HOME: fx.home }, timeoutMs: PROBE_TIMEOUT_MS });
    assert.strictEqual(r.exitCode, 0, `${file}: bind failed: ${r.stderr}`);
    return r.stdout;
  }

  for (const [file, point] of SITES) {
    test(`[e2e] ${file} :: ${point} call site binds its phase var and its argv puts the phase in the envelope beside a third-party step`, (t) => {
      const fx = makeThirdPartyStepFixture(PHASE_SCOPED_POINTS);
      t.after(() => { cleanup(fx.home); cleanup(fx.project); });
      for (const n of ['01-alpha', '02-beta']) fs.mkdirSync(path.join(fx.project, '.planning', 'phases', n));
      const statePath = path.join(fx.project, '.planning', 'STATE.md');
      fs.writeFileSync(statePath, 'current_phase: 01\n');
      const stateBefore = fs.readFileSync(statePath);
      const dispatchMd = fs.readFileSync(path.join(ROOT, 'gsd-core/references/loop-hook-dispatch.md'), 'utf8');
      const lines = splitLines(fs.readFileSync(path.join(ROOT, file), 'utf8'));
      const carried = CROSS_FENCE[`${file} :: ${point}`];
      const srcCarried = SRC_CROSS_FENCE[`${file} :: ${point}`];
      let seen = 0;
      let tok = '02'; // a host-bound site (HOST_BOUND) takes the loop variable's value
      let crossed = 0;
      let srcCrossed = 0;
      // True when `name` is assigned in an earlier fence than lines[idx]; that
      // must be pinned (exact line) in `table`. Never assigned in the file: false
      // (host-provided).
      const checkCarry = (table, tableName, idx, name, at) => {
        const bind = phaseVarBinding(lines, idx, name);
        if (bind.line === -1 || bind.sameFence) return false;
        assert.ok(table !== undefined, `${file}:${at + 1} ${point}: ${name} is bound in another fence (line ${bind.line + 1}); list the site in ${tableName}`);
        assert.ok([].concat(table).includes(lines[bind.line].trim()), `${file}:${at + 1} ${point}: the ${name} binding this site relies on changed (now: ${lines[bind.line].trim()})`);
        return true;
      };
      lines.forEach((line, idx) => {
        const m = !line.includes('--active-cap') && line.match(callRe(point));
        if (!m) return;
        seen++;
        const v = m[1].match(/--phase\s+"\$\{?(\w+)\}?"/);
        assert.ok(v, `${file}:${idx + 1} ${point}: --phase must take a quoted variable`);
        assert.ok(m[1].includes(WS_EXPANSION), `${file}:${idx + 1} ${point}: --phase call lost the ${WS_EXPANSION} expansion (wrong-workstream phase)`);
        // Each fence is its own shell: GSD_WS must be derived in the call's own fence,
        // else --ws drops and another workstream's phase resolves.
        assert.ok(phaseVarBinding(lines, idx, 'GSD_WS').sameFence, `${file}:${idx + 1} ${point}: GSD_WS is not derived in this call's own fence`);
        if (path.posix.dirname(file) !== 'gsd-core/workflows') {
          assert.ok(fenceOf(lines, idx).some((l) => l.trim() === READ_LOADED_NOTE),
            `${file}:${idx + 1} ${point}: a Read-loaded file's fence must carry the #4772 note for its $ARGUMENTS capture`);
        }
        assert.ok(!assignedLaterInFence(lines, idx, 'GSD_WS'),
          `${file}:${idx + 1} ${point}: ${WS_EXPANSION} reads GSD_WS before this fence assigns it`);
        const b = phaseVarBinding(lines, idx, v[1]);
        if (HOST_BOUND.has(`${file} :: ${point}`)) {
          assert.strictEqual(v[1], HOST_PHASE_VAR, `${file}:${idx + 1} ${point}: a host-bound site must pass ${HOST_PHASE_VAR}`);
          assert.strictEqual(b.line, -1, `${file}:${idx + 1} ${point}: ${v[1]} is shell-assigned now; drop the site from HOST_BOUND`);
        } else {
          assert.notStrictEqual(b.line, -1,
            `${file}:${idx + 1} ${point}: ${v[1]} is never assigned in a bash block before this call`);
          tok = boundPhase(fx, file, lines[b.line].trim());
          if (checkCarry(carried, 'CROSS_FENCE', idx, v[1], idx)) crossed++;
          // The phase binding also reads source variables ($INIT, $PHASE_STATE,
          // ${EXECUTE_INIT:-$INIT}, ...): each one assigned in another fence is
          // pinned in SRC_CROSS_FENCE.
          const readVars = new Set([...lines[b.line].matchAll(/\$\{?(\w+)/g)].map((r) => r[1]));
          readVars.delete(v[1]);
          for (const readVar of readVars) if (checkCarry(srcCarried, 'SRC_CROSS_FENCE', b.line, readVar, idx)) srcCrossed++;
        }
        const result = runNode(
          [GSD_TOOLS, 'loop', 'render-hooks', point, ...callArgv(m[1], tok), '--cwd', fx.project],
          { cwd: ROOT, timeoutMs: PROBE_TIMEOUT_MS, env: { ...process.env, GSD_HOME: fx.home } },
        );
        assert.strictEqual(result.exitCode, 0, 'stderr: ' + result.stderr);
        const envelope = JSON.parse(result.stdout.trim());
        const hook = (envelope.activeHooks || []).find((h) => h.capId === 'phase-probe');
        assert.ok(hook, `${file} ${point}: the third-party handler must be dispatched`);
        assert.strictEqual(tok, '02', `${file}:${idx + 1} ${point}: the bind must yield the call's own phase, not STATE.current_phase`);
        assert.deepStrictEqual(envelope.context, { phase: '02', phaseDir: '.planning/phases/02-beta' },
          `${file} ${point}: the call site's phase must reach the handler unchanged`);
        assert.deepStrictEqual(runHandler(dispatchMd, envelope, hook, tok), ['phase', 'probe', '--phase', '02', '--raw'],
          `${file} ${point}: the handler must receive the call site's phase`);
        assert.deepStrictEqual(fs.readFileSync(statePath), stateBefore, 'STATE.md must stay byte-identical');
      });
      assert.ok(seen > 0, `no ${point} call site in ${file}`);
      for (const [table, n, name] of [[carried, crossed, 'CROSS_FENCE'], [srcCarried, srcCrossed, 'SRC_CROSS_FENCE']]) {
        assert.ok(table === undefined || n > 0, `${file} ${point}: nothing crosses a fence now; drop it from ${name}`);
      }
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
    const tokenRe = new RegExp(`^${dispatchMd.match(TOKEN_CHECK_RE)[1]}$`);
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
      const r = runHook('-c', [`gsd_run() { printf '%s\\n' "$@" > "$REC"; }\n${filled}`], { interpreter: 'bash', env: { ...process.env, REC: rec }, timeoutMs: PROBE_TIMEOUT_MS });
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
    const { copyWithPathReplacement } = require('../bin/install.js');
    if (prev === undefined) delete process.env.GSD_TEST_MODE; else process.env.GSD_TEST_MODE = prev;
    const fx = makeThirdPartyStepFixture(PHASE_SCOPED_POINTS);
    t.after(() => { cleanup(fx.home); cleanup(fx.project); });
    const env = { ...process.env, GSD_HOME: fx.home };
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
      for (const [file, point, expectedCount] of SITES) {
        const projected = fs.readFileSync(path.join(dest, file.replace(/^gsd-core\//, '')), 'utf8');
        const { bare, withPhase } = phaseSiteCounts(projected, point);
        assert.strictEqual(bare.length, expectedCount, `${runtime}: ${file} ${point} call site count changed`);
        assert.strictEqual(withPhase.length, expectedCount, `${runtime}: ${file} ${point} lost --phase`);
        for (const m of bare) {
          const result = runNode(
            [GSD_TOOLS, 'loop', 'render-hooks', point, ...callArgv(m[1]), '--cwd', fx.project],
            { cwd: ROOT, timeoutMs: PROBE_TIMEOUT_MS, env },
          );
          assert.strictEqual(result.exitCode, 0, `${runtime}: ${file} ${point} stderr: ` + result.stderr);
          const envelope = JSON.parse(result.stdout.trim());
          const hook = (envelope.activeHooks || []).find((h) => h.capId === 'phase-probe');
          assert.ok(hook, `${runtime}: ${file} ${point}: the third-party step must be dispatched`);
          assert.deepStrictEqual(runHandler(dispatchMd, envelope, hook, undefined), ['phase', 'probe', '--phase', '05', '--raw'],
            `${runtime}: ${file} ${point}: the handler must receive the call site's phase`);
        }
      }
      // With no context, the contract falls back to the host's PHASE_NUMBER,
      // else passes no phase flag at all — never an empty token.
      const bareEnv = JSON.parse(runNode(
        [GSD_TOOLS, 'loop', 'render-hooks', 'plan:pre', '--raw', '--cwd', fx.project],
        { cwd: ROOT, timeoutMs: PROBE_TIMEOUT_MS, env },
      ).stdout.trim());
      const hook = bareEnv.activeHooks.find((h) => h.capId === 'phase-probe');
      assert.deepStrictEqual(runHandler(dispatchMd, bareEnv, hook, '07'), ['phase', 'probe', '--phase', '07', '--raw']);
      assert.deepStrictEqual(runHandler(dispatchMd, bareEnv, hook, undefined), ['phase', 'probe', '--raw']);
      // An unrelated warning (capability load failure) does not mean --phase was rejected: the fallback stays.
      assert.deepStrictEqual(runHandler(dispatchMd, { ...bareEnv, warnings: ['capability x failed to load'] }, hook, '07'), ['phase', 'probe', '--phase', '07', '--raw']);
      // --phase was passed but rejected (warning): the host's PHASE_NUMBER must not
      // stand in for it, or the rejected token's phase reaches the handler anyway.
      const rejectedEnv = JSON.parse(runNode(
        [GSD_TOOLS, 'loop', 'render-hooks', 'plan:pre', '--raw', '--phase', '99', '--cwd', fx.project],
        { cwd: ROOT, timeoutMs: PROBE_TIMEOUT_MS, env },
      ).stdout.trim());
      assert.ok(rejectedEnv.warnings && rejectedEnv.warnings.length, 'an unmatched --phase warns');
      assert.strictEqual(rejectedEnv.phaseDrop, 'UNRESOLVED');
      // UNRESOLVED means no phase directory yet (ROADMAP-only phases): the host's own PHASE_NUMBER stands in.
      assert.deepStrictEqual(runHandler(dispatchMd, rejectedEnv, hook, '07'), ['phase', 'probe', '--phase', '07', '--raw']);
      // Every other drop passes no phase.
      const unsafeEnv = JSON.parse(runNode(
        [GSD_TOOLS, 'loop', 'render-hooks', 'plan:pre', '--raw', '--phase', 'a;id', '--cwd', fx.project],
        { cwd: ROOT, timeoutMs: PROBE_TIMEOUT_MS, env },
      ).stdout.trim());
      assert.strictEqual(unsafeEnv.phaseDrop, 'INVALID_TOKEN');
      assert.deepStrictEqual(runHandler(dispatchMd, unsafeEnv, hook, '07'), ['phase', 'probe', '--raw']);
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
      },
    ));
  });

  test('[property] every spelling of the real phase yields context with the real directory', (t) => {
    const dir = makePhaseProject('05-widgets');
    t.after(() => cleanup(dir));
    fc.assert(fc.property(fc.constantFrom('05', '5', '005', '05-widgets'), (phase) => {
      const { context } = resolveActiveHooksForPoint(dir, 'plan:pre', { phase });
      assert.ok(context, `${phase} must resolve`);
      assert.strictEqual(context.phaseDir, '.planning/phases/05-widgets');
      assert.strictEqual(typeof context.phase, 'string');
    }));
  });

  // readOptionalFlag is private to gsd-tools.cjs, so it is exercised through
  // the CLI (few runs: each is a subprocess).
  test('[property] --phase parses in = and space form, trims, and rejects a --value', (t) => {
    const dir = makePhaseProject('05-widgets');
    t.after(() => cleanup(dir));
    const pad = fc.stringMatching(/^[ \t]{0,3}$/);
    fc.assert(fc.property(fc.boolean(), pad, pad, fc.stringMatching(/^[a-zA-Z0-9._=-]{0,8}$/).filter((j) => !/^phase=/.test(j)), (eq, l, r, junk) => {
      const padded = `${l}05${r}`;
      const ok = renderWithPhase(dir, 'plan:pre', eq ? [`--phase=${padded}`, '--raw'] : ['--phase', padded, '--raw']);
      assert.strictEqual(ok.exitCode, 0, ok.stderr);
      assert.strictEqual(JSON.parse(ok.stdout.trim()).context.phase, '05');
      const bad = renderWithPhase(dir, 'plan:pre', ['--phase', `--${junk}`, '--raw']);
      assert.strictEqual(bad.exitCode, 0, bad.stderr);
      const env = JSON.parse(bad.stdout.trim());
      assert.ok(!('context' in env) && !('warnings' in env), 'a --value is not a phase token');
    }), { numRuns: 12 });
  });

  // #4030: --phase-dir is accepted, but only as a check against what --phase
  // resolved to. It is never an independent path, so nothing here needs
  // confinement — the emitted phaseDir is always locator-produced.
  test('[happy] --phase-dir agreeing with the resolved directory yields context', (t) => {
    const dir = makePhaseProject('05-widgets');
    t.after(() => cleanup(dir));
    const result = renderWithPhase(dir, 'plan:pre', ['--phase', '05', '--phase-dir', '.planning/phases/05-widgets', '--raw']);
    assert.strictEqual(result.exitCode, 0, 'stderr: ' + result.stderr);
    assert.deepStrictEqual(
      JSON.parse(result.stdout.trim()).context,
      { phase: '05', phaseDir: '.planning/phases/05-widgets' },
    );
  });

  test('[negative] an incoherent --phase / --phase-dir pair is rejected, though both are in-project', (t) => {
    const dir = makePhaseProject('05-widgets', '07-other');
    t.after(() => cleanup(dir));
    const result = renderWithPhase(dir, 'plan:pre', ['--phase', '05', '--phase-dir', '.planning/phases/07-other', '--raw']);
    assert.strictEqual(result.exitCode, 0, 'stderr: ' + result.stderr);
    const envelope = JSON.parse(result.stdout.trim());
    assert.ok(!Object.prototype.hasOwnProperty.call(envelope, 'context'),
      'a directory naming a different phase than the token must not produce context');
    assert.ok((envelope.warnings || []).length > 0);
    assert.strictEqual(dropOf(dir, { phase: '05', phaseDir: '.planning/phases/07-other' }), PHASE_DROP.DIR_MISMATCH);
  });

  test('[negative] an incoherent pair is still rejected when the filesystem reports ino 0 (FAT32/exFAT/SMB)', (t) => {
    const dir = makePhaseProject('05-widgets', '07-other');
    t.after(() => cleanup(dir));
    const realStat = fs.statSync;
    fs.statSync = (p, ...rest) => {
      const st = realStat(p, ...rest);
      return st && st.isDirectory() ? Object.assign(Object.create(Object.getPrototypeOf(st)), st, { ino: rest[0] && rest[0].bigint ? 0n : 0 }) : st;
    };
    t.after(() => { fs.statSync = realStat; });
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
      const result = renderWithPhase(dir, 'plan:pre', ['--phase', '05', '--phase-dir', outside, '--raw']);
      assert.strictEqual(result.exitCode, 0, 'stderr: ' + result.stderr);
      const envelope = JSON.parse(result.stdout.trim());
      assert.ok(!Object.prototype.hasOwnProperty.call(envelope, 'context'),
        `${outside} must never produce context`);
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
      const result = renderWithPhase(dir, 'plan:pre', ['--phase', '05', '--phase-dir', spelling, '--raw']);
      assert.strictEqual(result.exitCode, 0, 'stderr: ' + result.stderr);
      assert.deepStrictEqual(
        JSON.parse(result.stdout.trim()).context,
        { phase: '05', phaseDir: '.planning/phases/05-widgets' },
        `${spelling} names the resolved directory, so it must match and emit the locator's form`,
      );
    }
  });

  test('[negative] --phase-dir without --phase is refused rather than trusted', (t) => {
    const dir = makePhaseProject('05-widgets');
    t.after(() => cleanup(dir));
    const result = renderWithPhase(dir, 'plan:pre', ['--phase-dir', '.planning/phases/05-widgets', '--raw']);
    assert.strictEqual(result.exitCode, 0, 'stderr: ' + result.stderr);
    const envelope = JSON.parse(result.stdout.trim());
    assert.ok(!Object.prototype.hasOwnProperty.call(envelope, 'context'),
      'a lone --phase-dir must never become the context source');
    assert.ok((envelope.warnings || []).length > 0);
    assert.strictEqual(dropOf(dir, { phaseDir: '.planning/phases/05-widgets' }), PHASE_DROP.PHASE_DIR_ALONE);
  });

  test('[negative] bare --phase-dir with no value degrades like an omitted flag, never a hard error', (t) => {
    const dir = makePhaseProject('05-widgets');
    t.after(() => cleanup(dir));
    const result = renderWithPhase(dir, 'plan:pre', ['--phase', '05', '--phase-dir', '--raw']);
    assert.strictEqual(result.exitCode, 0, 'stderr: ' + result.stderr);
    const envelope = JSON.parse(result.stdout.trim());
    // --phase alone still resolves — a bare trailing --phase-dir just contributes nothing.
    assert.deepStrictEqual(envelope.context, { phase: '05', phaseDir: '.planning/phases/05-widgets' });
  });

  test('[bva] an ambiguous token yields no context even when --phase-dir names a candidate', (t) => {
    const dir = makePhaseProject('05-widgets', '05-gadgets');
    t.after(() => cleanup(dir));
    const result = renderWithPhase(dir, 'plan:pre', ['--phase', '05', '--phase-dir', '.planning/phases/05-gadgets', '--raw']);
    assert.strictEqual(result.exitCode, 0, 'stderr: ' + result.stderr);
    const envelope = JSON.parse(result.stdout.trim());
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
    assert.strictEqual(JSON.parse(result.stdout.trim()).context.phase, '02',
      'the emitted phase is the caller\'s token, not STATE.current_phase (01)');
    assert.deepStrictEqual(fs.readFileSync(statePath), before, 'STATE.md must stay byte-identical');
  });

  const DISPATCH_MD = fs.readFileSync(path.join(ROOT, 'gsd-core/references/loop-hook-dispatch.md'), 'utf8');
  const envelopeOf = (fx, point, args) => JSON.parse(runNode(
    [GSD_TOOLS, 'loop', 'render-hooks', point, '--cwd', fx.project, '--raw', ...args],
    { cwd: ROOT, timeoutMs: PROBE_TIMEOUT_MS, env: { ...process.env, GSD_HOME: fx.home } },
  ).stdout.trim());

  test('[phaseDrop] dispatch table codes equal PHASE_DROP', () => {
    const rows = dispatchTable(DISPATCH_MD);
    // sorted with duplicates kept: every code appears in exactly one row, hence maps to exactly one argument
    assert.deepStrictEqual(rows.flatMap((x) => x.codes).sort(), Object.keys(PHASE_DROP).sort());
  });

  test('[phaseDrop] envelope carries phaseDrop for a dropped token', (t) => {
    const dir = makePhaseProject('01-alpha', '02-beta');
    t.after(() => cleanup(dir));
    const env = (args) => JSON.parse(renderWithPhase(dir, 'plan:pre', [...args, '--raw']).stdout.trim());
    assert.strictEqual(env(['--phase', '99']).phaseDrop, 'UNRESOLVED');
    assert.strictEqual(env(['--phase', '02', '--phase-dir', '.planning/phases/01-alpha']).phaseDrop, 'DIR_MISMATCH');
    assert.ok(!Object.prototype.hasOwnProperty.call(env(['--phase', '02']), 'phaseDrop'), 'a resolved token carries no phaseDrop');
  });

  test('[phaseDrop] ROADMAP-only phase reaches the discuss:pre handler', (t) => {
    const fx = makeThirdPartyStepFixture(PHASE_SCOPED_POINTS);
    t.after(() => { cleanup(fx.home); cleanup(fx.project); });
    fs.writeFileSync(path.join(fx.project, '.planning', 'ROADMAP.md'), '# Roadmap\n\n## Phase 3: Gadgets\n');
    const envelope = envelopeOf(fx, 'discuss:pre', ['--phase', '03']);
    assert.strictEqual(envelope.context, undefined);
    const hook = envelope.activeHooks.find((h) => h.capId === 'phase-probe');
    assert.deepStrictEqual(runHandler(DISPATCH_MD, envelope, hook, '03'), ['phase', 'probe', '--phase', '03', '--raw']);
  });

  test('[phase token] dispatch contract regex equals PHASE_TOKEN_RE.source', () => {
    const m = DISPATCH_MD.match(TOKEN_CHECK_RE);
    assert.ok(m, 'dispatch contract lost its in-context phase-token check');
    assert.strictEqual(`^${m[1]}$`, PHASE_TOKEN_RE.source);
  });

  test('[phase token] hostile custom id never reaches context', (t) => {
    const lib = (n) => path.join(ROOT, 'gsd-core/bin/lib', n);
    const loc = require(lib('phase-locator.cjs'));
    const orig = loc.guardedFindPhase;
    const calls = [];
    // loop-resolver destructures guardedFindPhase at load: wrap it, then reload the resolver so it binds the wrapper.
    loc.guardedFindPhase = (...a) => { calls.push(a[1]); return orig(...a); };
    delete require.cache[require.resolve(lib('loop-resolver.cjs'))];
    const fresh = require(lib('loop-resolver.cjs'));
    t.after(() => { loc.guardedFindPhase = orig; delete require.cache[require.resolve(lib('loop-resolver.cjs'))]; });
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
      const cli = JSON.parse(renderWithPhase(dir, 'plan:pre', ['--phase', id, '--raw']).stdout.trim());
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
      const env = JSON.parse(renderWithPhase(dir, 'plan:pre', ['--phase', '02', '--raw']).stdout.trim());
      assert.strictEqual(env.context, undefined);
      assert.strictEqual(env.phaseDrop, 'CONFIG_FAULT');
      assert.ok(env.warnings.some((w) => w.includes(reason)), `a warning names ${reason}`);
    }
  });

  test('[phaseDrop] ambiguous warning caps the count at 5', (t) => {
    const echoedMore = (n) => {
      const dir = makePhaseProject(...Array.from({ length: n }, (_, i) => `05-${String.fromCharCode(97 + i)}`));
      t.after(() => cleanup(dir));
      const env = JSON.parse(renderWithPhase(dir, 'plan:pre', ['--phase', '05', '--raw']).stdout.trim());
      const w = env.warnings.find((x) => x.includes('is ambiguous'));
      return { listed: [...w.matchAll(/"(05-[a-z])"/g)].length - 0, more: (w.match(/, … (\d+) more\)/) || [])[1] };
    };
    assert.deepStrictEqual(echoedMore(5), { listed: 5, more: undefined });
    assert.deepStrictEqual(echoedMore(6), { listed: 5, more: '1' });
    assert.deepStrictEqual(echoedMore(7), { listed: 5, more: '2' });
  });
});

// #4030: every phase-scoped call site must carry --phase, not just dispatch
// the point; dropping it from one would silently lose the context there.
// Table-driven, so a new site means one new SITES row, not a new test.
describe('every phase-scoped render-hooks call site actually carries --phase', () => {
  for (const [file, point, expectedCount] of SITES) {
    test(`${file} :: ${point} carries --phase at all ${expectedCount} call site(s)`, () => {
      const content = fs.readFileSync(path.join(ROOT, file), 'utf8');
      const { bare, withPhase } = phaseSiteCounts(content, point);
      assert.strictEqual(bare.length, expectedCount,
        `expected ${expectedCount} render-hooks ${point} call site(s) in ${file}, found ${bare.length} — update this table's count if the site count genuinely changed`);
      assert.strictEqual(withPhase.length, expectedCount,
        `expected all ${expectedCount} render-hooks ${point} call site(s) in ${file} to carry --phase, only ${withPhase.length} did`);
    });
  }

  // A binding that a later binding in the same file overwrites before anything reads it is a
  // dead store and a wasted init query. The last binding is exempt: a Read-loaded step may consume it.
  test('no PHASE_NUMBER binding in a SITES file is overwritten before it is read', () => {
    const assign = /^\s*(?:export\s+|local\s+)?PHASE_NUMBER=/;
    const read = /\$\{?PHASE_NUMBER\b/;
    const dead = [];
    for (const file of new Set(SITES.map(([f]) => f))) {
      const lines = splitLines(fs.readFileSync(path.join(ROOT, file), 'utf8'));
      const binds = lines.flatMap((l, i) => (assign.test(l) ? [i] : []));
      binds.slice(0, -1).forEach((i, k) => {
        const next = binds[k + 1];
        const between = lines.slice(i + 1, next).concat(lines[next].replace(assign, ''));
        if (!between.some((l) => read.test(l))) dead.push(`${file}:${i + 1}`);
      });
    }
    assert.deepStrictEqual(dead, []);
  });
});

// #4030: confinement by realpath, same-directory by dev+ino, boundary rows.
describe('cmdLoopRenderHooks --phase confinement and --phase-dir identity (#4030)', () => {
  const symlinkSkip = process.platform === 'win32' ? 'directory symlinks require elevation on Windows' : false;
  const mk = (t, ...names) => {
    const dir = createTempProject('loop-phase-conf-');
    t.after(() => cleanup(dir));
    for (const n of names) fs.mkdirSync(path.join(dir, '.planning', 'phases', n), { recursive: true });
    return dir;
  };
  const run = (dir, args) => {
    const r = runNode([GSD_TOOLS, 'loop', 'render-hooks', 'plan:pre', '--cwd', dir, ...args, '--raw'],
      { cwd: ROOT, timeoutMs: PROBE_TIMEOUT_MS });
    assert.strictEqual(r.exitCode, 0, 'stderr: ' + r.stderr);
    return JSON.parse(r.stdout.trim());
  };

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

  test('[hostile] a symlinked .planning yields no context and a warning', { skip: symlinkSkip }, (t) => {
    const dir = createTempDir('loop-phase-conf-');
    const outside = createTempDir('loop-phase-outside-');
    t.after(() => { cleanup(dir); cleanup(outside); });
    fs.mkdirSync(path.join(outside, 'phases', '07-evil'), { recursive: true });
    fs.symlinkSync(outside, path.join(dir, '.planning'), 'dir');
    const env = run(dir, ['--phase', '07']);
    assert.ok(!Object.prototype.hasOwnProperty.call(env, 'context'));
    assert.ok((env.warnings || []).length > 0);
    assert.strictEqual(dropOf(dir, { phase: '07' }), PHASE_DROP.ESCAPES_ROOT);
  });

  // Every echoed value in a warning is a JSON string capped at 80 characters
  // with no control characters. Decode the envelope and each quoted value, and
  // assert on length and code points, never on prose or raw stdout bytes.
  const runText = (dir, args) => {
    const r = runNode([GSD_TOOLS, 'loop', 'render-hooks', 'plan:pre', '--cwd', dir, ...args, '--raw'],
      { cwd: ROOT, timeoutMs: PROBE_TIMEOUT_MS });
    assert.strictEqual(r.exitCode, 0, 'stderr: ' + r.stderr);
    return r.stdout;
  };
  const echoed = (out) => JSON.parse(out.trim()).warnings.flatMap(
    (w) => [...w.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`)));
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
      try { dir = project(t, name); } catch { t.skip('FS refuses control characters'); return; }
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
    try { dir = ambiguousProject(t, '05-a\u001b[31m\nb'); } catch { t.skip('FS refuses control characters'); return; }
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
