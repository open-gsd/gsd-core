// allow-test-rule: source-text-is-the-product see #1452
// The execute-phase.md workflow and context-budget.md reference ARE the runtime
// contract loaded by AI runtimes. Asserting that the canonical wording for
// `workflow.context_guard_mode` is present in those files is the only way to
// verify runtimes will respect the flag at runtime.

/**
 * Enhancement #1452: workflow.context_guard_mode
 *
 * Guards long execute-phase workflows from driving the host session to context
 * exhaustion (ctx 100%). Before each wave, the orchestrator self-assesses
 * context pressure using the degradation signals defined in context-budget.md.
 *
 * Modes:
 *   "warn"  (default) — emit a structured warning + recommend /gsd:pause-work
 *   "auto"            — auto-invoke pause-work before the next wave
 *   "off"             — disable the guard entirely
 *
 * The check fires at wave boundaries ONLY (before spawning), never mid-wave.
 */

'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

function readConfig(tmpDir) {
  const configPath = path.join(tmpDir, '.planning', 'config.json');
  return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
}

const REPO_ROOT = path.join(__dirname, '..');

// ─── Schema registration ──────────────────────────────────────────────────────

describe('workflow.context_guard_mode in VALID_CONFIG_KEYS', () => {
  test('is a recognized config key', () => {
    const { VALID_CONFIG_KEYS } = require('../gsd-core/bin/lib/config.cjs');
    assert.ok(
      VALID_CONFIG_KEYS.has('workflow.context_guard_mode'),
      'workflow.context_guard_mode should be in VALID_CONFIG_KEYS',
    );
  });
});

// ─── Default value ────────────────────────────────────────────────────────────

describe('workflow.context_guard_mode default value', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { cleanup(tmpDir); });

  test('defaults to warn in new project config', () => {
    const result = runGsdTools('config-ensure-section', tmpDir, { HOME: tmpDir });
    assert.ok(result.success, `config-ensure-section failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(
      config.workflow.context_guard_mode,
      'warn',
      'workflow.context_guard_mode should default to "warn" — proactive checkpoint warning without auto-pausing workflows',
    );
  });
});

// ─── Round-trip ──────────────────────────────────────────────────────────────

describe('workflow.context_guard_mode config round-trip', () => {
  let tmpDir;
  beforeEach(() => {
    tmpDir = createTempProject();
    runGsdTools('config-ensure-section', tmpDir, { HOME: tmpDir });
  });
  afterEach(() => { cleanup(tmpDir); });

  test('config-set warn persists to config.json', () => {
    const setResult = runGsdTools('config-set workflow.context_guard_mode warn', tmpDir);
    assert.ok(setResult.success, `config-set failed: ${setResult.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.workflow.context_guard_mode, 'warn');
  });

  test('config-set auto persists to config.json', () => {
    const setResult = runGsdTools('config-set workflow.context_guard_mode auto', tmpDir);
    assert.ok(setResult.success, `config-set failed: ${setResult.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.workflow.context_guard_mode, 'auto');
  });

  test('config-set off persists to config.json', () => {
    const setResult = runGsdTools('config-set workflow.context_guard_mode off', tmpDir);
    assert.ok(setResult.success, `config-set failed: ${setResult.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.workflow.context_guard_mode, 'off');
  });

  test('persists in config.json as string', () => {
    runGsdTools('config-set workflow.context_guard_mode warn', tmpDir);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.workflow.context_guard_mode, 'warn');
    assert.strictEqual(typeof config.workflow.context_guard_mode, 'string');
  });

  test('rejects unknown mode values with clear error', () => {
    const result = runGsdTools('config-set workflow.context_guard_mode aggressive', tmpDir);
    assert.strictEqual(result.success, false);
    assert.match(result.error, /Invalid workflow\.context_guard_mode 'aggressive'/);
    assert.match(result.error, /auto, warn, off/);
  });

  test('rejects partial match values', () => {
    const result = runGsdTools('config-set workflow.context_guard_mode warnmode', tmpDir);
    assert.strictEqual(result.success, false);
    assert.match(result.error, /Invalid workflow\.context_guard_mode 'warnmode'/);
  });
});

// ─── execute-phase contract ───────────────────────────────────────────────────

describe('execute-phase.md documents the context_guard step', () => {
  let executePhase;
  let contextGuardRef;

  beforeEach(() => {
    executePhase = fs.readFileSync(
      path.join(REPO_ROOT, 'gsd-core', 'workflows', 'execute-phase.md'),
      'utf-8',
    );
    // The step body is extracted to a reference file loaded via @-ref in execute-phase.md.
    // Both files together constitute the execute-phase wave-boundary contract.
    const refPath = path.join(REPO_ROOT, 'gsd-core', 'references', 'execute-phase-context-guard.md');
    contextGuardRef = fs.existsSync(refPath) ? fs.readFileSync(refPath, 'utf-8') : '';
  });

  test('references workflow.context_guard_mode by canonical name', () => {
    const combined = executePhase + '\n' + contextGuardRef;
    assert.ok(
      combined.includes('workflow.context_guard_mode'),
      'execute-phase.md (or its @-referenced execute-phase-context-guard.md) must reference workflow.context_guard_mode so runtimes resolve the config-driven behavior',
    );
  });

  test('defines context_guard step at wave boundaries', () => {
    assert.ok(
      executePhase.includes('context_guard') || executePhase.includes('context-guard'),
      'execute-phase.md must define a context_guard step (or @-ref to it) that fires before each wave',
    );
  });

  test('references context-budget.md tiers in the guard step', () => {
    const combined = executePhase + '\n' + contextGuardRef;
    assert.ok(
      combined.includes('context-budget') || combined.includes('POOR') || combined.includes('DEGRADING'),
      'execute-phase.md context_guard (or its @-referenced file) must reference context-budget.md degradation tiers',
    );
  });
});

// ─── context-budget.md contract ──────────────────────────────────────────────

describe('context-budget.md documents POOR-tier trigger action', () => {
  let contextBudget;

  beforeEach(() => {
    contextBudget = fs.readFileSync(
      path.join(REPO_ROOT, 'gsd-core', 'references', 'context-budget.md'),
      'utf-8',
    );
  });

  test('defines POOR tier', () => {
    assert.ok(
      contextBudget.includes('POOR'),
      'context-budget.md must define the POOR tier',
    );
  });

  test('connects POOR tier to pause-work', () => {
    assert.ok(
      contextBudget.includes('pause-work') || contextBudget.includes('pause_work'),
      'context-budget.md POOR-tier rule must reference pause-work as the trigger action',
    );
  });

  test('documents context_guard_mode values', () => {
    assert.ok(
      contextBudget.includes('context_guard_mode'),
      'context-budget.md must document the workflow.context_guard_mode config key',
    );
  });
});

// ─── planning-config.md reference parity ─────────────────────────────────────

describe('planning-config.md documents workflow.context_guard_mode', () => {
  test('includes the key in the reference table', () => {
    const planningConfig = fs.readFileSync(
      path.join(REPO_ROOT, 'gsd-core', 'references', 'planning-config.md'),
      'utf-8',
    );
    assert.ok(
      planningConfig.includes('workflow.context_guard_mode'),
      'planning-config.md reference must include workflow.context_guard_mode so users know the config knob exists',
    );
  });
});
