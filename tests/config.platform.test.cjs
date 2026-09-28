'use strict';

/**
 * Platform-sensitive tests split out of tests/config.test.cjs (#5074).
 *
 * scripts/gen-platform-conformance-tier.cjs selects whole files for the real-OS
 * (Windows/macOS) conformance tier. The tests below carry the platform signal, so
 * they live here; tests/config.test.cjs stays signal-free and runs on Linux only.
 * Linux lanes run both files. Add a new platform-sensitive test HERE, not in the
 * base file — the generator fails if a split base regains a platform signal.
 *
 * Moved tests and why each needs a real OS:
 * - "detects Brave Search from file-based key" — asserts API-key detection resolved
 *   under a fabricated HOME/USERPROFILE home directory (windows-env-var)
 * - "detects Tavily Search from env var" — same home-directory resolution (windows-env-var)
 * - "tavily_search is false when env var absent and no key file" — same (windows-env-var)
 * - "detects Tavily Search from file-based key" — same (windows-env-var)
 * - "detects Ref Search from env var" — same (windows-env-var)
 * - "ref_search is false when env var absent and no key file" — same (windows-env-var)
 * - "detects Ref Search from file-based key" — same (windows-env-var)
 * - "detects Perplexity from env var" — same (windows-env-var)
 * - "perplexity is false when env var absent and no key file" — same (windows-env-var)
 * - "detects Perplexity from file-based key" — same (windows-env-var)
 * - "detects Jina from env var" — same (windows-env-var)
 * - "jina is false when env var absent and no key file" — same (windows-env-var)
 * - "detects Jina from file-based key" — same (windows-env-var)
 * - "merges user defaults from defaults.json" — asserts defaults.json merge resolved
 *   under the fabricated home directory (windows-env-var)
 * - "merges nested workflow keys from defaults.json preserving unset keys" — same (windows-env-var)
 * - "gets a top-level value" — asserts a config value resolved via a config seeded
 *   under the fabricated home directory (windows-env-var)
 * - "creates full config with all expected keys" — asserts config-new-project output
 *   resolved under the fabricated home directory (windows-env-var)
 * - "user choices override defaults" — same (windows-env-var)
 * - "works with empty choices — all defaults materialized" — same (windows-env-var)
 * - "reports previous profile in output" — asserts previous-profile detection resolved
 *   under the fabricated home directory (windows-env-var)
 * - "skip_discuss is present in config-new-project output" — asserts config-new-project
 *   output resolved under the fabricated home directory (windows-env-var)
 * - "skip_discuss can be set via config-new-project choices" — same (windows-env-var)
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

function readConfig(tmpDir) {
  const configPath = path.join(tmpDir, '.planning', 'config.json');
  return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
}

// ─── config-ensure-section (home-resolved API-key / defaults.json tests) ──────

describe('config-ensure-section command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('detects Brave Search from file-based key', () => {
    // runGsdTools sandboxes HOME=tmpDir, so brave_api_key is written there —
    // no real filesystem side effects, cleanup happens via afterEach.
    const gsdDir = path.join(tmpDir, '.gsd');
    fs.mkdirSync(gsdDir, { recursive: true });
    fs.writeFileSync(path.join(gsdDir, 'brave_api_key'), 'test-key', 'utf-8');

    const result = runGsdTools('config-ensure-section', tmpDir, { HOME: tmpDir, USERPROFILE: tmpDir });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.brave_search, true);
  });

  test('detects Tavily Search from env var', () => {
    const result = runGsdTools('config-ensure-section', tmpDir, { HOME: tmpDir, USERPROFILE: tmpDir, TAVILY_API_KEY: 'test-key' });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.tavily_search, true);
  });

  test('tavily_search is false when env var absent and no key file', () => {
    const result = runGsdTools('config-ensure-section', tmpDir, { HOME: tmpDir, USERPROFILE: tmpDir, TAVILY_API_KEY: '' });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.tavily_search, false);
  });

  test('detects Tavily Search from file-based key', () => {
    const gsdDir = path.join(tmpDir, '.gsd');
    fs.mkdirSync(gsdDir, { recursive: true });
    fs.writeFileSync(path.join(gsdDir, 'tavily_api_key'), 'test-key', 'utf-8');

    const result = runGsdTools('config-ensure-section', tmpDir, { HOME: tmpDir, USERPROFILE: tmpDir, TAVILY_API_KEY: '' });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.tavily_search, true);
  });

  test('detects Ref Search from env var', () => {
    const result = runGsdTools('config-ensure-section', tmpDir, { HOME: tmpDir, USERPROFILE: tmpDir, REF_API_KEY: 'test-key' });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.ref_search, true);
  });

  test('ref_search is false when env var absent and no key file', () => {
    const result = runGsdTools('config-ensure-section', tmpDir, { HOME: tmpDir, USERPROFILE: tmpDir, REF_API_KEY: '' });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.ref_search, false);
  });

  test('detects Ref Search from file-based key', () => {
    const gsdDir = path.join(tmpDir, '.gsd');
    fs.mkdirSync(gsdDir, { recursive: true });
    fs.writeFileSync(path.join(gsdDir, 'ref_api_key'), 'test-key', 'utf-8');

    const result = runGsdTools('config-ensure-section', tmpDir, { HOME: tmpDir, USERPROFILE: tmpDir, REF_API_KEY: '' });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.ref_search, true);
  });

  test('detects Perplexity from env var', () => {
    const result = runGsdTools('config-ensure-section', tmpDir, { HOME: tmpDir, USERPROFILE: tmpDir, PERPLEXITY_API_KEY: 'test-key' });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.perplexity, true);
  });

  test('perplexity is false when env var absent and no key file', () => {
    const result = runGsdTools('config-ensure-section', tmpDir, { HOME: tmpDir, USERPROFILE: tmpDir, PERPLEXITY_API_KEY: '' });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.perplexity, false);
  });

  test('detects Perplexity from file-based key', () => {
    const gsdDir = path.join(tmpDir, '.gsd');
    fs.mkdirSync(gsdDir, { recursive: true });
    fs.writeFileSync(path.join(gsdDir, 'perplexity_api_key'), 'test-key', 'utf-8');

    const result = runGsdTools('config-ensure-section', tmpDir, { HOME: tmpDir, USERPROFILE: tmpDir, PERPLEXITY_API_KEY: '' });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.perplexity, true);
  });

  test('detects Jina from env var', () => {
    const result = runGsdTools('config-ensure-section', tmpDir, { HOME: tmpDir, USERPROFILE: tmpDir, JINA_API_KEY: 'test-key' });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.jina, true);
  });

  test('jina is false when env var absent and no key file', () => {
    const result = runGsdTools('config-ensure-section', tmpDir, { HOME: tmpDir, USERPROFILE: tmpDir, JINA_API_KEY: '' });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.jina, false);
  });

  test('detects Jina from file-based key', () => {
    const gsdDir = path.join(tmpDir, '.gsd');
    fs.mkdirSync(gsdDir, { recursive: true });
    fs.writeFileSync(path.join(gsdDir, 'jina_api_key'), 'test-key', 'utf-8');

    const result = runGsdTools('config-ensure-section', tmpDir, { HOME: tmpDir, USERPROFILE: tmpDir, JINA_API_KEY: '' });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.jina, true);
  });

  test('merges user defaults from defaults.json', () => {
    // runGsdTools sandboxes HOME=tmpDir, so defaults.json is written there —
    // no real filesystem side effects, cleanup happens via afterEach.
    const gsdDir = path.join(tmpDir, '.gsd');
    fs.mkdirSync(gsdDir, { recursive: true });
    fs.writeFileSync(path.join(gsdDir, 'defaults.json'), JSON.stringify({
      model_profile: 'quality',
      commit_docs: false,
    }), 'utf-8');

    const result = runGsdTools('config-ensure-section', tmpDir, { HOME: tmpDir, USERPROFILE: tmpDir });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.model_profile, 'quality', 'model_profile should be overridden');
    assert.strictEqual(config.commit_docs, false, 'commit_docs should be overridden');
    assert.ok(config.git && typeof config.git === 'object', 'git should be an object');
    assert.strictEqual(typeof config.git.branching_strategy, 'string', 'git.branching_strategy should be a string');
  });

  test('merges nested workflow keys from defaults.json preserving unset keys', () => {
    // runGsdTools sandboxes HOME=tmpDir, so defaults.json is written there —
    // no real filesystem side effects, cleanup happens via afterEach.
    const gsdDir = path.join(tmpDir, '.gsd');
    fs.mkdirSync(gsdDir, { recursive: true });
    fs.writeFileSync(path.join(gsdDir, 'defaults.json'), JSON.stringify({
      workflow: { research: false },
    }), 'utf-8');

    const result = runGsdTools('config-ensure-section', tmpDir, { HOME: tmpDir, USERPROFILE: tmpDir });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.workflow.research, false, 'research should be overridden');
    assert.strictEqual(typeof config.workflow.plan_check, 'boolean', 'plan_check should be a boolean');
    assert.strictEqual(typeof config.workflow.verifier, 'boolean', 'verifier should be a boolean');
  });
});

// ─── config-get (home-resolved value) ──────────────────────────────────────────

describe('config-get command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    // Create config with known values — sandbox HOME to avoid global defaults
    runGsdTools('config-ensure-section', tmpDir, { HOME: tmpDir, USERPROFILE: tmpDir });
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('gets a top-level value', () => {
    const result = runGsdTools('config-get model_profile', tmpDir, { HOME: tmpDir, USERPROFILE: tmpDir });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output, 'balanced');
  });
});

// ─── config-new-project (home-resolved defaults) ───────────────────────────────

describe('config-new-project command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('creates full config with all expected keys', () => {
    const choices = JSON.stringify({
      mode: 'interactive',
      granularity: 'standard',
      parallelization: true,
      commit_docs: true,
      model_profile: 'balanced',
      workflow: { research: true, plan_check: true, verifier: true, nyquist_validation: true },
    });
    const result = runGsdTools(['config-new-project', choices], tmpDir, { HOME: tmpDir, USERPROFILE: tmpDir });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);

    // User choices present
    assert.strictEqual(config.mode, 'interactive');
    assert.strictEqual(config.granularity, 'standard');
    assert.strictEqual(config.parallelization, true);
    assert.strictEqual(config.commit_docs, true);
    assert.strictEqual(config.model_profile, 'balanced');

    // Defaults materialized — these were silently missing before
    assert.strictEqual(typeof config.search_gitignored, 'boolean');
    assert.strictEqual(typeof config.brave_search, 'boolean');

    // git section present with all three keys
    assert.ok(config.git && typeof config.git === 'object', 'git section should exist');
    assert.strictEqual(config.git.branching_strategy, 'none');
    assert.strictEqual(config.git.phase_branch_template, 'gsd/phase-{phase}-{slug}');
    assert.strictEqual(config.git.milestone_branch_template, 'gsd/{milestone}-{slug}');

    // workflow section present with all keys
    assert.ok(config.workflow && typeof config.workflow === 'object', 'workflow section should exist');
    assert.strictEqual(config.workflow.research, true);
    assert.strictEqual(config.workflow.plan_check, true);
    assert.strictEqual(config.workflow.verifier, true);
    assert.strictEqual(config.workflow.nyquist_validation, true);
    assert.strictEqual(config.workflow.auto_advance, false);
    assert.strictEqual(config.workflow.node_repair, true);
    assert.strictEqual(config.workflow.node_repair_budget, 2);
    assert.strictEqual(config.workflow.ui_phase, true);
    assert.strictEqual(config.workflow.ui_safety_gate, true);

    // hooks section present
    assert.ok(config.hooks && typeof config.hooks === 'object', 'hooks section should exist');
    assert.strictEqual(config.hooks.context_warnings, true);
  });

  test('user choices override defaults', () => {
    const choices = JSON.stringify({
      mode: 'yolo',
      granularity: 'coarse',
      parallelization: false,
      commit_docs: false,
      model_profile: 'quality',
      workflow: { research: false, plan_check: false, verifier: true, nyquist_validation: false },
    });
    const result = runGsdTools(['config-new-project', choices], tmpDir, { HOME: tmpDir, USERPROFILE: tmpDir });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.mode, 'yolo');
    assert.strictEqual(config.granularity, 'coarse');
    assert.strictEqual(config.parallelization, false);
    assert.strictEqual(config.commit_docs, false);
    assert.strictEqual(config.model_profile, 'quality');
    assert.strictEqual(config.workflow.research, false);
    assert.strictEqual(config.workflow.plan_check, false);
    assert.strictEqual(config.workflow.verifier, true);
    assert.strictEqual(config.workflow.nyquist_validation, false);
    // Defaults still present for non-chosen keys
    assert.strictEqual(config.git.branching_strategy, 'none');
    assert.strictEqual(typeof config.search_gitignored, 'boolean');
  });

  test('works with empty choices — all defaults materialized', () => {
    const result = runGsdTools(['config-new-project', '{}'], tmpDir, { HOME: tmpDir, USERPROFILE: tmpDir });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.model_profile, 'balanced');
    assert.strictEqual(config.commit_docs, true);
    assert.strictEqual(config.parallelization, true);
    assert.strictEqual(config.search_gitignored, false);
    assert.ok(config.git && typeof config.git === 'object');
    assert.strictEqual(config.git.branching_strategy, 'none');
    assert.ok(config.workflow && typeof config.workflow === 'object');
    assert.strictEqual(config.workflow.nyquist_validation, true);
    assert.strictEqual(config.workflow.auto_advance, false);
    assert.strictEqual(config.workflow.node_repair, true);
    assert.strictEqual(config.workflow.node_repair_budget, 2);
    assert.strictEqual(config.workflow.ui_phase, true);
    assert.strictEqual(config.workflow.ui_safety_gate, true);
    assert.ok(config.hooks && typeof config.hooks === 'object');
    assert.strictEqual(config.hooks.context_warnings, true);
  });
});

// ─── config-set-model-profile (home-resolved previous-profile detection) ──────

describe('config-set-model-profile command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    runGsdTools('config-ensure-section', tmpDir, { HOME: tmpDir, USERPROFILE: tmpDir });
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('reports previous profile in output', () => {
    const result = runGsdTools('config-set-model-profile budget', tmpDir, { HOME: tmpDir, USERPROFILE: tmpDir });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const out = JSON.parse(result.output);
    assert.strictEqual(out.previousProfile, 'balanced'); // default was balanced
    assert.strictEqual(out.profile, 'budget');
  });
});

// ─── skip_discuss in config-new-project (home-resolved defaults) ──────────────

describe('skip_discuss in config-new-project', () => {
  let emptyDir;

  beforeEach(() => {
    emptyDir = createTempProject();
  });

  afterEach(() => {
    cleanup(emptyDir);
  });

  test('skip_discuss is present in config-new-project output', () => {
    const result = runGsdTools(['config-new-project', '{}'], emptyDir, { HOME: emptyDir, USERPROFILE: emptyDir });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(emptyDir);
    assert.strictEqual(config.workflow.skip_discuss, false, 'skip_discuss should default to false');
  });

  test('skip_discuss can be set via config-new-project choices', () => {
    const choices = JSON.stringify({
      workflow: { skip_discuss: true },
    });
    const result = runGsdTools(['config-new-project', choices], emptyDir, { HOME: emptyDir, USERPROFILE: emptyDir });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(emptyDir);
    assert.strictEqual(config.workflow.skip_discuss, true);
  });
});
