'use strict';
/**
 * bug-492-effort-manifest-fallback.test.cjs
 *
 * Verifies resolveEffortInternal's fallback chain when no project config.json
 * is present.
 *
 * Isolation strategy: every test that injects custom effort values writes
 * them to a per-test ~/.gsd/defaults.json rooted under a tmpHome, pointed at
 * via GSD_HOME. This avoids mutating the module-level CANONICAL_CONFIG_DEFAULTS
 * singleton (which caused independence violations under parallel runs).
 *
 * Test 1 (pure manifest fallback): tmpDir WITH .planning/ but no config.json.
 * GSD_HOME points to a bare tmpHome (no defaults.json). loadConfig sees
 * .planning/ → returns effort:null → model-resolver reads CANONICAL_CONFIG_DEFAULTS
 * directly for routing_tier_defaults.
 *
 * Tests 2-4 (global-defaults path): bare tmpDir (no .planning/) so loadConfig
 * hits the ~/.gsd/defaults.json branch. A test-scoped defaults.json injects
 * the desired effort sub-object; model-resolver then takes the effortCfg
 * (non-null) branch — no singleton touched.
 */

process.env.GSD_TEST_MODE = '1';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { cleanup } = require('./helpers.cjs');
const { resolveEffortInternal } = require('../gsd-core/bin/lib/core.cjs');

/** Create a bare temp directory with no .planning/ structure */
function createBareTmpDir(prefix = 'gsd-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Create a temp home dir and write effort config into .gsd/defaults.json */
function createTmpHomeWithEffort(effortConfig) {
  const tmpHome = createBareTmpDir('gsd-home-');
  const gsdDir = path.join(tmpHome, '.gsd');
  fs.mkdirSync(gsdDir, { recursive: true });
  fs.writeFileSync(
    path.join(gsdDir, 'defaults.json'),
    JSON.stringify({ effort: effortConfig })
  );
  return tmpHome;
}

describe('#492 manifest effort fallback', () => {
  // These tests manage GSD_HOME per-test, so no shared beforeEach/afterEach.

  test('routing_tier_defaults manifest fallback still works when no config and no defaults.json', (t) => {
    // .planning/ exists → loadConfig returns effort:null → model-resolver reads
    // CANONICAL_CONFIG_DEFAULTS['effort']['routing_tier_defaults']['heavy'] = "xhigh".
    const tmpDir = createBareTmpDir();
    fs.mkdirSync(path.join(tmpDir, '.planning'), { recursive: true });
    const tmpHome = createBareTmpDir('gsd-home-');
    process.env.GSD_HOME = tmpHome;
    t.after(() => {
      delete process.env.GSD_HOME;
      cleanup(tmpDir);
      cleanup(tmpHome);
    });

    // gsd-planner's default tier is "heavy"; manifest routing_tier_defaults.heavy = "xhigh"
    assert.strictEqual(resolveEffortInternal(tmpDir, 'gsd-planner'), 'xhigh');
  });

  test('global-defaults effort.agent_overrides wins over routing_tier_defaults when no project config', (t) => {
    // bare tmpDir (no .planning/) → loadConfig reads ~/.gsd/defaults.json
    // which supplies effort.agent_overrides → resolveEffortInternal returns that value.
    const tmpDir = createBareTmpDir();
    const tmpHome = createTmpHomeWithEffort({ agent_overrides: { 'gsd-planner': 'max' } });
    process.env.GSD_HOME = tmpHome;
    t.after(() => {
      delete process.env.GSD_HOME;
      cleanup(tmpDir);
      cleanup(tmpHome);
    });

    assert.strictEqual(resolveEffortInternal(tmpDir, 'gsd-planner'), 'max');
  });

  test('global-defaults effort.default consulted for unknown agent with no project config', (t) => {
    // effort.default in defaults.json wins for an agent with no tier mapping.
    const tmpDir = createBareTmpDir();
    const tmpHome = createTmpHomeWithEffort({ default: 'max' });
    process.env.GSD_HOME = tmpHome;
    t.after(() => {
      delete process.env.GSD_HOME;
      cleanup(tmpDir);
      cleanup(tmpHome);
    });

    assert.strictEqual(resolveEffortInternal(tmpDir, 'fictional-agent-xyz-492'), 'max');
  });

  test('global-defaults agent_overrides takes precedence over routing_tier_defaults', (t) => {
    // agent_overrides is checked first (step 2), so "minimal" wins over
    // routing_tier_defaults.heavy = "xhigh" (step 3).
    const tmpDir = createBareTmpDir();
    const tmpHome = createTmpHomeWithEffort({
      agent_overrides: { 'gsd-planner': 'minimal' },
      routing_tier_defaults: { heavy: 'xhigh' },
    });
    process.env.GSD_HOME = tmpHome;
    t.after(() => {
      delete process.env.GSD_HOME;
      cleanup(tmpDir);
      cleanup(tmpHome);
    });

    assert.strictEqual(resolveEffortInternal(tmpDir, 'gsd-planner'), 'minimal');
  });
});
