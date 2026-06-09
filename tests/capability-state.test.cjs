'use strict';

/**
 * capability-state.test.cjs — behavioral tests for capability-state.cjs.
 *
 * ADR-857 phase 4b.
 * Uses node:test + node:assert/strict.
 * Pure-function tests (resolveCapabilityState) pass registry+Sets+config
 * directly — no I/O. End-to-end tests use cmdCapabilityState + temp dirs.
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { cleanup } = require('./helpers.cjs');

const {
  resolveCapabilityState,
  _isSafePropKey,
} = require('../gsd-core/bin/lib/capability-state.cjs');

// The real capability registry
const realRegistry = require('../gsd-core/bin/lib/capability-registry.cjs');

// ─── Synthetic registry fixture ───────────────────────────────────────────────

/**
 * Build a minimal synthetic registry for a single capability with the given
 * skills, steps, gates, contributions, and configSchema entries.
 */
function makeRegistry({
  id = 'test-cap',
  tier = 'standard',
  skills = [],
  steps = [],
  gates = [],
  contributions = [],
  configSchema = {},
} = {}) {
  return {
    capabilities: {
      [id]: {
        id,
        tier,
        skills,
        steps,
        gates,
        contributions,
        config: {},
      },
    },
    configSchema,
  };
}

// ─── Temp project helpers ─────────────────────────────────────────────────────

let tmpProjectDir;
let tmpProjectDirFalse;

before(() => {
  // Project with UI flags enabled
  tmpProjectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-state-test-'));
  const planningDir = path.join(tmpProjectDir, '.planning');
  fs.mkdirSync(planningDir, { recursive: true });
  fs.writeFileSync(
    path.join(planningDir, 'config.json'),
    JSON.stringify({
      workflow: {
        ui_phase: true,
        ui_review: true,
        ui_safety_gate: true,
      },
    }),
    'utf8',
  );

  // Project with all UI flags disabled
  tmpProjectDirFalse = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-state-false-'));
  fs.mkdirSync(path.join(tmpProjectDirFalse, '.planning'), { recursive: true });
  fs.writeFileSync(
    path.join(path.join(tmpProjectDirFalse, '.planning'), 'config.json'),
    JSON.stringify({
      workflow: {
        ui_phase: false,
        ui_review: false,
        ui_safety_gate: false,
      },
    }),
    'utf8',
  );
});

after(() => {
  cleanup(tmpProjectDir);
  cleanup(tmpProjectDirFalse);
});

// ─── _isSafePropKey helper ────────────────────────────────────────────────────

describe('_isSafePropKey', () => {
  test('allows normal keys', () => {
    assert.strictEqual(_isSafePropKey('ui'), true);
    assert.strictEqual(_isSafePropKey('my-cap'), true);
    assert.strictEqual(_isSafePropKey('cap123'), true);
  });

  test('blocks __proto__', () => {
    assert.strictEqual(_isSafePropKey('__proto__'), false);
  });

  test('blocks constructor', () => {
    assert.strictEqual(_isSafePropKey('constructor'), false);
  });

  test('blocks prototype', () => {
    assert.strictEqual(_isSafePropKey('prototype'), false);
  });

  test('blocks non-string', () => {
    assert.strictEqual(_isSafePropKey(null), false);
    assert.strictEqual(_isSafePropKey(42), false);
    assert.strictEqual(_isSafePropKey(undefined), false);
  });
});

// ─── resolveCapabilityState — basic shapes ────────────────────────────────────

describe('resolveCapabilityState — basic shapes', () => {
  test('empty registry → {capabilities:[]}', () => {
    const result = resolveCapabilityState({
      registry: { capabilities: {} },
      installedSkills: new Set(),
      surfacedSkills: new Set(),
      config: {},
    });
    assert.deepStrictEqual(result, { capabilities: [] });
  });

  test('missing capabilities key → {capabilities:[]}', () => {
    const result = resolveCapabilityState({
      registry: {},
      installedSkills: new Set(),
      surfacedSkills: new Set(),
      config: {},
    });
    assert.deepStrictEqual(result, { capabilities: [] });
  });

  test('null registry → {capabilities:[]}', () => {
    const result = resolveCapabilityState({
      registry: null,
      installedSkills: new Set(),
      surfacedSkills: new Set(),
      config: {},
    });
    assert.deepStrictEqual(result, { capabilities: [] });
  });

  test('array registry → {capabilities:[]}', () => {
    const result = resolveCapabilityState({
      registry: [],
      installedSkills: new Set(),
      surfacedSkills: new Set(),
      config: {},
    });
    assert.deepStrictEqual(result, { capabilities: [] });
  });

  test('malformed capabilities entry is skipped gracefully', () => {
    const result = resolveCapabilityState({
      registry: { capabilities: { 'bad-cap': 'not-an-object' } },
      installedSkills: new Set(),
      surfacedSkills: new Set(),
      config: {},
    });
    assert.deepStrictEqual(result, { capabilities: [] });
  });
});

// ─── resolveCapabilityState — installed dimension ────────────────────────────

describe('resolveCapabilityState — installed dimension', () => {
  test('installedSkills="*" → installed=true for all caps', () => {
    const registry = makeRegistry({ skills: ['ui-phase', 'ui-review'] });
    const result = resolveCapabilityState({
      registry,
      installedSkills: '*',
      surfacedSkills: new Set(),
      config: {},
    });
    assert.strictEqual(result.capabilities.length, 1);
    assert.strictEqual(result.capabilities[0].installed, true);
  });

  test('all skills in installedSkills → installed=true', () => {
    const registry = makeRegistry({ skills: ['ui-phase', 'ui-review'] });
    const result = resolveCapabilityState({
      registry,
      installedSkills: new Set(['ui-phase', 'ui-review']),
      surfacedSkills: new Set(),
      config: {},
    });
    assert.strictEqual(result.capabilities[0].installed, true);
  });

  test('one skill missing from installedSkills → installed=false', () => {
    const registry = makeRegistry({ skills: ['ui-phase', 'ui-review'] });
    const result = resolveCapabilityState({
      registry,
      installedSkills: new Set(['ui-phase']), // missing ui-review
      surfacedSkills: new Set(),
      config: {},
    });
    assert.strictEqual(result.capabilities[0].installed, false);
  });

  test('empty skills array → installed=true vacuously', () => {
    // A capability with zero skills has no skills to be absent, so it is
    // vacuously installed and surfaced regardless of the installed/surfaced sets.
    // This is intentional: capabilities that gate purely on config (no skills
    // required) should report installed=true/surfaced=true when no skills are
    // needed. Activation state is still governed by hook `when` keys.
    const registry = makeRegistry({ skills: [] });
    const result = resolveCapabilityState({
      registry,
      installedSkills: new Set(), // nothing installed — vacuous true still applies
      surfacedSkills: new Set(),
      config: {},
    });
    assert.strictEqual(result.capabilities[0].installed, true);
    assert.strictEqual(result.capabilities[0].surfaced, true);
  });
});

// ─── resolveCapabilityState — surfaced dimension ──────────────────────────────

describe('resolveCapabilityState — surfaced dimension', () => {
  test('all skills in surfacedSkills → surfaced=true', () => {
    const registry = makeRegistry({ skills: ['ui-phase', 'ui-review'] });
    const result = resolveCapabilityState({
      registry,
      installedSkills: '*',
      surfacedSkills: new Set(['ui-phase', 'ui-review']),
      config: {},
    });
    assert.strictEqual(result.capabilities[0].surfaced, true);
  });

  test('one skill missing from surfacedSkills → surfaced=false', () => {
    const registry = makeRegistry({ skills: ['ui-phase', 'ui-review'] });
    const result = resolveCapabilityState({
      registry,
      installedSkills: '*',
      surfacedSkills: new Set(['ui-phase']), // missing ui-review
      config: {},
    });
    assert.strictEqual(result.capabilities[0].surfaced, false);
  });

  test('empty skills array → surfaced=true vacuously', () => {
    const registry = makeRegistry({ skills: [] });
    const result = resolveCapabilityState({
      registry,
      installedSkills: '*',
      surfacedSkills: new Set(), // nothing surfaced
      config: {},
    });
    assert.strictEqual(result.capabilities[0].surfaced, true);
  });
});

// ─── resolveCapabilityState — UI capability (real registry) ──────────────────

describe('resolveCapabilityState — UI capability with real registry', () => {
  test('UI cap: installed=true when ui-phase + ui-review in installedSkills', () => {
    const result = resolveCapabilityState({
      registry: realRegistry,
      installedSkills: new Set(['ui-phase', 'ui-review']),
      surfacedSkills: new Set(['ui-phase', 'ui-review']),
      config: { workflow: { ui_phase: true, ui_review: true, ui_safety_gate: true } },
      cwd: tmpProjectDir,
    });
    const uiCap = result.capabilities.find((c) => c.id === 'ui');
    assert.ok(uiCap, 'ui capability should be present');
    assert.strictEqual(uiCap.installed, true);
    assert.strictEqual(uiCap.surfaced, true);
  });

  test('UI cap: installed=false when ui-review missing from installedSkills', () => {
    const result = resolveCapabilityState({
      registry: realRegistry,
      installedSkills: new Set(['ui-phase']), // missing ui-review
      surfacedSkills: new Set(['ui-phase', 'ui-review']),
      config: { workflow: { ui_phase: true, ui_review: true, ui_safety_gate: true } },
      cwd: tmpProjectDir,
    });
    const uiCap = result.capabilities.find((c) => c.id === 'ui');
    assert.ok(uiCap);
    assert.strictEqual(uiCap.installed, false);
  });

  test('UI cap: surfaced=false when ui-review missing from surfacedSkills', () => {
    const result = resolveCapabilityState({
      registry: realRegistry,
      installedSkills: new Set(['ui-phase', 'ui-review']),
      surfacedSkills: new Set(['ui-phase']), // missing ui-review
      config: { workflow: { ui_phase: true, ui_review: true, ui_safety_gate: true } },
      cwd: tmpProjectDir,
    });
    const uiCap = result.capabilities.find((c) => c.id === 'ui');
    assert.ok(uiCap);
    assert.strictEqual(uiCap.surfaced, false);
  });

  test('UI cap step hook: workflow.ui_phase true → active=true', () => {
    const result = resolveCapabilityState({
      registry: realRegistry,
      installedSkills: '*',
      surfacedSkills: new Set(),
      config: { workflow: { ui_phase: true, ui_review: true, ui_safety_gate: true } },
      cwd: tmpProjectDir,
    });
    const uiCap = result.capabilities.find((c) => c.id === 'ui');
    assert.ok(uiCap);
    // Find the plan:pre step (ui-phase step)
    const planPreStep = uiCap.hooks.find(
      (h) => h.kind === 'step' && h.when === 'workflow.ui_phase',
    );
    assert.ok(planPreStep, 'should have plan:pre step with when=workflow.ui_phase');
    assert.strictEqual(planPreStep.active, true);
  });

  test('UI cap step hook: workflow.ui_phase false → active=false', () => {
    const result = resolveCapabilityState({
      registry: realRegistry,
      installedSkills: '*',
      surfacedSkills: new Set(),
      config: { workflow: { ui_phase: false, ui_review: false, ui_safety_gate: false } },
      cwd: tmpProjectDirFalse,
    });
    const uiCap = result.capabilities.find((c) => c.id === 'ui');
    assert.ok(uiCap);
    const planPreStep = uiCap.hooks.find(
      (h) => h.kind === 'step' && h.when === 'workflow.ui_phase',
    );
    assert.ok(planPreStep, 'should have plan:pre step with when=workflow.ui_phase');
    assert.strictEqual(planPreStep.active, false);
  });

  test('UI cap gate hook: workflow.ui_safety_gate true → active=true', () => {
    const result = resolveCapabilityState({
      registry: realRegistry,
      installedSkills: '*',
      surfacedSkills: new Set(),
      config: { workflow: { ui_phase: true, ui_review: true, ui_safety_gate: true } },
      cwd: tmpProjectDir,
    });
    const uiCap = result.capabilities.find((c) => c.id === 'ui');
    assert.ok(uiCap);
    const safetyGate = uiCap.hooks.find(
      (h) => h.kind === 'gate' && h.when === 'workflow.ui_safety_gate',
    );
    assert.ok(safetyGate, 'should have gate with when=workflow.ui_safety_gate');
    assert.strictEqual(safetyGate.active, true);
  });

  test('UI cap gate hook: workflow.ui_safety_gate false → active=false', () => {
    const result = resolveCapabilityState({
      registry: realRegistry,
      installedSkills: '*',
      surfacedSkills: new Set(),
      config: { workflow: { ui_phase: false, ui_review: false, ui_safety_gate: false } },
      cwd: tmpProjectDirFalse,
    });
    const uiCap = result.capabilities.find((c) => c.id === 'ui');
    assert.ok(uiCap);
    const safetyGate = uiCap.hooks.find(
      (h) => h.kind === 'gate' && h.when === 'workflow.ui_safety_gate',
    );
    assert.ok(safetyGate, 'should have gate with when=workflow.ui_safety_gate');
    assert.strictEqual(safetyGate.active, false);
  });
});

// ─── resolveCapabilityState — hook activation ─────────────────────────────────

describe('resolveCapabilityState — hook activation details', () => {
  test('hook with no `when` → active=true (unconditional)', () => {
    const registry = makeRegistry({
      steps: [{ point: 'plan:pre', ref: { skill: 'test-skill' } }], // no `when`
    });
    const result = resolveCapabilityState({
      registry,
      installedSkills: '*',
      surfacedSkills: new Set(),
      config: {},
    });
    assert.strictEqual(result.capabilities.length, 1);
    const hook = result.capabilities[0].hooks.find((h) => h.kind === 'step');
    assert.ok(hook, 'step hook should be present');
    assert.strictEqual(hook.when, undefined);
    assert.strictEqual(hook.active, true);
  });

  test('hook with `when` resolving truthy → active=true', () => {
    const registry = makeRegistry({
      steps: [{ point: 'plan:pre', when: 'workflow.my_feature' }],
    });
    const result = resolveCapabilityState({
      registry,
      installedSkills: '*',
      surfacedSkills: new Set(),
      config: { workflow: { my_feature: true } },
    });
    const hook = result.capabilities[0].hooks.find((h) => h.kind === 'step');
    assert.ok(hook);
    assert.strictEqual(hook.active, true);
  });

  test('hook with `when` resolving falsy → active=false', () => {
    const registry = makeRegistry({
      steps: [{ point: 'plan:pre', when: 'workflow.my_feature' }],
    });
    const result = resolveCapabilityState({
      registry,
      installedSkills: '*',
      surfacedSkills: new Set(),
      config: { workflow: { my_feature: false } },
    });
    const hook = result.capabilities[0].hooks.find((h) => h.kind === 'step');
    assert.ok(hook);
    assert.strictEqual(hook.active, false);
  });

  test('mixed hooks: some active, some not', () => {
    const registry = makeRegistry({
      steps: [
        { point: 'plan:pre', when: 'workflow.feat_a' },
        { point: 'plan:post' }, // no when → unconditional
      ],
      gates: [{ point: 'execute:wave:post', when: 'workflow.feat_b' }],
      // contributions must be a real array (not an object) so hook enumeration works
      contributions: [
        { point: 'plan:pre', into: 'context', when: 'workflow.feat_c' },
      ],
    });
    const result = resolveCapabilityState({
      registry,
      installedSkills: '*',
      surfacedSkills: new Set(),
      config: { workflow: { feat_a: false, feat_b: true, feat_c: true } },
    });
    const cap = result.capabilities[0];
    // feat_a step: inactive
    const featAStep = cap.hooks.find((h) => h.when === 'workflow.feat_a');
    assert.ok(featAStep);
    assert.strictEqual(featAStep.active, false);
    // unconditional step: active
    const unconditional = cap.hooks.find((h) => h.kind === 'step' && !h.when);
    assert.ok(unconditional);
    assert.strictEqual(unconditional.active, true);
    // feat_b gate: active
    const featBGate = cap.hooks.find((h) => h.when === 'workflow.feat_b');
    assert.ok(featBGate);
    assert.strictEqual(featBGate.active, true);
    // feat_c contribution: active, enumerated correctly
    const featCContrib = cap.hooks.find((h) => h.kind === 'contribution' && h.when === 'workflow.feat_c');
    assert.ok(featCContrib, 'contribution hook should be enumerated from array');
    assert.strictEqual(featCContrib.active, true);
  });

  test('empty-string `when` → active=false (aligned with loop-resolver)', () => {
    // loop-resolver.isActive: `when.length === 0` → false
    // capability-state must behave identically
    const registry = makeRegistry({
      steps: [{ point: 'plan:pre', when: '' }],
    });
    const result = resolveCapabilityState({
      registry,
      installedSkills: '*',
      surfacedSkills: new Set(),
      config: {},
    });
    const hook = result.capabilities[0].hooks.find((h) => h.kind === 'step');
    assert.ok(hook, 'step hook should be present');
    assert.strictEqual(hook.when, '', 'original when value must be preserved');
    assert.strictEqual(hook.active, false, 'empty-string when → inactive');
  });

  test('non-string `when` → active=false (aligned with loop-resolver)', () => {
    // loop-resolver.isActive: `typeof when !== 'string'` → false
    const registry = makeRegistry({
      steps: [{ point: 'plan:pre', when: 42 }],
    });
    const result = resolveCapabilityState({
      registry,
      installedSkills: '*',
      surfacedSkills: new Set(),
      config: {},
    });
    const hook = result.capabilities[0].hooks.find((h) => h.kind === 'step');
    assert.ok(hook, 'step hook should be present');
    assert.strictEqual(hook.when, 42, 'original non-string when value must be preserved');
    assert.strictEqual(hook.active, false, 'non-string when → inactive');
  });
});

// ─── resolveCapabilityState — determinism ─────────────────────────────────────

describe('resolveCapabilityState — determinism', () => {
  test('sorted by id — two caps returned in lexicographic order', () => {
    // contributions must be an array (not an object) for the hook enumeration to work
    const registry = {
      capabilities: {
        'zzz-cap': { id: 'zzz-cap', tier: 'standard', skills: [], steps: [], gates: [], contributions: [] },
        'aaa-cap': { id: 'aaa-cap', tier: 'standard', skills: [], steps: [], gates: [], contributions: [] },
        'mmm-cap': { id: 'mmm-cap', tier: 'standard', skills: [], steps: [], gates: [], contributions: [] },
      },
    };
    const result = resolveCapabilityState({
      registry,
      installedSkills: '*',
      surfacedSkills: new Set(),
      config: {},
    });
    const ids = result.capabilities.map((c) => c.id);
    assert.deepStrictEqual(ids, ['aaa-cap', 'mmm-cap', 'zzz-cap']);
  });

  test('two calls with same inputs produce identical output', () => {
    const result1 = resolveCapabilityState({
      registry: realRegistry,
      installedSkills: new Set(['ui-phase', 'ui-review']),
      surfacedSkills: new Set(['ui-phase']),
      config: { workflow: { ui_phase: true, ui_review: false, ui_safety_gate: true } },
      cwd: tmpProjectDir,
    });
    const result2 = resolveCapabilityState({
      registry: realRegistry,
      installedSkills: new Set(['ui-phase', 'ui-review']),
      surfacedSkills: new Set(['ui-phase']),
      config: { workflow: { ui_phase: true, ui_review: false, ui_safety_gate: true } },
      cwd: tmpProjectDir,
    });
    assert.deepStrictEqual(result1, result2);
  });

  test('pure config-only resolution (cwd: undefined) — no I/O, deterministic', () => {
    // When cwd is omitted, resolveCapabilityState does no filesystem I/O.
    // Two calls with identical args must produce identical output regardless
    // of any .planning/config.json files that may exist on disk.
    const result1 = resolveCapabilityState({
      registry: realRegistry,
      installedSkills: new Set(['ui-phase', 'ui-review']),
      surfacedSkills: new Set(['ui-phase', 'ui-review']),
      config: { workflow: { ui_phase: true, ui_review: true, ui_safety_gate: false } },
      // no cwd
    });
    const result2 = resolveCapabilityState({
      registry: realRegistry,
      installedSkills: new Set(['ui-phase', 'ui-review']),
      surfacedSkills: new Set(['ui-phase', 'ui-review']),
      config: { workflow: { ui_phase: true, ui_review: true, ui_safety_gate: false } },
      // no cwd
    });
    assert.deepStrictEqual(result1, result2);
    // Activation should come from the `config` arg only, not from disk
    const uiCap = result1.capabilities.find((c) => c.id === 'ui');
    assert.ok(uiCap, 'ui capability should be present');
    const uiPhaseStep = uiCap.hooks.find(
      (h) => h.kind === 'step' && h.when === 'workflow.ui_phase',
    );
    if (uiPhaseStep) {
      assert.strictEqual(uiPhaseStep.active, true, 'should use config arg, not disk');
    }
  });
});

// ─── resolveCapabilityState — prototype pollution guard ──────────────────────

describe('resolveCapabilityState — prototype pollution guard', () => {
  test('prototype-pollution capId is skipped; Object.prototype unpolluted', () => {
    // Use Object.create(null) + Object.defineProperty to create a capabilities
    // map with a real OWN '__proto__' key (not the prototype chain).
    // The `{ __proto__: ... }` object literal syntax sets the prototype, not
    // an own property — so it cannot exercise the guard. Using defineProperty
    // ensures the key is an enumerable own property that Object.keys() returns.
    const capabilitiesMap = Object.create(null);
    Object.defineProperty(capabilitiesMap, '__proto__', {
      value: { id: '__proto__', tier: 'standard', skills: [], steps: [], gates: [], contributions: [] },
      enumerable: true,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(capabilitiesMap, 'safe-cap', {
      value: { id: 'safe-cap', tier: 'standard', skills: [], steps: [], gates: [], contributions: [] },
      enumerable: true,
      configurable: true,
      writable: true,
    });
    const registry = { capabilities: capabilitiesMap };
    const before = Object.prototype.toString.call({});
    const result = resolveCapabilityState({
      registry,
      installedSkills: '*',
      surfacedSkills: new Set(),
      config: {},
    });
    const after = Object.prototype.toString.call({});
    // Object.prototype must be unpolluted
    assert.strictEqual(before, after);
    // Verify no pollution occurred — a new plain object must not have a `polluted` property
    assert.strictEqual(({}).polluted, undefined);
    // Only the safe cap should appear
    assert.strictEqual(result.capabilities.length, 1);
    assert.strictEqual(result.capabilities[0].id, 'safe-cap');
  });
});

// ─── cmdCapabilityState — end-to-end via gsd-tools CLI ──────────────────────
//
// Because cmdCapabilityState destructures `output` at module load time, patching
// core.cjs after the fact is ineffective. We instead invoke gsd-tools via
// spawnSync so each test gets a fresh process with stdout captured.

const { spawnSync } = require('node:child_process');

const gsdToolsPath = path.resolve(__dirname, '..', 'gsd-core', 'bin', 'gsd-tools.cjs');

function runCapabilityState(cwd, configDir) {
  const result = spawnSync(
    process.execPath,
    [gsdToolsPath, 'capability', 'state', '--config-dir', configDir, '--raw', '--cwd', cwd],
    { encoding: 'utf8', timeout: 15000 },
  );
  return result;
}

describe('cmdCapabilityState — end-to-end via gsd-tools CLI', () => {
  let tmpConfigDir;
  let tmpConfigDirCore;

  before(() => {
    // Tmp runtime config dir without .gsd-profile (defaults to 'full')
    tmpConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-state-cfg-'));

    // Tmp runtime config dir with core profile marker
    tmpConfigDirCore = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-state-cfg-core-'));
    fs.writeFileSync(path.join(tmpConfigDirCore, '.gsd-profile'), 'core\n', 'utf8');
  });

  after(() => {
    cleanup(tmpConfigDir);
    cleanup(tmpConfigDirCore);
  });

  test('emits envelope with runtimeConfigDir and capabilities array', () => {
    const result = runCapabilityState(tmpProjectDir, tmpConfigDir);
    assert.strictEqual(result.status, 0, `gsd-tools exited ${result.status}: ${result.stderr}`);
    const envelope = JSON.parse(result.stdout);
    assert.ok(typeof envelope === 'object' && envelope !== null, 'envelope must be an object');
    assert.ok('runtimeConfigDir' in envelope, 'envelope must have runtimeConfigDir');
    assert.ok(Array.isArray(envelope.capabilities), 'envelope.capabilities must be an array');
    assert.ok(envelope.capabilities.length > 0, 'should have at least one capability');
  });

  test('with core profile marker: capabilities present (profile resolution does not throw)', () => {
    const result = runCapabilityState(tmpProjectDir, tmpConfigDirCore);
    assert.strictEqual(result.status, 0, `gsd-tools exited ${result.status}: ${result.stderr}`);
    const envelope = JSON.parse(result.stdout);
    assert.ok(Array.isArray(envelope.capabilities));
    // ui capability should appear; installed=false because core profile doesn't include ui-phase/ui-review
    const uiCap = envelope.capabilities.find((c) => c.id === 'ui');
    assert.ok(uiCap, 'ui capability should be present in output');
    assert.strictEqual(uiCap.installed, false, 'ui-phase/ui-review not in core profile');
  });

  test('runtimeConfigDir is echoed in the envelope', () => {
    const result = runCapabilityState(tmpProjectDir, tmpConfigDir);
    assert.strictEqual(result.status, 0, `gsd-tools exited ${result.status}: ${result.stderr}`);
    const envelope = JSON.parse(result.stdout);
    assert.strictEqual(envelope.runtimeConfigDir, tmpConfigDir);
  });
});
