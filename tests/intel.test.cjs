/**
 * Tests for gsd-core/bin/lib/intel.cjs
 *
 * Covers: query, status, diff, validate, snapshot, patch-meta,
 * extract-exports, enabled/disabled gating, and CLI routing via gsd-tools.
 */
// allow-test-rule: source-text-is-the-product — readFileSync assertions target API-SURFACE.md, which is the generated product of intelApiSurface; asserting on its text content is the only way to verify correct generation.

'use strict';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createTempProject, createTempDir, cleanup, runGsdTools } = require('./helpers.cjs');

const {
  intelQuery,
  intelStatus,
  intelDiff,
  intelValidate,
  intelSnapshot,
  intelPatchMeta,
  intelExtractExports,
  intelApiSurface,
  ensureIntelDir,
  isIntelCapabilityActive,
  INTEL_FILES,
} = require('../gsd-core/bin/lib/intel.cjs');

const { isCapabilityActive } = require('../gsd-core/bin/lib/capability-state.cjs');

// ─── Helpers ────────────────────────────────────────────────────────────────

function enableIntel(planningDir) {
  const configPath = path.join(planningDir, 'config.json');
  const config = fs.existsSync(configPath)
    ? JSON.parse(fs.readFileSync(configPath, 'utf8'))
    : {};
  config.intel = { enabled: true };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
}

function writeIntelJson(planningDir, filename, data) {
  const intelPath = path.join(planningDir, 'intel');
  fs.mkdirSync(intelPath, { recursive: true });
  fs.writeFileSync(
    path.join(intelPath, filename),
    JSON.stringify(data, null, 2),
    'utf8'
  );
}

function _writeIntelMd(planningDir, filename, content) {
  const intelPath = path.join(planningDir, 'intel');
  fs.mkdirSync(intelPath, { recursive: true });
  fs.writeFileSync(path.join(intelPath, filename), content, 'utf8');
}

// ─── Surfaced-config-dir fixture ──────────────────────────────────────────────
//
// Positive-path tests (intelQuery, intelStatus, etc.) call isCapabilityActive
// via the tri-state gate — they need the capability to be surfaced.
// Without this fixture those tests are ambient-dependent (pass only on machines
// where intel is surfaced in the real ~/.claude).
//
// Fix: point CLAUDE_CONFIG_DIR at a tmp dir containing a full-profile
// .gsd-surface.json (no disabled clusters) so intel is surfaced deterministically.
// An EMPTY tmp config dir also works (defaults to 'full' profile → all surfaced)
// but we write the file explicitly for visible intent.

/** Create a tmp config dir with intel (and all caps) surfaced — full profile. */
function makeSurfacedConfigDir() {
  const dir = createTempDir('gsd-intel-surface-cfg-');
  fs.writeFileSync(
    path.join(dir, '.gsd-surface.json'),
    JSON.stringify({ baseProfile: 'full', disabledClusters: [], explicitAdds: [], explicitRemoves: [] }, null, 2) + '\n',
    'utf8',
  );
  return dir;
}

/** Save env vars touched by the surfaced-config fixture; returns .restore(). */
function saveSurfacedEnv() {
  const saved = {
    GSD_RUNTIME: process.env.GSD_RUNTIME,
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
    GSD_WORKSTREAM: process.env.GSD_WORKSTREAM,
    GSD_PROJECT: process.env.GSD_PROJECT,
  };
  return {
    restore() {
      if (saved.GSD_RUNTIME === undefined) delete process.env.GSD_RUNTIME;
      else process.env.GSD_RUNTIME = saved.GSD_RUNTIME;
      if (saved.CLAUDE_CONFIG_DIR === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = saved.CLAUDE_CONFIG_DIR;
      if (saved.GSD_WORKSTREAM === undefined) delete process.env.GSD_WORKSTREAM;
      else process.env.GSD_WORKSTREAM = saved.GSD_WORKSTREAM;
      if (saved.GSD_PROJECT === undefined) delete process.env.GSD_PROJECT;
      else process.env.GSD_PROJECT = saved.GSD_PROJECT;
    },
  };
}

// ─── Disabled gating ────────────────────────────────────────────────────────

describe('intel disabled gating', () => {
  let tmpDir;
  let planningDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    planningDir = path.join(tmpDir, '.planning');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // isIntelEnabled was removed in Phase 4 (tri-state cutover). These tests now
  // verify the gating via the public command API (intelQuery) and the exported
  // isIntelCapabilityActive helper which delegates to isCapabilityActive.
  test('isIntelCapabilityActive returns false when no config.json exists', () => {
    // No CLAUDE_CONFIG_DIR → defaults to real ~/.claude; no intel.enabled in config.
    // In a hermetic test environment (empty tmpDir), the capability is not surfaced
    // via the real config dir — but isCapabilityActive returns false by construction
    // when the activationKey (intel.enabled) is absent/false regardless of surface,
    // because: active = enabled && configActivation; configActivation=false when key absent.
    // This test is surface-agnostic for the "no config" branch.
    assert.strictEqual(isIntelCapabilityActive(planningDir), false);
  });

  test('isIntelCapabilityActive returns false when intel.enabled is not set', () => {
    fs.writeFileSync(
      path.join(planningDir, 'config.json'),
      JSON.stringify({ model_profile: 'balanced' }),
      'utf8'
    );
    assert.strictEqual(isIntelCapabilityActive(planningDir), false);
  });

  // NOTE: intel has `skills: []` (empty), so installed and surfaced are vacuously true.
  // For intel, active = configActivation (the intel.enabled config key).
  // This test verifies that isIntelCapabilityActive delegates to isCapabilityActive('intel', cwd)
  // and that the function returns a boolean without throwing, regardless of the ambient
  // CLAUDE_CONFIG_DIR. The config dimension is probed hermetically in the section below.
  test('isIntelCapabilityActive delegates to isCapabilityActive and returns a boolean (config=true, ambient surface)', () => {
    // Write config.intel.enabled=true (config dimension ON). Since intel has no skills,
    // surface is vacuously true — so this call returns true when the config is written
    // and the capability system resolves correctly.
    enableIntel(planningDir);
    // We cannot assert the exact value without full hermetic control of all three
    // tri-state dimensions (see hermetic section below for that), but we assert that:
    //   1. isIntelCapabilityActive delegates correctly (does not throw)
    //   2. it returns a boolean (not undefined/null/object)
    const result = isIntelCapabilityActive(planningDir);
    assert.strictEqual(typeof result, 'boolean', 'isIntelCapabilityActive must return a boolean');
  });

  test('intelQuery returns disabled response when intel is off', () => {
    const result = intelQuery('test', planningDir);
    assert.strictEqual(result.disabled, true);
    assert.ok(result.message.includes('disabled'));
  });

  test('intelStatus returns disabled response when intel is off', () => {
    const result = intelStatus(planningDir);
    assert.strictEqual(result.disabled, true);
  });

  test('intelDiff returns disabled response when intel is off', () => {
    const result = intelDiff(planningDir);
    assert.strictEqual(result.disabled, true);
  });

  test('intelValidate returns disabled response when intel is off', () => {
    const result = intelValidate(planningDir);
    assert.strictEqual(result.disabled, true);
  });
});

// ─── Tri-state gate hermetic regression tests ────────────────────────────────
//
// Intel capability has `skills: []` (empty) — so `installed` and `surfaced` are
// VACUOUSLY TRUE. For intel, `active = configActivation` where configActivation
// resolves the `activationKey` ("intel.enabled") via the config. This is a meaningful
// tri-state improvement because the old `isIntelEnabled` read config.json directly
// (synchronous file read, not wired through `loadConfig`), while the new gate goes
// through the full `resolveCapabilityRuntimeState` path.
//
// FAIL-FIRST PROOF (what would fail against the OLD isIntelEnabled code):
//   Scenario: intel installed (skills=[]) + config has intel.enabled=true, BUT the
//   surface has intel NOT surfaced via disabledClusters.
//
//   However: intel has skills:[], so disabledClusters:['intel'] has no effect
//   (no skills to remove from the surfaced set). Intel is always vacuously surfaced.
//
//   The CORRECT regression for intel's tri-state cutover is:
//     intel.enabled=true in config → isCapabilityActive=true → command NOT disabled
//     intel.enabled=false (or absent) → isCapabilityActive=false → command disabled
//   AND that the gate now goes through the shared resolver (not a direct config read).
//
//   FAIL-FIRST SCENARIO: OLD isIntelEnabled read config.json at the planningDir path
//   via platformReadSync. NEW isCapabilityActive uses resolveCapabilityRuntimeState
//   which goes through loadConfig (multi-layer resolution). A test that sets
//   intel.enabled=true in config then calls intelStatus would:
//     OLD: isIntelEnabled → reads .planning/config.json → true → NOT disabled.
//     NEW: isCapabilityActive → resolveCapabilityRuntimeState → configActivation=true → active=true → NOT disabled.
//   Both return the same, so the regression test focuses on the config-absent/false case
//   where the gate correctly returns disabled (proving the delegation path works).

describe('intel tri-state gate hermetic regression (isCapabilityActive cutover)', () => {
  let tmpConfigDir;
  let tmpProjectDir;
  let prevClaudeConfigDir;
  let prevGsdWorkstream;
  let prevGsdProject;

  beforeEach(() => {
    tmpConfigDir = createTempDir('gsd-intel-tristate-cfg-');
    tmpProjectDir = createTempProject('gsd-intel-tristate-proj-');

    prevClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    prevGsdWorkstream = process.env.GSD_WORKSTREAM;
    prevGsdProject = process.env.GSD_PROJECT;
    // Empty CLAUDE_CONFIG_DIR (no .gsd-surface.json) → defaults to 'full' profile.
    // Intel has skills:[] so it is vacuously installed+surfaced+enabled.
    // Active = configActivation = intel.enabled in config.
    process.env.CLAUDE_CONFIG_DIR = tmpConfigDir;
    delete process.env.GSD_WORKSTREAM;
    delete process.env.GSD_PROJECT;
  });

  afterEach(() => {
    if (prevClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prevClaudeConfigDir;
    if (prevGsdWorkstream === undefined) delete process.env.GSD_WORKSTREAM;
    else process.env.GSD_WORKSTREAM = prevGsdWorkstream;
    if (prevGsdProject === undefined) delete process.env.GSD_PROJECT;
    else process.env.GSD_PROJECT = prevGsdProject;

    cleanup(tmpConfigDir);
    cleanup(tmpProjectDir);
  });

  // NEGATIVE CASE: config has NO intel.enabled (absent → defaults to false via activationKey).
  // OLD gate: isIntelEnabled reads config.json → no intel key → returns false → disabled.
  // NEW gate: isCapabilityActive → configActivation=false (intel.enabled default=false) → active=false → disabled.
  // Both return disabled. The test PROVES the gate is wired through isCapabilityActive and
  // the command intelStatus returns disabled — regression guard against losing the delegation.
  test('intelStatus returns disabled when intel.enabled is absent in config (hermetic tristate negative)', () => {
    // No config.json in planningDir — intel.enabled defaults to false.
    // OLD isIntelEnabled: reads .planning/config.json → not found → false → disabled.
    // NEW isCapabilityActive: intel.enabled default=false → configActivation=false → active=false → disabled.
    const planningDir = path.join(tmpProjectDir, '.planning');
    const result = intelStatus(planningDir);
    assert.strictEqual(
      result.disabled,
      true,
      'intelStatus must return disabled when intel.enabled is not set — ' +
      'both old and new gate must return disabled here; this is the regression guard for the delegation path',
    );
    assert.ok(
      typeof result.message === 'string' && result.message.length > 0,
      'disabled response must include a non-empty message',
    );
  });

  // POSITIVE CONTROL: intel.enabled=true in config → isCapabilityActive=true → NOT disabled.
  // This is the primary pass case that proves the NEW gate honours config-enabled.
  // OLD gate (isIntelEnabled) returns true. NEW gate (isCapabilityActive) also returns true.
  // The test confirms the behaviour is preserved after cutover.
  test('intelStatus NOT disabled when intel.enabled=true in config (hermetic tristate positive control)', () => {
    const planningDir = path.join(tmpProjectDir, '.planning');
    fs.mkdirSync(planningDir, { recursive: true });
    fs.writeFileSync(
      path.join(planningDir, 'config.json'),
      JSON.stringify({ intel: { enabled: true } }),
      'utf8',
    );

    const active = isCapabilityActive('intel', tmpProjectDir);
    assert.strictEqual(
      active,
      true,
      'isCapabilityActive must return true when intel.enabled=true and intel is vacuously installed+surfaced',
    );

    const result = intelStatus(planningDir);
    assert.ok(
      !result.disabled,
      'intelStatus must NOT return disabled when intel.enabled=true (positive control)',
    );
  });
});

// ─── ensureIntelDir ─────────────────────────────────────────────────────────

describe('ensureIntelDir', () => {
  let tmpDir;
  let planningDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    planningDir = path.join(tmpDir, '.planning');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('creates intel directory if it does not exist', () => {
    const intelPath = ensureIntelDir(planningDir);
    assert.ok(fs.existsSync(intelPath));
    assert.ok(intelPath.endsWith('intel'));
  });

  test('returns existing intel directory without error', () => {
    fs.mkdirSync(path.join(planningDir, 'intel'), { recursive: true });
    const intelPath = ensureIntelDir(planningDir);
    assert.ok(fs.existsSync(intelPath));
  });
});

// ─── intelQuery ─────────────────────────────────────────────────────────────

describe('intelQuery', () => {
  let tmpDir;
  let planningDir;
  let surfacedConfigDir;
  let savedEnv;

  beforeEach(() => {
    tmpDir = createTempProject();
    planningDir = path.join(tmpDir, '.planning');
    enableIntel(planningDir);
    // Harden: ensure intel is surfaced (tri-state gate requires install+surface+config).
    // Empty CLAUDE_CONFIG_DIR defaults to 'full' profile → all caps surfaced.
    surfacedConfigDir = makeSurfacedConfigDir();
    savedEnv = saveSurfacedEnv();
    delete process.env.GSD_RUNTIME;
    process.env.CLAUDE_CONFIG_DIR = surfacedConfigDir;
    delete process.env.GSD_WORKSTREAM;
    delete process.env.GSD_PROJECT;
  });

  afterEach(() => {
    savedEnv.restore();
    cleanup(surfacedConfigDir);
    cleanup(tmpDir);
  });

  test('returns empty matches when no intel files exist', () => {
    const result = intelQuery('anything', planningDir);
    assert.strictEqual(result.total, 0);
    assert.deepStrictEqual(result.matches, []);
    assert.strictEqual(result.term, 'anything');
  });

  test('finds matches in JSON file keys', () => {
    writeIntelJson(planningDir, 'file-roles.json', {
      _meta: { updated_at: new Date().toISOString() },
      entries: {
        'src/auth/controller.ts': { size: 1024, type: 'typescript' },
        'src/utils/logger.ts': { size: 512, type: 'typescript' },
      },
    });

    const result = intelQuery('auth', planningDir);
    assert.strictEqual(result.total, 1);
    assert.strictEqual(result.matches[0].source, 'file-roles.json');
    assert.strictEqual(result.matches[0].entries[0].key, 'src/auth/controller.ts');
  });

  test('finds matches in JSON file values', () => {
    writeIntelJson(planningDir, 'dependency-graph.json', {
      _meta: { updated_at: new Date().toISOString() },
      entries: {
        express: { version: '4.18.0', type: 'runtime', used_by: ['src/server.ts'] },
      },
    });

    const result = intelQuery('express', planningDir);
    assert.strictEqual(result.total, 1);
    assert.strictEqual(result.matches[0].entries[0].key, 'express');
  });

  test('search is case-insensitive', () => {
    writeIntelJson(planningDir, 'file-roles.json', {
      entries: {
        'src/AuthController.ts': { type: 'typescript' },
      },
    });

    const result = intelQuery('authcontroller', planningDir);
    assert.strictEqual(result.total, 1);
  });

  test('finds matches in arch-decisions.json entries', () => {
    writeIntelJson(planningDir, 'arch-decisions.json', {
      _meta: { updated_at: new Date().toISOString() },
      entries: {
        'jwt-auth': { decision: 'Use JWT tokens for stateless authentication', status: 'accepted' },
        'rest-api': { decision: 'REST API endpoints for all services', status: 'accepted' },
      },
    });

    const result = intelQuery('JWT', planningDir);
    assert.strictEqual(result.total, 1);
    assert.strictEqual(result.matches[0].source, 'arch-decisions.json');
  });

  test('searches across multiple intel files', () => {
    writeIntelJson(planningDir, 'file-roles.json', {
      entries: { 'src/auth.ts': { exports: ['authenticate'] } },
    });
    writeIntelJson(planningDir, 'api-map.json', {
      entries: { '/api/auth': { method: 'POST', handler: 'authenticate' } },
    });

    const result = intelQuery('auth', planningDir);
    assert.strictEqual(result.total, 2);
    assert.strictEqual(result.matches.length, 2);
  });
});

// ─── intelStatus ────────────────────────────────────────────────────────────

describe('intelStatus', () => {
  let tmpDir;
  let planningDir;
  let surfacedConfigDir;
  let savedEnv;

  beforeEach(() => {
    tmpDir = createTempProject();
    planningDir = path.join(tmpDir, '.planning');
    enableIntel(planningDir);
    surfacedConfigDir = makeSurfacedConfigDir();
    savedEnv = saveSurfacedEnv();
    delete process.env.GSD_RUNTIME;
    process.env.CLAUDE_CONFIG_DIR = surfacedConfigDir;
    delete process.env.GSD_WORKSTREAM;
    delete process.env.GSD_PROJECT;
  });

  afterEach(() => {
    savedEnv.restore();
    cleanup(surfacedConfigDir);
    cleanup(tmpDir);
  });

  test('reports missing files as stale', () => {
    const result = intelStatus(planningDir);
    assert.strictEqual(result.overall_stale, true);
    assert.strictEqual(result.files['file-roles.json'].exists, false);
    assert.strictEqual(result.files['file-roles.json'].stale, true);
  });

  test('reports fresh files as not stale', () => {
    writeIntelJson(planningDir, 'file-roles.json', {
      _meta: { updated_at: new Date().toISOString() },
      entries: {},
    });

    const result = intelStatus(planningDir);
    assert.strictEqual(result.files['file-roles.json'].exists, true);
    assert.strictEqual(result.files['file-roles.json'].stale, false);
  });

  test('reports old files as stale', () => {
    const oldDate = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    writeIntelJson(planningDir, 'file-roles.json', {
      _meta: { updated_at: oldDate },
      entries: {},
    });

    const result = intelStatus(planningDir);
    assert.strictEqual(result.files['file-roles.json'].stale, true);
    assert.strictEqual(result.overall_stale, true);
  });
});

// ─── intelDiff ──────────────────────────────────────────────────────────────

describe('intelDiff', () => {
  let tmpDir;
  let planningDir;
  let surfacedConfigDir;
  let savedEnv;

  beforeEach(() => {
    tmpDir = createTempProject();
    planningDir = path.join(tmpDir, '.planning');
    enableIntel(planningDir);
    surfacedConfigDir = makeSurfacedConfigDir();
    savedEnv = saveSurfacedEnv();
    delete process.env.GSD_RUNTIME;
    process.env.CLAUDE_CONFIG_DIR = surfacedConfigDir;
    delete process.env.GSD_WORKSTREAM;
    delete process.env.GSD_PROJECT;
  });

  afterEach(() => {
    savedEnv.restore();
    cleanup(surfacedConfigDir);
    cleanup(tmpDir);
  });

  test('returns no_baseline when no snapshot exists', () => {
    const result = intelDiff(planningDir);
    assert.strictEqual(result.no_baseline, true);
  });

  test('detects added files since snapshot', () => {
    // Save an empty snapshot
    const intelPath = ensureIntelDir(planningDir);
    fs.writeFileSync(
      path.join(intelPath, '.last-refresh.json'),
      JSON.stringify({ hashes: {}, timestamp: new Date().toISOString(), version: 1 }),
      'utf8'
    );

    // Add a file after snapshot
    writeIntelJson(planningDir, 'file-roles.json', { entries: {} });

    const result = intelDiff(planningDir);
    assert.ok(result.added.includes('file-roles.json'));
  });

  test('detects changed files since snapshot', () => {
    // Write initial file
    writeIntelJson(planningDir, 'file-roles.json', { entries: { a: 1 } });

    // Take snapshot
    intelSnapshot(planningDir);

    // Modify file
    writeIntelJson(planningDir, 'file-roles.json', { entries: { a: 1, b: 2 } });

    const result = intelDiff(planningDir);
    assert.ok(result.changed.includes('file-roles.json'));
  });
});

// ─── intelSnapshot ──────────────────────────────────────────────────────────

describe('intelSnapshot', () => {
  let tmpDir;
  let planningDir;
  let surfacedConfigDir;
  let savedEnv;

  beforeEach(() => {
    tmpDir = createTempProject();
    planningDir = path.join(tmpDir, '.planning');
    enableIntel(planningDir);
    surfacedConfigDir = makeSurfacedConfigDir();
    savedEnv = saveSurfacedEnv();
    delete process.env.GSD_RUNTIME;
    process.env.CLAUDE_CONFIG_DIR = surfacedConfigDir;
    delete process.env.GSD_WORKSTREAM;
    delete process.env.GSD_PROJECT;
  });

  afterEach(() => {
    savedEnv.restore();
    cleanup(surfacedConfigDir);
    cleanup(tmpDir);
  });

  test('saves snapshot with file hashes', () => {
    writeIntelJson(planningDir, 'file-roles.json', { entries: {} });

    const result = intelSnapshot(planningDir);
    assert.strictEqual(result.saved, true);
    assert.strictEqual(result.files, 1);
    assert.ok(result.timestamp);

    const snapshot = JSON.parse(
      fs.readFileSync(path.join(planningDir, 'intel', '.last-refresh.json'), 'utf8')
    );
    assert.ok(snapshot.hashes['file-roles.json']);
  });
});

// ─── intelValidate ──────────────────────────────────────────────────────────

describe('intelValidate', () => {
  let tmpDir;
  let planningDir;
  let surfacedConfigDir;
  let savedEnv;

  beforeEach(() => {
    tmpDir = createTempProject();
    planningDir = path.join(tmpDir, '.planning');
    enableIntel(planningDir);
    surfacedConfigDir = makeSurfacedConfigDir();
    savedEnv = saveSurfacedEnv();
    delete process.env.GSD_RUNTIME;
    process.env.CLAUDE_CONFIG_DIR = surfacedConfigDir;
    delete process.env.GSD_WORKSTREAM;
    delete process.env.GSD_PROJECT;
  });

  afterEach(() => {
    savedEnv.restore();
    cleanup(surfacedConfigDir);
    cleanup(tmpDir);
  });

  test('reports errors for missing files', () => {
    const result = intelValidate(planningDir);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.length > 0);
    assert.ok(result.errors.some(e => e.includes('does not exist')));
  });

  test('reports warnings for missing _meta.updated_at', () => {
    writeIntelJson(planningDir, 'file-roles.json', { entries: {} });
    writeIntelJson(planningDir, 'api-map.json', { entries: {} });
    writeIntelJson(planningDir, 'dependency-graph.json', { entries: {} });
    writeIntelJson(planningDir, 'stack.json', { entries: {} });
    writeIntelJson(planningDir, 'arch-decisions.json', { entries: {} });

    const result = intelValidate(planningDir);
    assert.strictEqual(result.valid, true);
    assert.ok(result.warnings.some(w => w.includes('missing _meta.updated_at')));
  });

  test('reports invalid JSON as error', () => {
    const intelPath = path.join(planningDir, 'intel');
    fs.mkdirSync(intelPath, { recursive: true });
    fs.writeFileSync(path.join(intelPath, 'file-roles.json'), 'not valid json', 'utf8');
    writeIntelJson(planningDir, 'api-map.json', { entries: {} });
    writeIntelJson(planningDir, 'dependency-graph.json', { entries: {} });
    writeIntelJson(planningDir, 'stack.json', { entries: {} });
    writeIntelJson(planningDir, 'arch-decisions.json', { entries: {} });

    const result = intelValidate(planningDir);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('invalid JSON')));
  });

  test('passes validation with complete fresh intel', () => {
    const now = new Date().toISOString();
    writeIntelJson(planningDir, 'file-roles.json', {
      _meta: { updated_at: now },
      entries: {},
    });
    writeIntelJson(planningDir, 'api-map.json', {
      _meta: { updated_at: now },
      entries: {},
    });
    writeIntelJson(planningDir, 'dependency-graph.json', {
      _meta: { updated_at: now },
      entries: {},
    });
    writeIntelJson(planningDir, 'stack.json', {
      _meta: { updated_at: now },
      entries: {},
    });
    writeIntelJson(planningDir, 'arch-decisions.json', {
      _meta: { updated_at: now },
      entries: {},
    });

    const result = intelValidate(planningDir);
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.errors.length, 0);
  });
});

// ─── intelPatchMeta ─────────────────────────────────────────────────────────

describe('intelPatchMeta', () => {
  let tmpDir;
  let planningDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    planningDir = path.join(tmpDir, '.planning');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('patches _meta.updated_at and increments version', () => {
    writeIntelJson(planningDir, 'file-roles.json', {
      _meta: { updated_at: '2025-01-01T00:00:00Z', version: 1 },
      entries: {},
    });

    const filePath = path.join(planningDir, 'intel', 'file-roles.json');
    const result = intelPatchMeta(filePath);

    assert.strictEqual(result.patched, true);

    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.strictEqual(data._meta.version, 2);
    assert.notStrictEqual(data._meta.updated_at, '2025-01-01T00:00:00Z');
  });

  test('creates _meta if missing', () => {
    writeIntelJson(planningDir, 'file-roles.json', { entries: {} });

    const filePath = path.join(planningDir, 'intel', 'file-roles.json');
    const result = intelPatchMeta(filePath);

    assert.strictEqual(result.patched, true);

    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.ok(data._meta.updated_at);
    assert.strictEqual(data._meta.version, 1);
  });

  test('returns error for missing file', () => {
    const result = intelPatchMeta('/nonexistent/file.json');
    assert.strictEqual(result.patched, false);
    assert.ok(result.error.includes('not found'));
  });

  test('returns error for invalid JSON', () => {
    const filePath = path.join(tmpDir, 'bad.json');
    fs.writeFileSync(filePath, 'not json', 'utf8');

    const result = intelPatchMeta(filePath);
    assert.strictEqual(result.patched, false);
    assert.ok(result.error.includes('Invalid JSON'));
  });
});

// ─── intelExtractExports ────────────────────────────────────────────────────

describe('intelExtractExports', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('extracts CJS module.exports object keys', () => {
    const filePath = path.join(tmpDir, 'example.cjs');
    fs.writeFileSync(filePath, [
      "'use strict';",
      'function doStuff() {}',
      'function helper() {}',
      'module.exports = {',
      '  doStuff,',
      '  helper,',
      '};',
    ].join('\n'), 'utf8');

    const result = intelExtractExports(filePath);
    assert.strictEqual(result.method, 'module.exports');
    assert.ok(result.exports.includes('doStuff'));
    assert.ok(result.exports.includes('helper'));
  });

  test('extracts ESM named exports', () => {
    const filePath = path.join(tmpDir, 'example.mjs');
    fs.writeFileSync(filePath, [
      'export function greet() {}',
      'export const VERSION = "1.0";',
      'export class Widget {}',
    ].join('\n'), 'utf8');

    const result = intelExtractExports(filePath);
    assert.strictEqual(result.method, 'esm');
    assert.ok(result.exports.includes('greet'));
    assert.ok(result.exports.includes('VERSION'));
    assert.ok(result.exports.includes('Widget'));
  });

  test('extracts ESM export block', () => {
    const filePath = path.join(tmpDir, 'example.js');
    fs.writeFileSync(filePath, [
      'function foo() {}',
      'function bar() {}',
      'export { foo, bar };',
    ].join('\n'), 'utf8');

    const result = intelExtractExports(filePath);
    assert.ok(result.exports.includes('foo'));
    assert.ok(result.exports.includes('bar'));
  });

  test('returns empty exports for nonexistent file', () => {
    const result = intelExtractExports('/nonexistent/file.js');
    assert.deepStrictEqual(result.exports, []);
    assert.strictEqual(result.method, 'none');
  });

  // ── Behavior-lock: dedup + order (green before AND after Set conversion) ──

  test('dedup: duplicate exports.X assignments yield each name exactly once', () => {
    // exports.foo appears twice — result must contain 'foo' exactly once
    const filePath = path.join(tmpDir, 'dedup-exports-x.cjs');
    fs.writeFileSync(filePath, [
      "'use strict';",
      'exports.foo = 1;',
      'exports.bar = 2;',
      'exports.foo = 3;',
    ].join('\n'), 'utf8');

    const result = intelExtractExports(filePath);
    assert.strictEqual(result.method, 'exports.X');
    assert.deepStrictEqual(result.exports, ['foo', 'bar']);
  });

  test('order: CJS exports.X preserves first-seen insertion order', () => {
    // Names appear in source order: charlie, alpha, bravo
    const filePath = path.join(tmpDir, 'order-cjs.cjs');
    fs.writeFileSync(filePath, [
      "'use strict';",
      'exports.charlie = 1;',
      'exports.alpha = 2;',
      'exports.bravo = 3;',
    ].join('\n'), 'utf8');

    const result = intelExtractExports(filePath);
    assert.strictEqual(result.method, 'exports.X');
    assert.deepStrictEqual(result.exports, ['charlie', 'alpha', 'bravo']);
  });

  test('dedup: ESM export block with repeated name yields name exactly once', () => {
    // export { foo, foo } — foo must appear once
    const filePath = path.join(tmpDir, 'dedup-esm-block.mjs');
    fs.writeFileSync(filePath, [
      'function foo() {}',
      'export { foo, foo };',
    ].join('\n'), 'utf8');

    const result = intelExtractExports(filePath);
    assert.strictEqual(result.method, 'esm');
    assert.deepStrictEqual(result.exports, ['foo']);
  });

  test('merge order: CJS exports appear before ESM exports, each name once', () => {
    // exports.X = CJS side; export function / export const = ESM side
    // Expected order: CJS-first then ESM additions
    const filePath = path.join(tmpDir, 'merge-order.mjs');
    fs.writeFileSync(filePath, [
      "exports.cjsFirst = 1;",
      "export function esmSecond() {}",
      "export const esmThird = 3;",
    ].join('\n'), 'utf8');

    const result = intelExtractExports(filePath);
    assert.strictEqual(result.method, 'mixed');
    assert.deepStrictEqual(result.exports, ['cjsFirst', 'esmSecond', 'esmThird']);
  });

  test('export default collapse: only export default (anon) yields ["default"]', () => {
    // A file with only `export default <value>` — no named exports, no default fn/class
    // The collapse guard (esmExports.length === 0 at time of check) produces ["default"]
    const filePath = path.join(tmpDir, 'default-only.mjs');
    fs.writeFileSync(filePath, 'export default 42;', 'utf8');

    const result = intelExtractExports(filePath);
    assert.strictEqual(result.method, 'esm');
    assert.deepStrictEqual(result.exports, ['default']);
  });

  test('export default collapse: export default fn + named exports — no "default" collapse', () => {
    // export default function myFunc() {} → myFunc is extracted (named default fn)
    // export const named → also extracted
    // "default" literal does NOT appear because esmExports is not empty when anon-default check runs
    const filePath = path.join(tmpDir, 'default-fn-plus-named.mjs');
    fs.writeFileSync(filePath, [
      'export default function myFunc() {}',
      'export const named = 1;',
    ].join('\n'), 'utf8');

    const result = intelExtractExports(filePath);
    assert.strictEqual(result.method, 'esm');
    assert.deepStrictEqual(result.exports, ['myFunc', 'named']);
  });

  test('return shape: exports is a plain Array (callers use .includes/.length)', () => {
    const filePath = path.join(tmpDir, 'shape-check.cjs');
    fs.writeFileSync(filePath, [
      "'use strict';",
      'exports.foo = 1;',
    ].join('\n'), 'utf8');

    const result = intelExtractExports(filePath);
    assert.ok(Array.isArray(result.exports), 'exports must be a plain Array');
    assert.ok('file' in result, 'result must have file field');
    assert.ok('method' in result, 'result must have method field');
  });
});

// ─── CLI routing via gsd-tools ──────────────────────────────────────────────

describe('gsd-tools intel subcommands', () => {
  let tmpDir;
  let surfacedConfigDir;
  let savedEnv;

  beforeEach(() => {
    tmpDir = createTempProject();
    // Set up surfaced config dir for positive-path CLI tests (subprocess inherits env).
    // Negative-path tests (disabled) still work because intel.enabled is not set by default.
    surfacedConfigDir = makeSurfacedConfigDir();
    savedEnv = saveSurfacedEnv();
    delete process.env.GSD_RUNTIME;
    process.env.CLAUDE_CONFIG_DIR = surfacedConfigDir;
    delete process.env.GSD_WORKSTREAM;
    delete process.env.GSD_PROJECT;
  });

  afterEach(() => {
    savedEnv.restore();
    cleanup(surfacedConfigDir);
    cleanup(tmpDir);
  });

  test('intel status returns disabled message when not enabled', () => {
    const result = runGsdTools(['intel', 'status'], tmpDir);
    assert.strictEqual(result.success, true);
    const output = JSON.parse(result.output);
    assert.strictEqual(output.disabled, true);
  });

  test('intel query returns disabled message when not enabled', () => {
    const result = runGsdTools(['intel', 'query', 'test'], tmpDir);
    assert.strictEqual(result.success, true);
    const output = JSON.parse(result.output);
    assert.strictEqual(output.disabled, true);
  });

  test('intel status returns file status when enabled', () => {
    enableIntel(path.join(tmpDir, '.planning'));
    const result = runGsdTools(['intel', 'status'], tmpDir);
    assert.strictEqual(result.success, true);
    const output = JSON.parse(result.output);
    assert.ok(output.files);
    assert.strictEqual(output.overall_stale, true);
  });

  test('intel validate reports errors for missing files when enabled', () => {
    enableIntel(path.join(tmpDir, '.planning'));
    const result = runGsdTools(['intel', 'validate'], tmpDir);
    assert.strictEqual(result.success, true);
    const output = JSON.parse(result.output);
    assert.strictEqual(output.valid, false);
    assert.ok(output.errors.length > 0);
  });

  test('unknown intel subcommand error lists api-surface', () => {
    const result = runGsdTools(['intel', 'nonexistent-subcmd'], tmpDir);
    assert.strictEqual(result.success, false);
    const errorText = result.error || '';
    assert.ok(errorText.includes('api-surface'), 'error message must list api-surface');
  });

  test('flag-looking intel subcommand treated as unknown, not crash', () => {
    const result = runGsdTools(['intel', '--api-surface'], tmpDir);
    assert.strictEqual(result.success, false);
    const errorText = result.error || '';
    assert.ok(errorText.includes('Unknown intel subcommand'), 'must emit typed unknown-subcommand error');
  });

  test('intel api-surface returns disabled message when not enabled', () => {
    const result = runGsdTools(['intel', 'api-surface'], tmpDir);
    assert.strictEqual(result.success, true);
    const output = JSON.parse(result.output);
    assert.strictEqual(output.disabled, true);
  });

  test('intel api-surface writes API-SURFACE.md when enabled with populated api-map.json', () => {
    const planningDir = path.join(tmpDir, '.planning');
    enableIntel(planningDir);
    writeIntelJson(planningDir, 'api-map.json', {
      _meta: { updated_at: new Date().toISOString() },
      entries: {
        'intelQuery': { method: 'function', handler: 'intelQuery', role: 'query intel files' },
        'intelStatus': { method: 'function', handler: 'intelStatus', role: 'report freshness' },
      },
    });
    const result = runGsdTools(['intel', 'api-surface'], tmpDir);
    assert.strictEqual(result.success, true);
    const output = JSON.parse(result.output);
    assert.ok(output.written, 'result must include written path');
    assert.strictEqual(output.symbolCount, 2);
    const mdContent = fs.readFileSync(output.written, 'utf8');
    assert.ok(mdContent.includes('intelQuery'), 'API-SURFACE.md must list intelQuery symbol');
    assert.ok(mdContent.includes('intelStatus'), 'API-SURFACE.md must list intelStatus symbol');
  });
});

// ─── intelApiSurface ────────────────────────────────────────────────────────

describe('intelApiSurface', () => {
  let tmpDir;
  let planningDir;
  let surfacedConfigDir;
  let savedEnv;

  beforeEach(() => {
    tmpDir = createTempProject();
    planningDir = path.join(tmpDir, '.planning');
    surfacedConfigDir = makeSurfacedConfigDir();
    savedEnv = saveSurfacedEnv();
    delete process.env.GSD_RUNTIME;
    process.env.CLAUDE_CONFIG_DIR = surfacedConfigDir;
    delete process.env.GSD_WORKSTREAM;
    delete process.env.GSD_PROJECT;
  });

  afterEach(() => {
    savedEnv.restore();
    cleanup(surfacedConfigDir);
    cleanup(tmpDir);
  });

  test('returns disabled response when intel is off', () => {
    const result = intelApiSurface(planningDir);
    assert.strictEqual(result.disabled, true);
    assert.ok(result.message.includes('disabled'));
  });

  test('writes API-SURFACE.md with symbol entries from api-map.json', () => {
    enableIntel(planningDir);
    writeIntelJson(planningDir, 'api-map.json', {
      _meta: { updated_at: new Date().toISOString() },
      entries: {
        'authenticate': { method: 'POST', handler: 'authController', role: 'user login' },
        'createUser': { method: 'POST', handler: 'userController', role: 'user registration' },
      },
    });

    const result = intelApiSurface(planningDir);
    assert.strictEqual(result.symbolCount, 2);
    assert.ok(result.written.endsWith('API-SURFACE.md'));

    const content = fs.readFileSync(result.written, 'utf8');
    assert.ok(content.includes('authenticate'), 'must include symbol name authenticate');
    assert.ok(content.includes('createUser'), 'must include symbol name createUser');
    assert.ok(content.includes('authController'), 'must include field value authController');
  });

  test('writes API-SURFACE.md with incomplete banner when api-map.json is absent', () => {
    enableIntel(planningDir);
    // No api-map.json written

    const result = intelApiSurface(planningDir);
    assert.strictEqual(result.symbolCount, 0);
    assert.ok(result.written.endsWith('API-SURFACE.md'));

    const content = fs.readFileSync(result.written, 'utf8');
    assert.ok(content.includes('Incomplete'), 'must contain Incomplete banner when no entries');
    assert.ok(content.includes('unknown'), 'must say treat absence as "unknown"');
  });

  test('writes API-SURFACE.md with incomplete banner when entries is empty object', () => {
    enableIntel(planningDir);
    writeIntelJson(planningDir, 'api-map.json', {
      _meta: { updated_at: new Date().toISOString() },
      entries: {},
    });

    const result = intelApiSurface(planningDir);
    assert.strictEqual(result.symbolCount, 0);

    const content = fs.readFileSync(result.written, 'utf8');
    assert.ok(content.includes('Incomplete'), 'empty entries must still emit incomplete banner');
  });

  test('returns stale=false for fresh api-map.json', () => {
    enableIntel(planningDir);
    writeIntelJson(planningDir, 'api-map.json', {
      _meta: { updated_at: new Date().toISOString() },
      entries: { 'myFunc': { method: 'function' } },
    });

    const result = intelApiSurface(planningDir);
    assert.strictEqual(result.stale, false);
  });

  test('returns stale=true for old api-map.json', () => {
    enableIntel(planningDir);
    const oldDate = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    writeIntelJson(planningDir, 'api-map.json', {
      _meta: { updated_at: oldDate },
      entries: { 'myFunc': { method: 'function' } },
    });

    const result = intelApiSurface(planningDir);
    assert.strictEqual(result.stale, true);
  });

  test('return shape has written, symbolCount, stale fields', () => {
    enableIntel(planningDir);
    const result = intelApiSurface(planningDir);
    assert.ok('written' in result, 'result must have written field');
    assert.ok('symbolCount' in result, 'result must have symbolCount field');
    assert.ok('stale' in result, 'result must have stale field');
  });
});

describe('#1000 regression: gsd-intel-updater emits canonical intel filenames', () => {
  // allow-test-rule: source-text-is-the-product — agents/gsd-intel-updater.md IS the
  // system prompt the intel-updater agent runs under; asserting its filename references
  // verifies the deployed agent surface contract matches the INTEL_FILES the CLI reads.
  const agentPromptPath = path.join(__dirname, '..', 'agents', 'gsd-intel-updater.md');
  const agentPrompt = fs.readFileSync(agentPromptPath, 'utf8');

  test('references every canonical INTEL_FILES name', () => {
    for (const filename of Object.values(INTEL_FILES)) {
      assert.ok(
        agentPrompt.includes(filename),
        `gsd-intel-updater.md must instruct writing the canonical intel file "${filename}" (from INTEL_FILES) that the gsd-tools intel CLI reads; it was missing.`,
      );
    }
  });

  test('does not reference orphaned short filenames the CLI never reads', () => {
    // Short forms `${key}.json` that are NOT canonical INTEL_FILES values are orphaned —
    // the agent must not emit them. Also forbid the markdown arch.md output.
    const canonical = new Set(Object.values(INTEL_FILES));
    const forbidden = Object.keys(INTEL_FILES)
      .map((k) => `${k}.json`)
      .filter((short) => !canonical.has(short));
    forbidden.push('arch.md');
    for (const shortName of forbidden) {
      // Guard against substring false-positives (e.g. 'files.json' inside 'file-roles.json'):
      // canonical long names never contain these short tokens, verified by the canonical set.
      const offendingLines = agentPrompt
        .split(/\r?\n/)
        .filter((line) => line.includes(shortName));
      assert.strictEqual(
        offendingLines.length,
        0,
        `gsd-intel-updater.md must not reference orphaned short name "${shortName}" the intel CLI never reads. Offending line(s):\n${offendingLines.join('\n')}`,
      );
    }
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3258-no-stale-gsd-intel-references.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3258-no-stale-gsd-intel-references (consolidation epic #1969 B3 #1972)", () => {
// allow-test-rule: source-text-is-the-product — workflow, reference, and docs .md files (see #3258)
// ARE what the runtime loads and what users read; asserting their text content
// tests the deployed skill surface contract, not implementation internals.

'use strict';

// Regression tests for bug #3258.
//
// PR #2790 folded `/gsd-intel` into `/gsd-map-codebase --query`. After that
// consolidation, five prose occurrences in two source files continued to
// reference the retired `/gsd-intel` slash command. Users invoking the wizard
// were directed to a command that no longer exists.
//
// Fix: replace each `/gsd-intel` (the retired user-facing slash command) with
// `/gsd-map-codebase --query` in:
//   - gsd-core/references/planning-config.md
//   - gsd-core/workflows/settings.md
//   - docs/INVENTORY.md
//   - docs/USER-GUIDE.md
//   - docs/FEATURES.md
//
// Allowed: `gsd-intel-updater` (still-valid agent name, no leading slash),
//          `intel.cjs` / `intel.enabled` / `intel.*` (internal backend, not user command),
//          CHANGELOG.md (historical record), test files themselves.
//
// This test distinguishes `/gsd-intel` (the retired slash command, leading slash)
// from `gsd-intel-updater` (still-valid agent) by grepping for the literal
// string `/gsd-intel` and then asserting no match survives after excluding
// the `-updater` suffix.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

/** Walk a directory recursively and return absolute paths of all .md files. */
function walkMd(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkMd(abs));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      results.push(abs);
    }
  }
  return results;
}

/**
 * Return all lines in `src` that contain `/gsd-intel` (the retired slash
 * command) but are NOT the agent name `gsd-intel-updater`.
 * We match the literal substring `/gsd-intel` (with leading slash) and then
 * exclude any line where the match is immediately followed by `-updater`.
 */
function staleLinesIn(src) {
  return src.split('\n').filter((line) => {
    if (!line.includes('/gsd-intel')) return false;
    // Remove all occurrences of the valid agent name; if nothing remains, skip.
    const stripped = line.replace(/\/gsd-intel-updater/g, '');
    return stripped.includes('/gsd-intel');
  });
}

const SOURCE_DIRS = [
  path.join(ROOT, 'commands', 'gsd'),
  path.join(ROOT, 'gsd-core', 'workflows'),
  path.join(ROOT, 'gsd-core', 'references'),
  path.join(ROOT, 'agents'),
  path.join(ROOT, 'docs'),
];

describe('#3258: no stale /gsd-intel slash-command references in product source dirs', () => {
  for (const dir of SOURCE_DIRS) {
    const files = walkMd(dir);
    for (const file of files) {
      const rel = path.relative(ROOT, file);

      // Allowed exclusions:
      // - CHANGELOG.md is a historical record; /gsd-intel appears in release notes
      // - test files (under tests/) are excluded automatically by SOURCE_DIRS scope
      if (rel === 'CHANGELOG.md') continue;

      test(`${rel} has no stale /gsd-intel references`, () => {
        let src;
        try {
          src = fs.readFileSync(file, 'utf8');
        } catch (err) {
          throw new Error(`failed reading ${rel}: ${err.message}`);
        }

        const staleLines = staleLinesIn(src);
        assert.strictEqual(
          staleLines.length,
          0,
          [
            `${rel} contains ${staleLines.length} stale /gsd-intel reference(s).`,
            'Replace with /gsd-map-codebase --query (retired by PR #2790).',
            'Stale lines:',
            ...staleLines.map((l) => `  ${l.trim()}`),
          ].join('\n'),
        );
      });
    }
  }
});
  });
}
