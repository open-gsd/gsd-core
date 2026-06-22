'use strict';
// allow-test-rule: source-text-is-the-product see #1592
// The plan-phase.md host-dispatch assertions below read the workflow .md file — its text IS the
// deployed contract the runtime loads (CONTRIBUTING.md exemption category). The registry assertions
// are behavioral: they build the registry from the REAL capabilities/drift declaration via the
// generator, so they fail if the plan:pre gate is ever removed or mutated.

/**
 * Enhancement (#1592): plan-time codebase-map freshness pre-check.
 *
 * The `drift` capability gains a non-blocking `plan:pre` codebase-drift gate so a stale codebase map is
 * flagged BEFORE planning, instead of being discovered mid-execution by the existing
 * `execute:wave:post` codebase-drift gate. Warn-only at `plan:pre` (no mapper-agent spawn): the
 * capability's `drift_action: auto-remap` stays at `execute:wave:post`, so plan time never pays
 * speculative mapper-agent cost.
 *
 * Per maintainer review on #1592 (mod 1a), the plan:pre gate is gated on a DEDICATED
 * `workflow.plan_drift_precheck` toggle (default true) rather than reusing `workflow.schema_drift_gate`,
 * so autonomous/CI runs can silence the plan-time advisory without disabling the execute-time gates.
 * The gate declaration conforms to ADR-857 (`plan:pre` is an enumerated, additive-only loop point).
 *
 * Issue: #1592 (open-gsd/gsd-core).
 */

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadAndValidate, buildRegistry } = require('../scripts/gen-capability-registry.cjs');
const { cleanup } = require('./helpers.cjs');

const REPO_ROOT = path.join(__dirname, '..');
const DRIFT_CAP = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, 'capabilities', 'drift', 'capability.json'), 'utf8'),
);
const PLAN_PHASE = fs.readFileSync(
  path.join(REPO_ROOT, 'gsd-core', 'workflows', 'plan-phase.md'),
  'utf8',
);

// Track every temp dir created so the suite can remove them on teardown — leaked
// mkdtemp dirs have been a flake source here before (per #1592 review).
const tempCapDirs = [];

function makeTempCapDir(capabilities) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enh-1592-'));
  tempCapDirs.push(tmpDir);
  for (const [id, cap] of Object.entries(capabilities)) {
    const subDir = path.join(tmpDir, id);
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(path.join(subDir, 'capability.json'), JSON.stringify(cap), 'utf8');
  }
  return tmpDir;
}

after(() => {
  for (const dir of tempCapDirs) {
    cleanup(dir);
  }
});

function planPreDriftGate() {
  const capDir = makeTempCapDir({ drift: DRIFT_CAP });
  const { capMap, errors } = loadAndValidate(new Set(), capDir);
  assert.deepEqual(errors, [], 'drift capability should validate cleanly: ' + JSON.stringify(errors));
  const registry = buildRegistry(capMap);
  const planPreGates = registry.byLoopPoint['plan:pre'].gates;
  assert.ok(Array.isArray(planPreGates), 'plan:pre.gates should be an array');
  return planPreGates.find(
    (g) => g.capId === 'drift' && g.check && g.check.query === 'verify.codebase-drift',
  );
}

describe('#1592 — drift plan:pre codebase-drift gate (registry, behavioral)', () => {
  test('the real drift capability registers a non-blocking plan:pre codebase-drift gate', () => {
    const driftGate = planPreDriftGate();
    assert.ok(driftGate, 'plan:pre.gates must contain the drift codebase-drift gate');
    assert.strictEqual(driftGate.blocking, false, 'plan-time drift gate must be NON-blocking');
    assert.strictEqual(driftGate.onError, 'skip', 'must fail-soft (skip) — never halt planning');
  });

  test('the plan:pre gate is gated on the dedicated plan_drift_precheck toggle (mod 1a)', () => {
    const driftGate = planPreDriftGate();
    assert.strictEqual(
      driftGate.when,
      'workflow.plan_drift_precheck',
      'plan:pre drift gate must use the dedicated toggle so CI/autonomous runs can silence it ' +
        'without disabling the execute-time gates',
    );
  });

  test('the execute:wave:post codebase-drift gate is preserved and keeps its OWN toggle (no regression)', () => {
    const capDir = makeTempCapDir({ drift: DRIFT_CAP });
    const { capMap } = loadAndValidate(new Set(), capDir);
    const registry = buildRegistry(capMap);

    const execGates = registry.byLoopPoint['execute:wave:post'].gates;
    const stillThere = execGates.find(
      (g) => g.capId === 'drift' && g.check && g.check.query === 'verify.codebase-drift',
    );
    assert.ok(stillThere, 'execute:wave:post codebase-drift gate must remain after adding the plan:pre gate');
    assert.strictEqual(stillThere.blocking, false, 'execute codebase-drift gate stays non-blocking');
    assert.strictEqual(
      stillThere.when,
      'workflow.schema_drift_gate',
      'the execute-time gate keeps schema_drift_gate — the plan-time toggle is separable from it',
    );
  });

  test('plan_drift_precheck is a separate toggle from schema_drift_gate (silencing is independent)', () => {
    const planWhen = planPreDriftGate().when;
    assert.notStrictEqual(
      planWhen,
      'workflow.schema_drift_gate',
      'silencing the plan-time advisory must not require disabling the execute-time gates',
    );
  });

  test('plan_drift_precheck is declared as a boolean defaulting to true', () => {
    const cfg = DRIFT_CAP.config['workflow.plan_drift_precheck'];
    assert.ok(cfg, 'workflow.plan_drift_precheck must be declared in the drift capability config');
    assert.strictEqual(cfg.type, 'boolean', 'plan_drift_precheck must be a boolean');
    assert.strictEqual(cfg.default, true, 'plan_drift_precheck must default to true (on by default)');
  });

  test('exactly one new config key is introduced (the dedicated plan_drift_precheck toggle)', () => {
    const keys = Object.keys(DRIFT_CAP.config).sort();
    assert.deepStrictEqual(
      keys,
      [
        'workflow.drift_action',
        'workflow.drift_threshold',
        'workflow.plan_drift_precheck',
        'workflow.schema_drift_gate',
      ],
      'the plan:pre gate adds exactly the dedicated plan_drift_precheck toggle — no other new keys',
    );
  });
});

describe('#1592 — plan-phase host dispatches the drift plan:pre gate before planning', () => {
  const SECTION = PLAN_PHASE.slice(
    PLAN_PHASE.indexOf('5.65. Codebase Map Freshness Pre-Check'),
    PLAN_PHASE.indexOf('## 6. Check Existing Plans'),
  );

  test('§5.65 invokes the verify codebase-drift check', () => {
    assert.match(PLAN_PHASE, /5\.65\. Codebase Map Freshness Pre-Check/, 'plan-phase must declare §5.65');
    assert.match(PLAN_PHASE, /gsd_run verify codebase-drift/, '§5.65 must invoke `verify codebase-drift`');
  });

  test('the drift pre-check runs BEFORE the planner spawn (load-bearing ordering)', () => {
    const preCheckIdx = PLAN_PHASE.indexOf('5.65. Codebase Map Freshness Pre-Check');
    const plannerIdx = PLAN_PHASE.indexOf('## 8. Spawn gsd-planner Agent');
    assert.ok(preCheckIdx > 0, '§5.65 must exist');
    assert.ok(plannerIdx > 0, '§8 planner spawn must exist');
    assert.ok(
      preCheckIdx < plannerIdx,
      'the drift map-freshness pre-check must run before the planner is spawned — the whole point of #1592',
    );
  });

  test('§5.65 is documented as non-blocking and warn-only (no spawn)', () => {
    assert.match(SECTION, /non-blocking/i, '§5.65 must state the gate is non-blocking');
    assert.match(SECTION, /never blocks, never spawns/i, '§5.65 must state it never spawns the mapper at plan time');
  });

  test('§5.65 gates on the dedicated plan_drift_precheck toggle (mod 1a)', () => {
    assert.match(
      SECTION,
      /workflow\.plan_drift_precheck/,
      '§5.65 must dispatch on the dedicated plan_drift_precheck toggle, not schema_drift_gate',
    );
  });
});
