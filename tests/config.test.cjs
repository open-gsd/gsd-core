/**
 * GSD Tools Tests - config.cjs
 *
 * CLI integration tests for config-ensure-section, config-set, and config-get
 * commands exercised through gsd-tools.cjs via execSync.
 *
 * Requirements: TEST-13
 */

const { test, describe, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { ERROR_REASON, formatDiagnosticToken } = require('../gsd-core/bin/lib/io.cjs');
const { VALID_PROFILES } = require('../gsd-core/bin/lib/model-profiles.cjs');
const { runGsdTools, runGsdToolsAsync, createTempDir, createTempProject, cleanup, delay, withIsolatedProcessState, homeSandboxEnv, mockPartialWriteThenThrow, suppressFdAsync } = require('./helpers.cjs');
const fc = require('./helpers/fast-check-setup.cjs');
const { defaultsStoreHome } = require('./helpers/defaults-store.cjs');
const configLib = require('../gsd-core/bin/lib/config.cjs');
const { ExitError } = require('../gsd-core/bin/lib/cli-exit.cjs');

// ─── ADR-612 PR-5: phase_id_convention enum validation ──────────────────────

describe('#3638: phase_id_convention config enum', () => {
  test('accepts sequential, milestone-prefixed, and bracket exactly', (t) => {
    const tmpDir = createTempProject('gsd-phase-id-convention-');
    t.after(() => cleanup(tmpDir));

    for (const convention of ['sequential', 'milestone-prefixed', 'bracket']) {
      const result = runGsdTools(['config-set', 'phase_id_convention', convention], tmpDir);
      assert.ok(result.success, `config-set phase_id_convention ${convention} failed: ${result.error}`);
      assert.equal(readConfig(tmpDir).phase_id_convention, convention);
    }
  });

  test('absent and null preserve the unset legacy behavior', (t) => {
    const tmpDir = createTempProject('gsd-phase-id-convention-');
    t.after(() => cleanup(tmpDir));
    assert.equal(
      fs.existsSync(path.join(tmpDir, '.planning', 'config.json')),
      false,
      'an absent config leaves the convention unset',
    );
    writeConfig(tmpDir, { phase_id_convention: 'bracket', model_profile: 'balanced' });

    const result = runGsdTools(['config-set', 'phase_id_convention', 'null'], tmpDir);
    assert.ok(result.success, `config-set phase_id_convention null failed: ${result.error}`);
    const config = readConfig(tmpDir);
    assert.equal(Object.hasOwn(config, 'phase_id_convention'), false);
    assert.equal(config.model_profile, 'balanced', 'unsetting the convention must preserve sibling config');
  });

  test('rejects unsupported and case-mismatched values with the supported set', (t) => {
    const tmpDir = createTempProject('gsd-phase-id-convention-');
    t.after(() => cleanup(tmpDir));

    for (const value of ['free-form', 'Bracket']) {
      const result = runGsdTools(['config-set', 'phase_id_convention', value], tmpDir);
      assert.equal(result.success, false, `${value} must be rejected`);
      assert.match(result.error, /Invalid phase_id_convention/);
      assert.match(result.error, /sequential, milestone-prefixed, bracket/);
    }
  });

  test('sequential remains valid configuration but is not a roadmap-upgrade target', (t) => {
    const tmpDir = createTempProject('gsd-phase-id-convention-');
    t.after(() => cleanup(tmpDir));

    const configResult = runGsdTools(['config-set', 'phase_id_convention', 'sequential'], tmpDir);
    assert.ok(configResult.success, `sequential config failed: ${configResult.error}`);

    const migrationResult = runGsdTools(
      ['roadmap', 'upgrade', '--convention', 'sequential', '--dry-run'],
      tmpDir,
    );
    assert.equal(migrationResult.success, false, 'sequential must not become a migration target');
    assert.match(migrationResult.error, /Only --convention milestone-prefixed or bracket is supported/);
  });
});

// ─── helpers ──────────────────────────────────────────────────────────────────

function readConfig(tmpDir) {
  const configPath = path.join(tmpDir, '.planning', 'config.json');
  return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
}

function writeConfig(tmpDir, obj) {
  const configPath = path.join(tmpDir, '.planning', 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(obj, null, 2), 'utf-8');
}

async function runConfigEnsureSectionWithRetry(tmpDir, attempts = 4) {
  let last;
  for (let i = 0; i < attempts; i += 1) {
    last = runGsdTools('config-ensure-section', tmpDir);
    if (last.success) return last;

    const detail = `${last.error || ''}\n${last.output || ''}`;
    const transient = /(EPERM|EBUSY|EACCES|ENOTEMPTY|resource busy|used by another process|permission denied)/i.test(detail);
    if (!transient || i === attempts - 1) return last;
    await delay(150 * (i + 1));
  }
  return last;
}

/**
 * Seed `.planning/config.json` for a test and guarantee it lands on disk
 * before the test body runs.
 *
 * `config-ensure-section` is invoked through a spawned `gsd-tools.cjs` child.
 * On the scoped CI lane (`--test-concurrency=4`, config.test.cjs scheduled
 * alongside the heavy install/tarball suites) that child can be transiently
 * killed under resource pressure — surfacing as a non-zero exit with empty
 * stderr (an OS-level kill, not a gsd-tools application error; see the
 * `runGsdTools` catch). A bare `runGsdTools('config-ensure-section')` in
 * `beforeEach` swallows that failure, leaving config.json absent so the first
 * subtest's `readConfig()` throws a confusing ENOENT (#770 scoped-lane flake).
 *
 * This retries on ANY failure or missing file (not just the EPERM/EBUSY class
 * `runConfigEnsureSectionWithRetry` covers) and throws a clear diagnostic if it
 * still cannot create the file, so setup is deterministic under load.
 */
async function ensureConfigReady(tmpDir, attempts = 5) {
  const configPath = path.join(tmpDir, '.planning', 'config.json');
  let last;
  for (let i = 0; i < attempts; i += 1) {
    last = runGsdTools('config-ensure-section', tmpDir);
    if (last.success && fs.existsSync(configPath)) return last;
    if (i < attempts - 1) await delay(150 * (i + 1));
  }
  throw new Error(
    `config-ensure-section failed to create ${configPath} after ${attempts} attempts: ` +
      `${(last && last.error) || 'unknown error'}`,
  );
}

/**
 * Seed `.planning/config.json` with both OS home variables pointed at the
 * project dir through homeSandboxEnv, so the seed never inherits the
 * developer's `~/.gsd/defaults.json` (#5016). Every `beforeEach` seed whose
 * tests assert values a global defaults file can override goes through here,
 * so the #5016 regression case below guards all of them at once.
 */
function seedProjectConfig(dir) {
  return runGsdTools('config-ensure-section', dir, homeSandboxEnv(dir));
}

// ─── config-ensure-section ───────────────────────────────────────────────────

describe('config-ensure-section command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('creates config.json with expected structure and types', () => {
    const result = runGsdTools('config-ensure-section', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.created, true);

    const config = readConfig(tmpDir);
    // Verify structure and types — exact values may vary if ~/.gsd/defaults.json exists
    assert.strictEqual(typeof config.model_profile, 'string');
    assert.strictEqual(typeof config.commit_docs, 'boolean');
    assert.strictEqual(typeof config.parallelization, 'boolean');
    assert.ok(config.git && typeof config.git === 'object', 'git should be an object');
    assert.strictEqual(typeof config.git.branching_strategy, 'string');
    assert.ok(config.workflow && typeof config.workflow === 'object', 'workflow should be an object');
    assert.strictEqual(typeof config.workflow.research, 'boolean');
    assert.strictEqual(typeof config.workflow.plan_check, 'boolean');
    assert.strictEqual(typeof config.workflow.verifier, 'boolean');
    assert.strictEqual(typeof config.workflow.nyquist_validation, 'boolean');
    // These hardcoded defaults are always present (may be overridden by user defaults)
    assert.ok('model_profile' in config, 'model_profile should exist');
    assert.ok('brave_search' in config, 'brave_search should exist');
    assert.ok('search_gitignored' in config, 'search_gitignored should exist');
  });

  test('is idempotent — returns already_exists on second call', async () => {
    const first = await runConfigEnsureSectionWithRetry(tmpDir);
    assert.ok(first.success, `First call failed: ${first.error}`);
    const firstOutput = JSON.parse(first.output);
    assert.strictEqual(firstOutput.created, true);

    const second = await runConfigEnsureSectionWithRetry(tmpDir);
    assert.ok(second.success, `Second call failed: ${second.error}`);
    const secondOutput = JSON.parse(second.output);
    assert.strictEqual(secondOutput.created, false);
    assert.strictEqual(secondOutput.reason, 'already_exists');
  });

});

// ─── config-set ──────────────────────────────────────────────────────────────

describe('config-set command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    seedProjectConfig(tmpDir);
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('sets a top-level string value', () => {
    const result = runGsdTools('config-set model_profile quality', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.updated, true);
    assert.strictEqual(output.key, 'model_profile');
    assert.strictEqual(output.value, 'quality');

    const config = readConfig(tmpDir);
    assert.strictEqual(config.model_profile, 'quality');
  });

  test('coerces true to boolean', () => {
    const result = runGsdTools('config-set commit_docs true', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.commit_docs, true);
    assert.strictEqual(typeof config.commit_docs, 'boolean');
  });

  test('coerces false to boolean', () => {
    const result = runGsdTools('config-set commit_docs false', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.commit_docs, false);
    assert.strictEqual(typeof config.commit_docs, 'boolean');
  });

  test('coerces numeric strings to numbers', () => {
    const result = runGsdTools('config-set granularity 42', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.granularity, 42);
    assert.strictEqual(typeof config.granularity, 'number');
  });

  test('preserves plain strings', () => {
    const result = runGsdTools('config-set model_profile hello', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.model_profile, 'hello');
    assert.strictEqual(typeof config.model_profile, 'string');
  });

  test('sets nested values via dot-notation', () => {
    const result = runGsdTools('config-set workflow.research false', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.workflow.research, false);
  });

  test('auto-creates nested objects for dot-notation', () => {
    // Start with empty config
    writeConfig(tmpDir, {});

    const result = runGsdTools('config-set workflow.research false', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.workflow.research, false);
    assert.strictEqual(typeof config.workflow, 'object');
  });

  test('rejects unknown config keys', () => {
    const result = runGsdTools('config-set workflow.nyquist_validation_enabled false', tmpDir);
    assert.strictEqual(result.success, false);
    assert.ok(
      result.error.includes('Unknown config key'),
      `Expected "Unknown config key" in error: ${result.error}`
    );
  });

  test('sets workflow.text_mode for remote session support', () => {
    writeConfig(tmpDir, {});

    const result = runGsdTools('config-set workflow.text_mode true', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.workflow.text_mode, true);
  });

  test('sets workflow.use_worktrees to disable worktree isolation', () => {
    writeConfig(tmpDir, {});

    const result = runGsdTools('config-set workflow.use_worktrees false', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.workflow.use_worktrees, false);
  });

  test('sets git.base_branch for non-main default branches', () => {
    writeConfig(tmpDir, {});

    const result = runGsdTools('config-set git.base_branch master', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.git.base_branch, 'master');
  });

  test('sets intel.enabled to opt into the intel subsystem', () => {
    writeConfig(tmpDir, {});

    const result = runGsdTools('config-set intel.enabled true', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.intel.enabled, true);
  });

  test('errors when no key path provided', () => {
    const result = runGsdTools('config-set', tmpDir);
    assert.strictEqual(result.success, false);
  });

  test('rejects known invalid nyquist alias keys with a suggestion', () => {
    const result = runGsdTools('config-set workflow.nyquist_validation_enabled false', tmpDir);
    assert.strictEqual(result.success, false);
    assert.match(result.error, /Unknown config key: workflow\.nyquist_validation_enabled/);
    assert.match(result.error, /workflow\.nyquist_validation/);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.workflow.nyquist_validation_enabled, undefined);
    assert.strictEqual(config.workflow.nyquist_validation, true);
  });
});

// ─── config-set git.protected_branches (#3552) ──────────────────────────────

describe('config-set git.protected_branches (#3552)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    seedProjectConfig(tmpDir);
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('accepts and persists multiple non-empty branch names', () => {
    const branches = ['develop', 'next'];
    const result = runGsdTools(
      ['config-set', 'git.protected_branches', JSON.stringify(branches)],
      tmpDir,
    );

    assert.ok(result.success, `Command failed: ${result.error}`);
    assert.deepStrictEqual(readConfig(tmpDir).git.protected_branches, branches);
  });

  test('rejects invalid shapes and preserves the previous list', () => {
    const previous = ['develop', 'next'];
    const seed = runGsdTools(
      ['config-set', 'git.protected_branches', JSON.stringify(previous)],
      tmpDir,
    );
    assert.ok(seed.success, `Seed failed: ${seed.error}`);

    const invalidValues = [
      'develop',
      { develop: true },
      ['develop', 42],
      [],
      [''],
      ['develop', '   '],
    ];

    for (const invalidValue of invalidValues) {
      const result = runGsdTools(
        ['config-set', 'git.protected_branches', JSON.stringify(invalidValue)],
        tmpDir,
      );
      assert.strictEqual(
        result.success,
        false,
        `Expected rejection for ${JSON.stringify(invalidValue)}, got: ${result.output}`,
      );
      assert.deepStrictEqual(
        readConfig(tmpDir).git.protected_branches,
        previous,
        `Rejected value ${JSON.stringify(invalidValue)} must not change the prior list`,
      );
    }
  });

  test('is absent by default and null removes the configured list', () => {
    assert.ok(
      !Object.prototype.hasOwnProperty.call(readConfig(tmpDir).git, 'protected_branches'),
      'config-ensure-section must not add a protected_branches default',
    );

    const setResult = runGsdTools(
      ['config-set', 'git.protected_branches', '["develop","next"]'],
      tmpDir,
    );
    assert.ok(setResult.success, `Set failed: ${setResult.error}`);

    const unsetResult = runGsdTools(
      ['config-set', 'git.protected_branches', 'null'],
      tmpDir,
    );
    assert.ok(unsetResult.success, `Unset failed: ${unsetResult.error}`);
    assert.ok(
      !Object.prototype.hasOwnProperty.call(readConfig(tmpDir).git, 'protected_branches'),
      'git.protected_branches must be absent after unset',
    );
  });

  test('#5016: the seed ignores protected_branches in the ambient ~/.gsd/defaults.json', (t) => {
    const ambientHome = createTempDir('gsd-5016-ambient-home-');
    t.after(() => cleanup(ambientHome));
    fs.mkdirSync(path.join(ambientHome, '.gsd'));
    fs.writeFileSync(
      path.join(ambientHome, '.gsd', 'defaults.json'),
      JSON.stringify({ git: { protected_branches: ['release'] } }),
    );
    const controlDir = createTempProject();
    const seededDir = createTempProject();
    t.after(() => { cleanup(controlDir); cleanup(seededDir); });

    const [control, seeded] = withIsolatedProcessState(() => {
      Object.assign(process.env, homeSandboxEnv(ambientHome));
      return [runGsdTools('config-ensure-section', controlDir), seedProjectConfig(seededDir)];
    });

    // Positive control: an unsandboxed seed must pick up the canary, or the
    // assertion below would pass without proving anything.
    assert.ok(control.success, `Control seed failed: ${control.error}`);
    assert.deepStrictEqual(readConfig(controlDir).git.protected_branches, ['release']);
    assert.ok(seeded.success, `Seed failed: ${seeded.error}`);
    assert.ok(
      !Object.prototype.hasOwnProperty.call(readConfig(seededDir).git, 'protected_branches'),
      'seedProjectConfig must not inherit protected_branches from the ambient defaults.json',
    );
  });
});

// ─── config-get ──────────────────────────────────────────────────────────────

describe('config-get command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    // Create config with known values — sandbox HOME to avoid global defaults
    runGsdTools('config-ensure-section', tmpDir, homeSandboxEnv(tmpDir));
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('gets a top-level value', () => {
    const result = runGsdTools('config-get model_profile', tmpDir, homeSandboxEnv(tmpDir));
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output, 'balanced');
  });

  test('gets a nested value via dot-notation', () => {
    const result = runGsdTools('config-get workflow.research', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output, true);
  });

  test('errors for nonexistent key', () => {
    const result = runGsdTools('config-get nonexistent_key', tmpDir);
    assert.strictEqual(result.success, false);
    assert.ok(
      result.error.includes('Key not found'),
      `Expected "Key not found" in error: ${result.error}`
    );
  });

  test('errors for deeply nested nonexistent key', () => {
    const result = runGsdTools('config-get workflow.nonexistent', tmpDir);
    assert.strictEqual(result.success, false);
    assert.ok(
      result.error.includes('Key not found'),
      `Expected "Key not found" in error: ${result.error}`
    );
  });

  describe('when config.json does not exist', () => {
    let emptyTmpDir;

    beforeEach(() => {
      emptyTmpDir = createTempProject();
    });

    afterEach(() => {
      cleanup(emptyTmpDir);
    });

    test('errors when config.json does not exist', () => {
      const result = runGsdTools('config-get model_profile', emptyTmpDir);
      assert.strictEqual(result.success, false);
      assert.ok(
        result.error.includes('No config.json'),
        `Expected "No config.json" in error: ${result.error}`
      );
    });
  });

  test('gets git.base_branch after it is set', () => {
    runGsdTools('config-set git.base_branch master', tmpDir);
    const result = runGsdTools('config-get git.base_branch', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output, 'master');
  });

  test('errors for git.base_branch when not explicitly set', () => {
    // Default config from config-ensure-section does not include git.base_branch,
    // so config-get should return "Key not found" — this triggers auto-detect
    // fallback in the workflow (origin/HEAD detection).
    const result = runGsdTools('config-get git.base_branch', tmpDir);
    assert.strictEqual(result.success, false);
    assert.ok(
      result.error.includes('Key not found'),
      `Expected "Key not found" in error: ${result.error}`
    );
  });

  test('errors when no key path provided', () => {
    const result = runGsdTools('config-get', tmpDir);
    assert.strictEqual(result.success, false);
  });
});

// ─── config-new-project ───────────────────────────────────────────────────────

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
    const result = runGsdTools(['config-new-project', choices], tmpDir, homeSandboxEnv(tmpDir));
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
    const result = runGsdTools(['config-new-project', choices], tmpDir, homeSandboxEnv(tmpDir));
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
    const result = runGsdTools(['config-new-project', '{}'], tmpDir, homeSandboxEnv(tmpDir));
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

  test('is idempotent — returns already_exists if config exists', () => {
    const choices = JSON.stringify({ mode: 'yolo', granularity: 'fine' });

    const first = runGsdTools(['config-new-project', choices], tmpDir);
    assert.ok(first.success, `First call failed: ${first.error}`);
    const firstOut = JSON.parse(first.output);
    assert.strictEqual(firstOut.created, true);

    const second = runGsdTools(['config-new-project', choices], tmpDir);
    assert.ok(second.success, `Second call failed: ${second.error}`);
    const secondOut = JSON.parse(second.output);
    assert.strictEqual(secondOut.created, false);
    assert.strictEqual(secondOut.reason, 'already_exists');

    // Config unchanged
    const config = readConfig(tmpDir);
    assert.strictEqual(config.mode, 'yolo');
    assert.strictEqual(config.granularity, 'fine');
  });

  test('auto_advance in workflow choices is preserved', () => {
    const choices = JSON.stringify({
      mode: 'yolo',
      granularity: 'standard',
      workflow: { research: true, plan_check: true, verifier: true, nyquist_validation: true, auto_advance: true },
    });
    const result = runGsdTools(['config-new-project', choices], tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.workflow.auto_advance, true);
  });

  test('rejects invalid JSON choices', () => {
    const result = runGsdTools(['config-new-project', '{not-json}'], tmpDir);
    assert.strictEqual(result.success, false);
    assert.ok(result.error.includes('Invalid JSON'), `Expected "Invalid JSON" in: ${result.error}`);
  });

  test('output has created:true and path on success', () => {
    const choices = JSON.stringify({ mode: 'interactive', granularity: 'standard' });
    const result = runGsdTools(['config-new-project', choices], tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const out = JSON.parse(result.output);
    assert.strictEqual(out.created, true);
    assert.strictEqual(out.path, '.planning/config.json');
  });
});

// ─── config-new-project validates choices like config-set (#5268) ────────────

describe('config-new-project — refuses what config-set refuses (#5268)', () => {
  const repoRoot = path.resolve(__dirname, '..');
  let dirs;

  beforeEach(() => { dirs = []; });
  afterEach(() => { dirs.forEach((dir) => cleanup(dir)); });

  // A bare directory: no .planning/, so a refusal that created anything shows.
  function bareDir() {
    const dir = createTempDir();
    dirs.push(dir);
    return dir;
  }

  function projectDir() {
    const dir = createTempProject();
    dirs.push(dir);
    return dir;
  }

  function newProject(args, dir) {
    return runGsdTools(['config-new-project', ...args], dir, homeSandboxEnv(dir));
  }

  function assertNothingWritten(dir) {
    assert.strictEqual(fs.existsSync(path.join(dir, '.planning')), false, '.planning must not be created');
  }

  function readProjectConfig(dir) {
    return JSON.parse(fs.readFileSync(path.join(dir, '.planning', 'config.json'), 'utf-8'));
  }

  function nest(keyPath, value) {
    return keyPath.split('.').reduceRight((inner, segment) => ({ [segment]: inner }), value);
  }

  function isSection(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function leafPaths(obj, prefix = '') {
    return Object.keys(obj).flatMap((key) => {
      const keyPath = prefix ? `${prefix}.${key}` : key;
      return isSection(obj[key]) && Object.keys(obj[key]).length > 0 ? leafPaths(obj[key], keyPath) : [keyPath];
    });
  }

  function valueAt(obj, keyPath) {
    return keyPath.split('.').reduce((node, segment) => (node == null ? undefined : node[segment]), obj);
  }

  function stringLeaves(value) {
    if (typeof value === 'string') return [value];
    if (value !== null && typeof value === 'object') return Object.values(value).flatMap(stringLeaves);
    return [];
  }

  // `cli` is the value as typed to config-set, `json` the same value as it
  // arrives in a choices object. Every row is refused by config-set.
  const REFUSED_BY_CONFIG_SET = [
    { key: 'bogus_key', cli: 'x', json: 'x' },
    { key: 'workflow.reserch', cli: 'true', json: true },
    { key: 'workflow.nyquist_validation_enabled', cli: 'true', json: true },
    { key: 'mode', cli: 'nonsense', json: 'nonsense' },
    { key: 'mode', cli: '[yolo|interactive]', json: '[yolo|interactive]' },
    { key: 'context', cli: 'prod', json: 'prod' },
    { key: 'context_window', cli: '0', json: 0 },
    { key: 'workflow.research', cli: 'maybe', json: 'maybe' },
    { key: 'workflow.compact_content', cli: 'maybe', json: 'maybe' },
    { key: 'workflow.code_review_depth', cli: 'weird', json: 'weird' },
    { key: 'workflow.human_verify_mode', cli: 'never', json: 'never' },
    { key: 'workflow.security_asvs_level', cli: '9', json: 9 },
    { key: 'workflow.drift_threshold', cli: '0', json: 0 },
    { key: 'git.create_tag', cli: 'yes', json: 'yes' },
    { key: 'hooks.context_warning_threshold', cli: '0', json: 0 },
    { key: 'plan_review.source_grounding_authority', cli: 'bogus', json: 'bogus' },
    { key: 'statusline.state_format', cli: 'wide', json: 'wide' },
    // Passes the key gate (agent_skills.<agent-type>); refused by the setter's guard.
    { key: 'agent_skills.__proto__', cli: 'true', json: true },
  ];

  for (const { key, cli, json } of REFUSED_BY_CONFIG_SET) {
    test(`${key}=${cli} is refused with config-set's own error and nothing is written`, () => {
      const viaSet = runGsdTools(['config-set', key, cli], projectDir());
      assert.strictEqual(viaSet.success, false, `positive control: config-set must refuse ${key}=${cli}`);

      const dir = bareDir();
      const viaNewProject = newProject([JSON.stringify(nest(key, json))], dir);

      assert.strictEqual(viaNewProject.success, false, `config-new-project wrote ${key}=${cli}`);
      assert.strictEqual(viaNewProject.error, viaSet.error);
      assertNothingWritten(dir);
    });
  }

  // A null choice is checked against the setter's segment guard too. config-set
  // reaches that guard only through a section that exists: a config with no
  // agent_skills section leaves it nothing to unset, and after its known-key
  // check it reports the no-op without reaching the guard. The default config
  // has the section, so the oracle is config-set run against one.
  for (const segment of ['__proto__', 'prototype', 'constructor']) {
    const key = `agent_skills.${segment}`;
    test(`${key}=null is refused with config-set's own error and nothing is written`, () => {
      const created = bareDir();
      assert.ok(newProject(['{}'], created).success, 'seed: a default config');
      assert.deepStrictEqual(readProjectConfig(created).agent_skills, {}, 'seed: the section config-set walks');
      const viaSet = runGsdTools(['config-set', key, 'null'], created);
      assert.strictEqual(viaSet.success, false, `positive control: config-set must refuse ${key}=null`);

      const dir = bareDir();
      const viaNewProject = newProject([JSON.stringify(nest(key, null))], dir);

      assert.strictEqual(viaNewProject.success, false, `config-new-project accepted ${key}=null`);
      assert.strictEqual(viaNewProject.error, viaSet.error);
      assertNothingWritten(dir);
    });
  }

  // config-set stores project_code as the text typed (#1581), so a code is a
  // string; a JSON number is a type it can never store.
  test('a project_code that is not a string is refused; a string is written as given', () => {
    const refused = bareDir();
    const result = newProject([JSON.stringify({ project_code: 7 })], refused);
    assert.strictEqual(result.success, false);
    assert.match(result.error, /Invalid project_code '7'\. Must be a string/);
    assertNothingWritten(refused);

    const accepted = bareDir();
    assert.ok(newProject([JSON.stringify({ project_code: '007' })], accepted).success);
    assert.strictEqual(readProjectConfig(accepted).project_code, '007');
  });

  // Both sides of every numeric limit: the last refused value, the first
  // accepted one, and the step past it (limit-1 / limit / limit+1), on each
  // end the rule has. Every row asserts config-set's verdict first, so the
  // expected column is checked against the oracle, not just against itself.
  const BOUNDARIES = [
    ['hooks.context_warning_threshold', [[-1, false], [0, false], [1, true], [99, true], [100, true], [101, false]]],
    ['workflow.security_asvs_level', [[0, false], [1, true], [2, true], [3, true], [4, false]]],
    ['context_window', [[0, false], [1, true], [2, true]]],
    ['workflow.drift_threshold', [[0, false], [1, true], [2, true]]],
  ];

  for (const [keyPath, rows] of BOUNDARIES) {
    for (const [value, accepted] of rows) {
      test(`${keyPath}=${value} is ${accepted ? 'accepted' : 'refused'} exactly as config-set ${accepted ? 'accepts' : 'refuses'} it`, () => {
        const viaSet = runGsdTools(['config-set', keyPath, String(value)], projectDir());
        assert.strictEqual(viaSet.success, accepted, `oracle: config-set ${accepted ? 'refused' : 'accepted'} ${keyPath}=${value}`);

        const dir = bareDir();
        const result = newProject([JSON.stringify(nest(keyPath, value))], dir);

        assert.strictEqual(result.success, accepted, result.error);
        if (accepted) {
          assert.strictEqual(valueAt(readProjectConfig(dir), keyPath), value);
        } else {
          assert.strictEqual(result.error, viaSet.error);
          assertNothingWritten(dir);
        }
      });
    }
  }

  test('one bad key among valid choices refuses the whole payload', () => {
    const dir = bareDir();
    const result = newProject([JSON.stringify({ mode: 'yolo', workflow: { research: true }, bogus_key: 'x' })], dir);

    assert.strictEqual(result.success, false);
    assert.match(result.error, /Unknown config key: "bogus_key"/);
    assertNothingWritten(dir);
  });

  test('a value config-set normalizes is written normalized', () => {
    const dir = bareDir();
    const result = newProject([JSON.stringify({ review: { default_reviewers: ['Codex', 'codex', 'gemini'] } })], dir);

    assert.ok(result.success, `Command failed: ${result.error}`);
    assert.deepStrictEqual(readProjectConfig(dir).review.default_reviewers, ['codex', 'gemini']);
  });

  for (const choices of ['["mode"]', '"yolo"', '42', 'null']) {
    test(`choices that are not a JSON object are refused: ${choices}`, () => {
      const dir = bareDir();
      const result = newProject([choices], dir);

      assert.strictEqual(result.success, false);
      assert.match(result.error, /expected a JSON object/);
      assertNothingWritten(dir);
    });
  }

  for (const choices of ['{"":{"mode":"yolo"}}', '{"":"x"}', '{"workflow":{"":true}}']) {
    test(`an empty key is refused instead of being walked as a nameless section: ${choices}`, () => {
      const dir = bareDir();
      const result = newProject([choices], dir);

      assert.strictEqual(result.success, false);
      assert.match(result.error, /^Error: Unknown config key: "(workflow\.)?"/);
      assertNothingWritten(dir);
    });
  }

  // A dot that spells a deeper path: at the top level, under a section, and
  // under a setting that is also a parent of per-reviewer settings.
  const STRUCTURAL_DOTTED_KEYS = [
    { choices: { 'workflow.research': false }, key: 'workflow.research' },
    { choices: { code_quality: { 'fallow.scope': 'phase' } }, key: 'fallow.scope' },
    { choices: { review: { 'max_prompt_tokens_per_reviewer.codex': 5000 } }, key: 'max_prompt_tokens_per_reviewer.codex' },
    { choices: { claude_md_assembly: { 'blocks.workflow': 'link' } }, key: 'blocks.workflow' },
  ];

  for (const { choices, key } of STRUCTURAL_DOTTED_KEYS) {
    test(`a dotted key is refused instead of being written as one literal key: ${key}`, () => {
      const dir = bareDir();
      const result = newProject([JSON.stringify(choices)], dir);

      assert.strictEqual(result.success, false);
      assert.ok(result.error.startsWith(`Error: Invalid choice key "${key}"`), result.error);
      assertNothingWritten(dir);
    });
  }

  test('a decimal phase id keeps its dot: phase_commit_docs is keyed by the literal id', () => {
    const dir = bareDir();
    const result = newProject([JSON.stringify({ phase_commit_docs: { '2.1': true, '03': false } })], dir);

    assert.ok(result.success, `Command failed: ${result.error}`);
    assert.deepStrictEqual(readProjectConfig(dir).phase_commit_docs, { '2.1': true, '03': false });
  });

  // agent_tools is a setting AND the top level of the agent_tools.<selector>
  // family, so its entries are keys and each is checked, as config-set checks
  // `agent_tools.<selector>`.
  test('agent_tools entries are checked as agent_tools.<selector> keys', () => {
    const viaSet = runGsdTools(['config-set', 'agent_tools.$bad', '[]'], projectDir());
    assert.strictEqual(viaSet.success, false, 'positive control: config-set must refuse agent_tools.$bad');

    const refused = bareDir();
    const result = newProject([JSON.stringify({ agent_tools: { $bad: [] } })], refused);
    assert.strictEqual(result.success, false, 'an invalid agent_tools selector was written');
    assert.strictEqual(result.error, viaSet.error);
    assertNothingWritten(refused);

    const accepted = bareDir();
    assert.ok(newProject([JSON.stringify({ agent_tools: { 'gsd-executor': ['Read'], '*': [] } })], accepted).success);
    assert.deepStrictEqual(readProjectConfig(accepted).agent_tools, { 'gsd-executor': ['Read'], '*': [] });
  });

  test('a setting that is also a parent is walked, not accepted whole', () => {
    const accepted = bareDir();
    const perReviewer = { review: { max_prompt_tokens_per_reviewer: { codex: 5000 } } };
    assert.ok(newProject([JSON.stringify(perReviewer)], accepted).success);
    assert.deepStrictEqual(readProjectConfig(accepted).review, perReviewer.review);

    const refused = bareDir();
    const result = newProject([JSON.stringify({ review: { max_prompt_tokens_per_reviewer: { not_a_reviewer: 5000 } } })], refused);
    assert.strictEqual(result.success, false);
    assert.match(result.error, /Unknown config key: "review\.max_prompt_tokens_per_reviewer\.not_a_reviewer"/);
    assertNothingWritten(refused);
  });

  // config-set refuses `bogus_section '{}'` as an unknown key; an empty object
  // under a name that is not a section is refused the same way, at any depth.
  for (const [choices, key] of [
    [{ bogus_section: {} }, 'bogus_section'],
    [{ bogus_parent: { inner: { innermost: {} } } }, 'bogus_parent.inner.innermost'],
    [{ workflow: { bogus: {} } }, 'workflow.bogus'],
  ]) {
    test(`an empty object under an unknown name is refused: ${key}`, () => {
      const viaSet = runGsdTools(['config-set', key, '{}'], projectDir());
      assert.strictEqual(viaSet.success, false, `positive control: config-set must refuse ${key}={}`);

      const dir = bareDir();
      const result = newProject([JSON.stringify(choices)], dir);

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.error, viaSet.error);
      assertNothingWritten(dir);
    });
  }

  test('an empty object under a real section sets nothing', () => {
    const baselineDir = bareDir();
    assert.ok(newProject(['{}'], baselineDir).success);

    const dir = bareDir();
    const result = newProject([JSON.stringify({ workflow: {}, agent_skills: {}, agent_tools: {}, review: { max_prompt_tokens_per_reviewer: {} } })], dir);

    assert.ok(result.success, `Command failed: ${result.error}`);
    assert.deepStrictEqual(readProjectConfig(dir), readProjectConfig(baselineDir));
  });

  for (const value of ['x', true, 3, null, ['research']]) {
    test(`a section given ${JSON.stringify(value)} is refused as a section, not as an unknown key`, () => {
      const dir = bareDir();
      const result = newProject([JSON.stringify({ workflow: value })], dir);

      assert.strictEqual(result.success, false);
      assert.ok(result.error.startsWith('Error: Invalid choice "workflow" for config-new-project: it is a section'), result.error);
      assertNothingWritten(dir);
    });
  }

  test('an unsupported flag is refused and nothing is written', () => {
    const dir = bareDir();
    const result = newProject([JSON.stringify({ mode: 'yolo' }), '--force'], dir);

    assert.strictEqual(result.success, false);
    assert.match(result.error, /Unknown flag for config-new-project: --force/);
    assertNothingWritten(dir);
  });

  // Positional count: none (defaults only) and one are accepted; two is
  // refused (below). A flag alone counts as no positional.
  for (const args of [[], ['--dry-run']]) {
    test(`no choices argument${args.length ? ' with --dry-run alone' : ''} builds the defaults-only config`, () => {
      const baselineDir = bareDir();
      assert.ok(newProject(['{}'], baselineDir).success);
      const baseline = readProjectConfig(baselineDir);

      const dir = bareDir();
      const result = newProject(args, dir);

      assert.ok(result.success, `Command failed: ${result.error}`);
      if (args.includes('--dry-run')) {
        assertNothingWritten(dir);
        assert.strictEqual(JSON.parse(result.output).config.workflow.research, baseline.workflow.research);
      } else {
        assert.deepStrictEqual(readProjectConfig(dir), baseline);
      }
    });
  }

  // A flag is a dash followed by a letter; any other dash-led token is the
  // choices argument and is held to the choices rules.
  for (const [arg, message] of [['-1', /expected a JSON object/], ['-', /Invalid JSON for config-new-project/], ['-x', /Unknown flag for config-new-project: -x/]]) {
    test(`${arg} is ${message.source.startsWith('Unknown flag') ? 'refused as an unknown flag' : 'read as the choices argument'}`, () => {
      const dir = bareDir();
      const result = newProject([arg], dir);

      assert.strictEqual(result.success, false);
      assert.match(result.error, message);
      assertNothingWritten(dir);
    });
  }

  test('a second positional argument is refused and nothing is written', () => {
    const dir = bareDir();
    const result = newProject([JSON.stringify({ mode: 'yolo' }), JSON.stringify({ mode: 'interactive' })], dir);

    assert.strictEqual(result.success, false);
    assert.match(result.error, /Unexpected argument for config-new-project/);
    assertNothingWritten(dir);
  });

  for (const flagFirst of [false, true]) {
    test(`--dry-run ${flagFirst ? 'before' : 'after'} the choices prints the config and writes nothing`, () => {
      const choices = JSON.stringify({ mode: 'yolo', workflow: { research: false } });
      const dir = bareDir();
      const preview = newProject(flagFirst ? ['--dry-run', choices] : [choices, '--dry-run'], dir);

      assert.ok(preview.success, `Command failed: ${preview.error}`);
      assertNothingWritten(dir);
      const out = JSON.parse(preview.output);
      assert.strictEqual(out.dry_run, true);
      assert.strictEqual(out.would_create, true);
      assert.strictEqual(out.config.mode, 'yolo');
      assert.strictEqual(out.config.workflow.research, false);

      // The preview is the config a real run then writes. Secret keys are
      // masked in CLI output, so they are compared as masked.
      const created = newProject([choices], dir);
      assert.ok(created.success, `Command failed: ${created.error}`);
      const written = readProjectConfig(dir);
      for (const secretKey of ['brave_search', 'firecrawl', 'exa_search']) {
        assert.strictEqual(out.config[secretKey], '****');
        written[secretKey] = '****';
      }
      assert.deepStrictEqual(out.config, written);
    });
  }

  test('--raw --dry-run prints the text form and writes nothing', () => {
    const dir = bareDir();
    const result = newProject([JSON.stringify({ mode: 'yolo' }), '--raw', '--dry-run'], dir);

    assert.ok(result.success, `Command failed: ${result.error}`);
    assert.strictEqual(result.output, 'would create (dry run)');
    assertNothingWritten(dir);
  });

  test('--dry-run masks a secret choice exactly as config-set --dry-run masks it, and never prints it', () => {
    const viaSet = runGsdTools(['config-set', 'brave_search', 'SECRETVAL', '--dry-run'], projectDir());
    assert.ok(viaSet.success, `positive control: ${viaSet.error}`);
    const maskedBySet = JSON.parse(viaSet.output).value;
    assert.notStrictEqual(maskedBySet, 'SECRETVAL', 'positive control: config-set must mask the value');

    const dir = bareDir();
    const preview = newProject([JSON.stringify({ brave_search: 'SECRETVAL' }), '--dry-run'], dir);

    assert.ok(preview.success, `Command failed: ${preview.error}`);
    assert.strictEqual(preview.output.includes('SECRETVAL'), false, 'the plaintext secret reached the preview');
    assert.strictEqual(JSON.parse(preview.output).config.brave_search, maskedBySet);
    assertNothingWritten(dir);
  });

  // Choices are JSON-typed: config-set parses the text "true" to a boolean and
  // "5" to a number, while a JSON string stays a string and is held to the
  // key's typed rule. The documented difference from config-set, pinned.
  for (const [keyPath, text] of [['workflow.research', 'true'], ['git.create_tag', 'false'], ['context_window', '5'], ['workflow.security_asvs_level', '2']]) {
    test(`a string where ${keyPath} takes a ${text === 'true' || text === 'false' ? 'boolean' : 'number'} is refused, though config-set coerces the same text`, () => {
      const viaSet = runGsdTools(['config-set', keyPath, text], projectDir());
      assert.ok(viaSet.success, `positive control: config-set must accept ${keyPath} ${text}: ${viaSet.error}`);

      const dir = bareDir();
      const result = newProject([JSON.stringify(nest(keyPath, text))], dir);

      assert.strictEqual(result.success, false, `config-new-project accepted the string "${text}" for ${keyPath}`);
      assertNothingWritten(dir);
    });
  }

  test('--dry-run still refuses invalid choices', () => {
    const dir = bareDir();
    const result = newProject([JSON.stringify({ bogus_key: 'x', mode: 'nonsense' }), '--dry-run'], dir);

    assert.strictEqual(result.success, false);
    assert.match(result.error, /Unknown config key: "bogus_key"/);
    assertNothingWritten(dir);
  });

  // config-set <key> null clears the key; a null choice leaves it unchosen.
  // Both end with the key at its default, whatever its typed rules require.
  for (const keyPath of ['mode', 'ship.pr_body_sections', 'workflow.research']) {
    test(`a null choice is accepted as config-set accepts it, and leaves ${keyPath} as an empty payload would`, () => {
      const viaSet = runGsdTools(['config-set', keyPath, 'null'], projectDir());
      assert.ok(viaSet.success, `positive control: config-set must accept ${keyPath}=null: ${viaSet.error}`);

      const baselineDir = bareDir();
      assert.ok(newProject(['{}'], baselineDir).success);

      const dir = bareDir();
      const result = newProject([JSON.stringify(nest(keyPath, null))], dir);

      assert.ok(result.success, `Command failed: ${result.error}`);
      assert.deepStrictEqual(readProjectConfig(dir), readProjectConfig(baselineDir));
    });
  }

  test('a null choice still has its key checked', () => {
    const dir = bareDir();
    const result = newProject([JSON.stringify({ workflow: { reserch: null } })], dir);

    assert.strictEqual(result.success, false);
    assert.match(result.error, /Unknown config key: "workflow\.reserch"/);
    assertNothingWritten(dir);
  });

  // The other user-defaults rewrite tests spawn the CLI with a separate OS
  // home, so they live in tests/config.platform.test.cjs. This one runs
  // in-process and reads only the GSD_HOME it sets.
  test('a creation whose config write fails leaves the user defaults file unmigrated', async (t) => {
    const dir = bareDir();
    const gsdHome = bareDir();
    const defaultsPath = path.join(gsdHome, '.gsd', 'defaults.json');
    const defaultsBefore = JSON.stringify({ depth: 'quick' });
    fs.mkdirSync(path.dirname(defaultsPath), { recursive: true });
    fs.writeFileSync(defaultsPath, defaultsBefore);
    const savedGsdHome = process.env.GSD_HOME;
    process.env.GSD_HOME = gsdHome;
    t.after(() => {
      if (savedGsdHome === undefined) delete process.env.GSD_HOME;
      else process.env.GSD_HOME = savedGsdHome;
    });
    // In-process, so the fault lands on the config write itself and on nothing before it.
    // platformWriteSync publishes through an exclusively created temp file and writes its
    // DESCRIPTOR (#5759), so the injected fault matches descriptor writes as well as path writes;
    // a path-only matcher never fires and the creation succeeds.
    const configPath = path.join(dir, '.planning', 'config.json');
    t.after(mockPartialWriteThenThrow(fs, (target) => typeof target === 'number' || String(target).startsWith(configPath), 0));

    const result = await runQuietly(() => configLib.cmdConfigNewProject(dir, JSON.stringify({ mode: 'yolo' }), false));

    assert.strictEqual(result.ok, false);
    assert.match(result.err, /Failed to write config\.json/);
    assert.strictEqual(fs.readFileSync(defaultsPath, 'utf-8'), defaultsBefore);
  });

  test('--dry-run on an existing config reports already_exists', () => {
    const dir = projectDir();
    assert.ok(newProject(['{}'], dir).success);
    const before = fs.readFileSync(path.join(dir, '.planning', 'config.json'), 'utf-8');

    const result = newProject([JSON.stringify({ mode: 'yolo' }), '--dry-run'], dir);

    assert.ok(result.success, `Command failed: ${result.error}`);
    assert.deepStrictEqual(JSON.parse(result.output), { created: false, reason: 'already_exists' });
    assert.strictEqual(fs.readFileSync(path.join(dir, '.planning', 'config.json'), 'utf-8'), before);
  });

  for (const choices of [{ mode: 'nonsense' }, { bogus_key: 'x' }]) {
    for (const dryRun of [false, true]) {
      test(`an existing config does not hide a refused choice${dryRun ? ' under --dry-run' : ''}: ${JSON.stringify(choices)}`, () => {
        const dir = projectDir();
        assert.ok(newProject(['{}'], dir).success);
        const configPath = path.join(dir, '.planning', 'config.json');
        const before = fs.readFileSync(configPath, 'utf-8');

        const result = newProject([JSON.stringify(choices), ...(dryRun ? ['--dry-run'] : [])], dir);

        assert.strictEqual(result.success, false, 'a refused choice must not report already_exists');
        assert.match(result.error, /Invalid mode 'nonsense'|Unknown config key: "bogus_key"/);
        assert.strictEqual(fs.readFileSync(configPath, 'utf-8'), before);
      });
    }
  }

  // The shipped callers: the choices template each workflow hands the model,
  // with every placeholder filled in. A key added to a template without being
  // registered in the schema fails here rather than in a user's new project.
  const TEMPLATE_PLACEHOLDERS = [
    ['"[yolo|interactive]"', '"yolo"'],
    ['"[selected]"', '"standard"'],
    ['"quality|balanced|budget|adaptive|inherit"', '"balanced"'],
    ['[false if granularity=coarse, true otherwise]', 'true'],
    ['true|false', 'true'],
  ];

  for (const workflow of ['gsd-core/workflows/new-project.md', 'gsd-core/workflows/new-project/steps/auto-mode-config.md']) {
    test(`the filled-in choices template of ${workflow} is accepted and written as given`, () => {
      const source = fs.readFileSync(path.join(repoRoot, workflow), 'utf-8');
      const template = source.match(/config-new-project '(\{.*\})'/);
      assert.ok(template, `${workflow} no longer carries a config-new-project choices template`);
      const filled = TEMPLATE_PLACEHOLDERS.reduce((text, [placeholder, value]) => text.split(placeholder).join(value), template[1]);
      const choices = JSON.parse(filled);
      // A placeholder spelling TEMPLATE_PLACEHOLDERS does not know survives the
      // fill as a string; one inside a non-string slot already broke the parse.
      const unfilled = stringLeaves(choices).filter((text) => /^\[.*\]$/.test(text) || /^[a-z-]+(\|[a-z-]+)+$/.test(text));
      assert.deepStrictEqual(unfilled, [], `${workflow} carries a placeholder TEMPLATE_PLACEHOLDERS does not fill`);

      const baselineDir = bareDir();
      assert.ok(newProject(['{}'], baselineDir).success);
      const baseline = readProjectConfig(baselineDir);

      const dir = bareDir();
      const result = newProject([filled], dir);
      assert.ok(result.success, `Command failed: ${result.error}`);
      const config = readProjectConfig(dir);

      const chosen = leafPaths(choices);
      for (const keyPath of chosen) {
        assert.deepStrictEqual(valueAt(config, keyPath), valueAt(choices, keyPath), `${keyPath} must be written as chosen`);
      }
      for (const keyPath of leafPaths(baseline).filter((candidate) => !chosen.includes(candidate))) {
        assert.deepStrictEqual(valueAt(config, keyPath), valueAt(baseline, keyPath), `${keyPath} must keep its default`);
      }
      assert.deepStrictEqual(
        Object.keys(config).sort(),
        [...new Set([...Object.keys(baseline), ...Object.keys(choices)])].sort(),
      );
    });
  }
});

// ─── config-set silent coercion (#1581) ──────────────────────────────────────

describe('config-set — no silent coercion (#1581)', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { cleanup(tmpDir); });

  test('context_window Infinity is rejected (no null-on-disk / output≠disk divergence)', () => {
    const result = runGsdTools('config-set context_window Infinity', tmpDir);
    assert.strictEqual(result.success, false, 'Infinity must be rejected');
    assert.match(result.error, /context_window/i);
    // The old bug number-coerced Infinity, then JSON.stringify rendered it as
    // `null` on disk while the CLI echoed 'Infinity'. The fix rejects before
    // any write, so config.json is left untouched (no null entry written).
    assert.doesNotThrow(() => {
      const configPath = path.join(tmpDir, '.planning', 'config.json');
      if (!fs.existsSync(configPath)) return; // never written — the rejection path
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      assert.ok(cfg.context_window !== null && cfg.context_window !== Infinity,
        'context_window must not be written as null/Infinity');
    });
  });

  test('context_window 0 is rejected (must be a positive integer)', () => {
    const result = runGsdTools('config-set context_window 0', tmpDir);
    assert.strictEqual(result.success, false, '0 must be rejected');
    assert.match(result.error, /positive integer/i);
  });

  test('context_window <positive integer> is accepted and persisted as a finite number', () => {
    const result = runGsdTools('config-set context_window 200000', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const config = readConfig(tmpDir);
    assert.strictEqual(config.context_window, 200000);
    assert.strictEqual(typeof config.context_window, 'number');
    assert.ok(Number.isFinite(config.context_window), 'must be finite on disk');
  });

  test('project_code 007 persists as the string "007" (leading zero preserved, not coerced to 7)', () => {
    const result = runGsdTools('config-set project_code 007', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const config = readConfig(tmpDir);
    assert.strictEqual(config.project_code, '007');
    assert.strictEqual(typeof config.project_code, 'string',
      'project_code is an identifier string — must not be number-coerced');
  });

  test('regression guard: numeric coercion still works for numeric keys (granularity 42)', () => {
    const result = runGsdTools('config-set granularity 42', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    assert.strictEqual(readConfig(tmpDir).granularity, 42);
  });
});

// ─── config-set <key> null — unset/clear (#2046) ─────────────────────────────

describe('config-set <key> null — unset/clear (#2046)', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { cleanup(tmpDir); });

  test('non-secret routing key: config-set <key> null removes the key (not the string "null")', () => {
    const setResult = runGsdTools('config-set review.models.codex foo', tmpDir);
    assert.ok(setResult.success, `Command failed: ${setResult.error}`);
    assert.strictEqual(readConfig(tmpDir).review.models.codex, 'foo');

    const unsetResult = runGsdTools('config-set review.models.codex null', tmpDir);
    assert.ok(unsetResult.success, `Command failed: ${unsetResult.error}`);

    const config = readConfig(tmpDir);
    assert.ok(
      !config.review || !config.review.models || !Object.prototype.hasOwnProperty.call(config.review.models, 'codex'),
      'review.models.codex must be absent on disk after unset, not the string "null"'
    );

    // #2797: review.models.<slug> is federated to its lane capability now, and a
    // federated key always resolves to its declared default — so a cleared key
    // reads back as the empty string (rendered `""` by the non-raw formatter)
    // instead of erroring. The property this test actually guards is unchanged
    // and asserted above: the key is REMOVED from disk, never persisted as the
    // literal string "null".
    const getResult = runGsdTools('config-get review.models.codex', tmpDir);
    const shown = (getResult.output || '').trim();
    assert.ok(
      shown === '' || shown === '""' || shown === 'undefined',
      `config-get should return empty/undefined after unset, got: ${getResult.output}`
    );
    assert.notStrictEqual(shown, 'null');
    assert.notStrictEqual(shown, '"null"');
  });

  test('secret key: config-set brave_search null removes the key (never persists "null")', () => {
    const setResult = runGsdTools('config-set brave_search sk-test-1234', tmpDir);
    assert.ok(setResult.success, `Command failed: ${setResult.error}`);
    assert.strictEqual(readConfig(tmpDir).brave_search, 'sk-test-1234');

    const unsetResult = runGsdTools('config-set brave_search null', tmpDir);
    assert.ok(unsetResult.success, `Command failed: ${unsetResult.error}`);

    const configPath = path.join(tmpDir, '.planning', 'config.json');
    const rawText = fs.readFileSync(configPath, 'utf-8');
    const config = JSON.parse(rawText);
    assert.ok(
      !Object.prototype.hasOwnProperty.call(config, 'brave_search'),
      'brave_search must be absent on disk after unset'
    );
    assert.doesNotMatch(rawText, /"brave_search":\s*"null"/,
      'raw config.json must never contain brave_search mapped to the literal string "null"');
  });

  test('typed-key bypass: config-set context null clears an enum-typed key without validator rejection', () => {
    const setResult = runGsdTools('config-set context dev', tmpDir);
    assert.ok(setResult.success, `Command failed: ${setResult.error}`);
    assert.strictEqual(readConfig(tmpDir).context, 'dev');

    const unsetResult = runGsdTools('config-set context null', tmpDir);
    assert.ok(unsetResult.success, `config-set context null must succeed (bypass enum validator), got error: ${unsetResult.error}`);

    const config = readConfig(tmpDir);
    assert.ok(!Object.prototype.hasOwnProperty.call(config, 'context'),
      'context key must be removed after unset');
  });

  test('idempotent: config-set <never-set key> null succeeds with no crash and no key written', () => {
    const result = runGsdTools('config-set git.base_branch null', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.ok(
      !config.git || !Object.prototype.hasOwnProperty.call(config.git, 'base_branch'),
      'git.base_branch must not be present after unsetting a key that was never set'
    );
  });

  test('literal-"null" guard: no config-set <key> null ever persists the literal string "null" on disk', () => {
    runGsdTools('config-set review.models.codex foo', tmpDir);
    runGsdTools('config-set review.models.codex null', tmpDir);
    runGsdTools('config-set brave_search sk-test-1234', tmpDir);
    runGsdTools('config-set brave_search null', tmpDir);
    runGsdTools('config-set context dev', tmpDir);
    runGsdTools('config-set context null', tmpDir);

    const configPath = path.join(tmpDir, '.planning', 'config.json');
    const rawText = fs.readFileSync(configPath, 'utf-8');
    assert.doesNotMatch(rawText, /:\s*"null"/,
      `config.json must never contain a key mapped to the literal string "null": ${rawText}`);
  });

  test('prototype-pollution guard: unsetting a __proto__ leaf is rejected, no pollution (alert #26 parity)', () => {
    // Create the intermediate so the unset walk reaches the leaf guard (a bare
    // dynamic-prefix key passes the schema gate, so this exercises the
    // _unsetNestedValue guard, not the schema gate — mirrors the set-path test).
    const seed = runGsdTools('config-set agent_skills.sonnet-coder true', tmpDir);
    assert.ok(seed.success, `seed failed: ${seed.error}`);

    const result = runGsdTools('config-set agent_skills.__proto__ null', tmpDir);
    assert.strictEqual(result.success, false, `Expected rejection, got: ${result.output}`);
    assert.ok(
      result.error.includes('prototype pollution guard'),
      `Expected pollution-guard error, got: ${result.error}`,
    );
    // No prototype pollution occurred via the unset path.
    assert.strictEqual(({}).polluted, undefined);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted'), false);
  });

  test('deep (4-segment) nested key: config-set <deep> null removes only the leaf', () => {
    const set = runGsdTools('config-set review.reviewer_instances.myinst.model some-model', tmpDir);
    assert.ok(set.success, `deep set failed: ${set.error}`);
    assert.strictEqual(readConfig(tmpDir).review.reviewer_instances.myinst.model, 'some-model');

    const unset = runGsdTools('config-set review.reviewer_instances.myinst.model null', tmpDir);
    assert.ok(unset.success, `deep unset failed: ${unset.error}`);

    const config = readConfig(tmpDir);
    assert.ok(
      !config.review.reviewer_instances.myinst ||
        !Object.prototype.hasOwnProperty.call(config.review.reviewer_instances.myinst, 'model'),
      'the leaf model key must be removed',
    );
    // Parent objects along the path are preserved (unset removes only the leaf).
    assert.ok(config.review && config.review.reviewer_instances,
      'parent objects on the path must remain after leaf unset');
  });
});

// ─── config-set --dry-run (#4444) ────────────────────────────────────────────

describe('config-set --dry-run (#4444)', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { cleanup(tmpDir); });

  test('config-set --dry-run does not write to config.json (first call, key absent)', () => {
    const result = runGsdTools('config-set model_profile quality --dry-run', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.dry_run, true);

    const configPath = path.join(tmpDir, '.planning', 'config.json');
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      assert.strictEqual(
        Object.prototype.hasOwnProperty.call(config, 'model_profile'),
        false,
        'model_profile must not be written to config.json by a --dry-run call'
      );
    }
  });

  test('config-set --dry-run does not persist across repeated dry-run calls (repro: previousValue must not reflect a prior dry run)', () => {
    const first = runGsdTools('config-set review.timeouts.antigravity 1 --dry-run', tmpDir);
    assert.ok(first.success, `Command failed: ${first.error}`);
    const firstOutput = JSON.parse(first.output);
    assert.strictEqual(firstOutput.dry_run, true);
    assert.strictEqual(firstOutput.previousValue, undefined);

    const second = runGsdTools('config-set review.timeouts.antigravity 3600 --dry-run', tmpDir);
    assert.ok(second.success, `Command failed: ${second.error}`);
    const secondOutput = JSON.parse(second.output);
    assert.strictEqual(secondOutput.dry_run, true);
    // The reported bug: this used to be 1 (the first "dry run"'s value),
    // proving it was actually persisted to disk.
    assert.strictEqual(
      secondOutput.previousValue,
      undefined,
      'a second --dry-run call must not see a value the first --dry-run "wrote"'
    );
  });

  test('config-set: a real write after dry-run calls sees the pre-dry-run value, not a dry-run leak', () => {
    const seed = runGsdTools('config-set review.timeouts.antigravity 10', tmpDir);
    assert.ok(seed.success, `seed failed: ${seed.error}`);

    const dryRun = runGsdTools('config-set review.timeouts.antigravity 9999 --dry-run', tmpDir);
    assert.ok(dryRun.success, `Command failed: ${dryRun.error}`);
    assert.strictEqual(JSON.parse(dryRun.output).dry_run, true);

    // The dry-run must not have changed the on-disk value.
    assert.strictEqual(readConfig(tmpDir).review.timeouts.antigravity, 10);

    const real = runGsdTools('config-set review.timeouts.antigravity 20', tmpDir);
    assert.ok(real.success, `Command failed: ${real.error}`);
    assert.strictEqual(
      JSON.parse(real.output).previousValue,
      10,
      'the real write must see the seeded value (10), not the dry-run value (9999)'
    );
    assert.strictEqual(readConfig(tmpDir).review.timeouts.antigravity, 20);
  });

  test('config-set --dry-run correctly previews the current value without mutating it', () => {
    const seed = runGsdTools('config-set model_profile quality', tmpDir);
    assert.ok(seed.success, `seed failed: ${seed.error}`);

    const dryRun = runGsdTools('config-set model_profile speed --dry-run', tmpDir);
    assert.ok(dryRun.success, `Command failed: ${dryRun.error}`);
    const output = JSON.parse(dryRun.output);
    assert.strictEqual(output.dry_run, true);
    assert.strictEqual(output.previousValue, 'quality');
    assert.strictEqual(output.value, 'speed');

    // Unchanged on disk.
    assert.strictEqual(readConfig(tmpDir).model_profile, 'quality');
  });

  test('config-set --dry-run still validates: an invalid value is still rejected, not silently previewed', () => {
    const result = runGsdTools('config-set context badvalue --dry-run', tmpDir);
    assert.strictEqual(result.success, false, 'an invalid enum value must still be rejected under --dry-run');
    assert.match(result.error, /Invalid context value/i);

    // Nothing written.
    const configPath = path.join(tmpDir, '.planning', 'config.json');
    if (fs.existsSync(configPath)) {
      assert.strictEqual(
        Object.prototype.hasOwnProperty.call(JSON.parse(fs.readFileSync(configPath, 'utf-8')), 'context'),
        false
      );
    }
  });

  test('config-set --dry-run masks secret values in the preview exactly like the real write does', () => {
    const seed = runGsdTools('config-set brave_search sk-test-original', tmpDir);
    assert.ok(seed.success, `seed failed: ${seed.error}`);

    const dryRun = runGsdTools('config-set brave_search sk-test-newvalue --dry-run', tmpDir);
    assert.ok(dryRun.success, `Command failed: ${dryRun.error}`);
    const output = JSON.parse(dryRun.output);
    assert.strictEqual(output.dry_run, true);
    assert.strictEqual(output.masked, true);
    assert.doesNotMatch(JSON.stringify(output), /sk-test-newvalue/, 'the new secret value must not appear in plaintext');
    assert.doesNotMatch(JSON.stringify(output), /sk-test-original/, 'the previous secret value must not appear in plaintext');

    // Unchanged on disk.
    assert.strictEqual(readConfig(tmpDir).brave_search, 'sk-test-original');
  });

  test('config-set <key> null --dry-run does not unset (dry-run covers the unset branch too)', () => {
    const seed = runGsdTools('config-set review.models.codex foo', tmpDir);
    assert.ok(seed.success, `seed failed: ${seed.error}`);

    const dryRun = runGsdTools('config-set review.models.codex null --dry-run', tmpDir);
    assert.ok(dryRun.success, `Command failed: ${dryRun.error}`);
    const output = JSON.parse(dryRun.output);
    assert.strictEqual(output.dry_run, true);
    assert.strictEqual(output.would_unset, true);

    // Still present on disk — the dry-run must not have unset it.
    assert.strictEqual(readConfig(tmpDir).review.models.codex, 'foo');
  });
});

// ─── Unsupported config mutation flags (#5286) ───────────────────────────────

describe('#5286: config mutation routes reject unsupported flags before writing', () => {
  const verbs = [
    { command: 'config-ensure-section', positionals: [] },
    { command: 'config-set-model-profile', positionals: ['quality'] },
    { command: 'migrate-config', positionals: [] },
  ];
  test('the registry declares the actual guarded mutation routes', async () => {
    const { CLI_SURFACE } = require('../gsd-core/bin/lib/cli-surface.cjs');
    assert.deepEqual(Object.keys(CLI_SURFACE).filter((verb) => CLI_SURFACE[verb].rejectedGlobalFlags).sort(), verbs.map(({ command }) => command).sort());
    for (const { command, positionals } of verbs) {
      assert.equal(CLI_SURFACE[command].positionals, positionals.length + 1);
      assert.deepEqual(CLI_SURFACE[command].rejectedGlobalFlags, ['pick', 'default']);
    }
  });
  const unsupportedFlags = ['--json', '--force', '--workstream', '--dry-run', '--bogus-flag', '--dry-run=', '--raw=true', '---dry-run', '--5', '--', '-1', '-'];
  // Noncanonical bytes and a real legacy key expose both rewriting and migration.
  const legacyBytes = '{ "depth" : "comprehensive", "model_profile" : "balanced", "commit_docs" : false }\n';

  function fixture(existing) {
    const dir = createTempProject('gsd-config-flags-');
    const configPath = path.join(dir, '.planning', 'config.json');
    if (existing) fs.writeFileSync(configPath, legacyBytes);
    return { dir, configPath, before: existing ? fs.readFileSync(configPath) : null };
  }

  function assertUnchanged({ configPath, before }) {
    if (before === null) {
      assert.equal(fs.existsSync(configPath), false, 'unsupported flags must not create config.json');
    } else {
      assert.deepEqual(fs.readFileSync(configPath), before, 'unsupported flags must preserve config bytes');
    }
  }

  const seamStrays = new Set(['-1', '-']);

  function assertUsage(result, command, flag, profileSlot = false) {
    assert.equal(result.success, false, 'an unsupported flag must fail');
    assert.equal(result.exitCode, 1);
    assert.equal(result.output, '', 'refusal must not print a success payload');
    assert.deepEqual(JSON.parse(result.error), {
      ok: false,
      reason: ERROR_REASON.USAGE,
      message: !profileSlot && seamStrays.has(flag)
        ? `unexpected positional argument ${formatDiagnosticToken(flag)}`
        : `Unknown flag for ${command}: ${flag}`,
    });
  }

  for (const { command, positionals } of verbs) {
    for (const prefix of [[], ['query']]) {
      const invocation = [...prefix, command].join(' ');
      for (const existing of [false, true]) {
        for (const flag of unsupportedFlags) {
          test(`${invocation} ${flag} preserves ${existing ? 'existing' : 'absent'} config`, async (t) => {
            const f = fixture(existing);
            t.after(() => cleanup(f.dir));
            const result = await runGsdToolsAsync(
              [...prefix, command, ...positionals, flag, '--json-errors'],
              f.dir,
              homeSandboxEnv(f.dir),
            );
            assertUnchanged(f);
            assertUsage(result, command, flag);
          });

          if (positionals.length > 0) {
            test(`${invocation} ${flag} before the profile is a usage error with ${existing ? 'existing' : 'absent'} config`, async (t) => {
              const f = fixture(existing);
              t.after(() => cleanup(f.dir));
              const result = await runGsdToolsAsync(
                [...prefix, command, flag, ...positionals, '--json-errors'],
                f.dir,
                homeSandboxEnv(f.dir),
              );
              assertUnchanged(f);
              assertUsage(result, command, flag, true);
            });
          }
        }
      }

      for (const raw of [false, true]) {
        test(`${invocation} ${raw ? '--raw' : 'without flags'} still performs its mutation`, async (t) => {
          const f = fixture(command === 'migrate-config');
          t.after(() => cleanup(f.dir));
          const result = await runGsdToolsAsync(
            [...prefix, command, ...(raw ? ['--raw'] : []), ...positionals],
            f.dir,
            homeSandboxEnv(f.dir),
          );
          assert.ok(result.success, result.error);
          const config = readConfig(f.dir);
          if (command === 'config-ensure-section') {
            assert.equal(config.model_profile, 'balanced');
            if (!raw) assert.equal(JSON.parse(result.output).created, true);
          } else if (command === 'config-set-model-profile') {
            assert.equal(config.model_profile, 'quality');
            if (!raw) assert.equal(JSON.parse(result.output).updated, true);
          } else {
            assert.equal(Object.hasOwn(config, 'depth'), false);
            assert.equal(config.granularity, 'fine');
            assert.equal(config.commit_docs, false);
            assert.notDeepEqual(fs.readFileSync(f.configPath), f.before);
            if (!raw) assert.equal(JSON.parse(result.output).migrated, true);
          }
        });
      }

      for (const existing of [false, true]) {
        for (const globalFlag of ['--default', '--pick']) {
          for (const flag of ['--dry-run', '-n']) {
            test(`${invocation} ${globalFlag} ${flag} refuses before mutation with existing=${existing}`, async (t) => {
              const f = fixture(existing);
              t.after(() => cleanup(f.dir));
              const result = await runGsdToolsAsync([...prefix, command, ...positionals, globalFlag, flag, '--json-errors'], f.dir, homeSandboxEnv(f.dir));
              assertUnchanged(f);
              assertUsage(result, command, globalFlag);
            });
          }
        }
        for (const globalFlag of ['--cwd', '--project-dir']) {
          test(`${invocation} refuses repeated ${globalFlag} with existing=${existing}`, async (t) => {
            const f = fixture(existing);
            t.after(() => cleanup(f.dir));
            const result = await runGsdToolsAsync([...prefix, command, ...positionals, globalFlag, f.dir, globalFlag, f.dir, '--json-errors'], f.dir, homeSandboxEnv(f.dir));
            assertUnchanged(f);
            assertUsage(result, command, globalFlag);
          });
        }
      }

      test(`${invocation} accepts a repeated --raw without changing the mutation`, async (t) => {
        const f = fixture(command === 'migrate-config');
        t.after(() => cleanup(f.dir));
        const result = await runGsdToolsAsync(
          [...prefix, command, ...positionals, '--raw', '--raw'],
          f.dir,
          homeSandboxEnv(f.dir),
        );
        assert.ok(result.success, result.error);
        const config = readConfig(f.dir);
        if (command === 'config-ensure-section') assert.equal(config.model_profile, 'balanced');
        else if (command === 'config-set-model-profile') assert.equal(config.model_profile, 'quality');
        else {
          assert.equal(Object.hasOwn(config, 'depth'), false);
          assert.equal(config.granularity, 'fine');
          assert.equal(config.commit_docs, false);
          assert.notDeepEqual(fs.readFileSync(f.configPath), f.before);
        }
      });

      test(`${invocation} refuses an extra positional before writing`, async (t) => {
        const f = fixture(false);
        t.after(() => cleanup(f.dir));
        const extra = command === 'config-set-model-profile' ? 'extra-profile' : 'extra';
        const result = await runGsdToolsAsync(
          [...prefix, command, ...positionals, extra, '--json-errors'],
          f.dir,
          homeSandboxEnv(f.dir),
        );
        assertUnchanged(f);
        assert.equal(result.success, false);
        assert.equal(result.exitCode, 1);
        assert.deepEqual(JSON.parse(result.error), {
          ok: false, reason: ERROR_REASON.USAGE,
          message: `unexpected positional argument ${formatDiagnosticToken(extra)}`,
        });
        assert.equal(result.output, '');
      });
    }
  }

  for (const profile of [undefined, '', '   ']) {
    test(`config-set-model-profile refuses ${profile === undefined ? 'a missing' : JSON.stringify(profile)} profile before writing`, async (t) => {
      const f = fixture(false);
      t.after(() => cleanup(f.dir));
      const result = await runGsdToolsAsync(
        ['config-set-model-profile', ...(profile === undefined ? [] : [profile]), '--json-errors'],
        f.dir,
        homeSandboxEnv(f.dir),
      );
      assertUnchanged(f);
      assert.equal(result.success, false);
      assert.equal(result.exitCode, 1);
      assert.equal(result.output, '');
      assert.deepEqual(JSON.parse(result.error), {
        ok: false, reason: ERROR_REASON.UNKNOWN,
        message: profile ? `Invalid profile '${profile}'. Valid profiles: ${VALID_PROFILES.join(', ')}`
          : `Usage: config-set-model-profile <${VALID_PROFILES.join('|')}>`,
      });
    });
  }

  test('unknown flag spelling and placement cannot bypass refusal on any of the three routes', async (t) => {
    const fixtures = [];
    t.after(() => fixtures.forEach((dir) => cleanup(dir)));
    await fc.assert(fc.asyncProperty(
      fc.record({
        suffix: fc.array(fc.constantFrom('a', 'b', 'c', '0', '1', '='), { minLength: 1, maxLength: 12 }),
        short: fc.boolean(),
        leading: fc.boolean(),
        query: fc.boolean(),
        raw: fc.boolean(),
        existing: fc.boolean(),
        adjacent: fc.constantFrom(null, '--default', '--pick'),
        beforeCommand: fc.boolean(),
      }),
      async ({ suffix, short, leading, query, raw, existing, adjacent, beforeCommand }) => {
        const flag = `${short ? '-' : '--'}unknown-${suffix.join('')}`;
        const globalPrefix = adjacent !== null && beforeCommand;
        for (const { command, positionals } of verbs) {
          const f = fixture(existing);
          fixtures.push(f.dir);
          const result = await runGsdToolsAsync([
            ...(globalPrefix ? [adjacent, flag] : []), ...(query ? ['query'] : []), command,
            ...(leading && !globalPrefix ? [...(adjacent ? [adjacent] : []), flag] : []), ...positionals,
            ...(raw ? ['--raw'] : []), ...(leading || globalPrefix ? [] : [...(adjacent ? [adjacent] : []), flag]), '--json-errors',
          ], f.dir, homeSandboxEnv(f.dir));
          assertUnchanged(f);
          assertUsage(result, command, adjacent ?? flag);
        }
      },
    ), { seed: 5286, numRuns: 12, examples: [[{
      suffix: ['a'], short: false, leading: false, query: true, raw: false,
      existing: true, adjacent: '--default', beforeCommand: true,
    }], [{
      suffix: ['b'], short: true, leading: false, query: true, raw: true,
      existing: false, adjacent: '--pick', beforeCommand: true,
    }]] });
  });
});

// ─── config-set (research_before_questions and discuss_mode) ──────────────────

describe('config-set research_before_questions and discuss_mode', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    runGsdTools('config-ensure-section', tmpDir, homeSandboxEnv(tmpDir));
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('workflow.research_before_questions is a valid config key', () => {
    const result = runGsdTools('config-set workflow.research_before_questions true', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.workflow.research_before_questions, true);
  });

  test('workflow.discuss_mode is a valid config key', () => {
    const result = runGsdTools('config-set workflow.discuss_mode assumptions', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.workflow.discuss_mode, 'assumptions');
  });

  test('research_before_questions defaults to false in new configs', () => {
    const config = readConfig(tmpDir);
    assert.strictEqual(config.workflow.research_before_questions, false);
  });

  test('discuss_mode defaults to discuss in new configs', () => {
    const config = readConfig(tmpDir);
    assert.strictEqual(config.workflow.discuss_mode, 'discuss');
  });

  test('hooks.research_questions is rejected with suggestion', () => {
    const result = runGsdTools('config-set hooks.research_questions true', tmpDir);
    assert.strictEqual(result.success, false);
    assert.ok(
      result.error.includes('Unknown config key'),
      `Expected "Unknown config key" in error: ${result.error}`
    );
    assert.ok(
      result.error.includes('workflow.research_before_questions'),
      `Expected suggestion for workflow.research_before_questions in error: ${result.error}`
    );
  });
});

// ─── config-set (additional coverage) ────────────────────────────────────────

describe('config-set unknown key (no suggestion)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    runGsdTools('config-ensure-section', tmpDir);
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('rejects a key that has no suggestion', () => {
    const result = runGsdTools('config-set totally.unknown.key value', tmpDir);
    assert.strictEqual(result.success, false);
    assert.ok(
      result.error.includes('Unknown config key'),
      `Expected "Unknown config key" in error: ${result.error}`
    );
  });
});

// ─── config-get (additional coverage) ────────────────────────────────────────

describe('config-get edge cases', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('errors when traversing a dot-path through a non-object value', () => {
    // model_profile is a string — requesting model_profile.something traverses into a non-object
    writeConfig(tmpDir, { model_profile: 'balanced' });
    const result = runGsdTools('config-get model_profile.something', tmpDir);
    assert.strictEqual(result.success, false);
    assert.ok(
      result.error.includes('Key not found'),
      `Expected "Key not found" in error: ${result.error}`
    );
  });

  test('errors when config.json contains malformed JSON', () => {
    const configPath = path.join(tmpDir, '.planning', 'config.json');
    fs.mkdirSync(path.join(tmpDir, '.planning'), { recursive: true });
    fs.writeFileSync(configPath, '{not valid json', 'utf-8');
    const result = runGsdTools('config-get model_profile', tmpDir);
    assert.strictEqual(result.success, false);
    assert.ok(
      result.error.includes('Failed to read config.json'),
      `Expected "Failed to read config.json" in error: ${result.error}`
    );
  });
});

// ─── config-set-model-profile ─────────────────────────────────────────────────

describe('config-set-model-profile command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    runGsdTools('config-ensure-section', tmpDir, homeSandboxEnv(tmpDir));
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('sets a valid profile and updates config', () => {
    const result = runGsdTools('config-set-model-profile quality', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const out = JSON.parse(result.output);
    assert.strictEqual(out.updated, true);
    assert.strictEqual(out.profile, 'quality');
    assert.ok(out.agentToModelMap && typeof out.agentToModelMap === 'object');

    const config = readConfig(tmpDir);
    assert.strictEqual(config.model_profile, 'quality');
  });

  test('reports previous profile in output', () => {
    const result = runGsdTools('config-set-model-profile budget', tmpDir, homeSandboxEnv(tmpDir));
    assert.ok(result.success, `Command failed: ${result.error}`);

    const out = JSON.parse(result.output);
    assert.strictEqual(out.previousProfile, 'balanced'); // default was balanced
    assert.strictEqual(out.profile, 'budget');
  });

  test('setting the same profile is a no-op on config but still succeeds', () => {
    // Set to quality first, then set to quality again
    runGsdTools('config-set-model-profile quality', tmpDir);
    const result = runGsdTools('config-set-model-profile quality', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const out = JSON.parse(result.output);
    assert.strictEqual(out.profile, 'quality');
    assert.strictEqual(out.previousProfile, 'quality');
  });

  test('is case-insensitive', () => {
    const result = runGsdTools('config-set-model-profile BALANCED', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.model_profile, 'balanced');
  });

  test('rejects invalid profile', () => {
    const result = runGsdTools('config-set-model-profile turbo', tmpDir);
    assert.strictEqual(result.success, false);
    assert.ok(
      result.error.includes('Invalid profile'),
      `Expected "Invalid profile" in error: ${result.error}`
    );
  });

  test('errors when no profile provided', () => {
    const result = runGsdTools('config-set-model-profile', tmpDir);
    assert.strictEqual(result.success, false);
  });

  describe('when config is missing', () => {
    let emptyDir;

    beforeEach(() => {
      emptyDir = createTempProject();
    });

    afterEach(() => {
      cleanup(emptyDir);
    });

    test('creates config if missing before setting profile', () => {
      const result = runGsdTools('config-set-model-profile budget', emptyDir);
      assert.ok(result.success, `Command failed: ${result.error}`);

      const config = readConfig(emptyDir);
      assert.strictEqual(config.model_profile, 'budget');
    });
  });
});

// ─── config-set (workflow.skip_discuss) ───────────────────────────────────────

describe('config-set workflow.skip_discuss', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    seedProjectConfig(tmpDir);
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('workflow.skip_discuss is a valid config key', () => {
    const result = runGsdTools('config-set workflow.skip_discuss true', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.workflow.skip_discuss, true);
  });

  test('skip_discuss defaults to false in new configs', () => {
    const config = readConfig(tmpDir);
    assert.strictEqual(config.workflow.skip_discuss, false);
  });

  test('skip_discuss can be toggled back to false', () => {
    runGsdTools('config-set workflow.skip_discuss true', tmpDir);
    const result = runGsdTools('config-set workflow.skip_discuss false', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.workflow.skip_discuss, false);
  });

  describe('skip_discuss in config-new-project', () => {
    let emptyDir;

    beforeEach(() => {
      emptyDir = createTempProject();
    });

    afterEach(() => {
      cleanup(emptyDir);
    });

    test('skip_discuss is present in config-new-project output', () => {
      const result = runGsdTools(['config-new-project', '{}'], emptyDir, homeSandboxEnv(emptyDir));
      assert.ok(result.success, `Command failed: ${result.error}`);

      const config = readConfig(emptyDir);
      assert.strictEqual(config.workflow.skip_discuss, false, 'skip_discuss should default to false');
    });

    test('skip_discuss can be set via config-new-project choices', () => {
      const choices = JSON.stringify({
        workflow: { skip_discuss: true },
      });
      const result = runGsdTools(['config-new-project', choices], emptyDir, homeSandboxEnv(emptyDir));
      assert.ok(result.success, `Command failed: ${result.error}`);

      const config = readConfig(emptyDir);
      assert.strictEqual(config.workflow.skip_discuss, true);
    });
  });

  test('config-get workflow.skip_discuss returns the set value', () => {
    runGsdTools('config-set workflow.skip_discuss true', tmpDir);
    const result = runGsdTools('config-get workflow.skip_discuss', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output, true);
  });
});

// ─── config-set/config-get workflow.use_worktrees ────────────────────────────

describe('config-set/config-get workflow.use_worktrees', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    runGsdTools('config-ensure-section', tmpDir, homeSandboxEnv(tmpDir));
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('config-get workflow.use_worktrees returns false after setting to false', () => {
    runGsdTools('config-set workflow.use_worktrees false', tmpDir);
    const result = runGsdTools('config-get workflow.use_worktrees', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output, false);
  });

  test('config-get workflow.use_worktrees errors when not set (default config)', () => {
    // config-ensure-section does NOT include use_worktrees in hardcoded defaults,
    // so config-get should error with "Key not found". This is the expected behavior
    // that workflows rely on: the shell fallback `|| echo "true"` provides the default.
    const result = runGsdTools('config-get workflow.use_worktrees', tmpDir);
    assert.strictEqual(result.success, false);
    assert.ok(
      result.error.includes('Key not found'),
      `Expected "Key not found" in error: ${result.error}`
    );
  });

  test('config-get workflow.use_worktrees returns true after setting to true', () => {
    runGsdTools('config-set workflow.use_worktrees true', tmpDir);
    const result = runGsdTools('config-get workflow.use_worktrees', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output, true);
  });

  test('use_worktrees can be toggled back and forth', () => {
    runGsdTools('config-set workflow.use_worktrees false', tmpDir);
    runGsdTools('config-set workflow.use_worktrees true', tmpDir);
    const result = runGsdTools('config-get workflow.use_worktrees', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output, true);
  });
});

// ─── config-set/config-get audit.enabled (#4975) ─────────────────────────────
//
// `audit.enabled` is the documented config opt-in for the dispatch audit trail
// (docs/CONFIGURATION.md "Observability"). It was missing from the central
// schema, so config-set refused it as an unknown key and it could only be set
// by hand-editing config.json.

describe('config-set/config-get audit.enabled (#4975)', () => {
  test('config-set accepts audit.enabled and config-get round-trips it as a boolean', (t) => {
    const tmpDir = createTempProject('gsd-4975-config-');
    t.after(() => cleanup(tmpDir));
    const env = homeSandboxEnv(tmpDir);

    for (const value of [true, false]) {
      const set = runGsdTools(['config-set', 'audit.enabled', String(value)], tmpDir, env);
      assert.ok(set.success, `config-set audit.enabled ${value} must be accepted: ${set.error}`);
      const setResult = JSON.parse(set.output);
      assert.strictEqual(setResult.updated, true);
      assert.strictEqual(setResult.key, 'audit.enabled');
      assert.strictEqual(setResult.value, value);
      assert.strictEqual(readConfig(tmpDir).audit.enabled, value, 'persisted as a real JSON boolean');

      const get = runGsdTools(['config-get', 'audit.enabled'], tmpDir, env);
      assert.ok(get.success, `config-get audit.enabled must succeed: ${get.error}`);
      assert.strictEqual(JSON.parse(get.output), value);
    }
  });

  test('config-set rejects a non-boolean audit.enabled without modifying config.json', (t) => {
    const tmpDir = createTempProject('gsd-4975-config-invalid-');
    t.after(() => cleanup(tmpDir));
    const env = { ...homeSandboxEnv(tmpDir), GSD_JSON_ERRORS: '1' };
    writeConfig(tmpDir, { audit: { enabled: false }, sentinel: 'preserve' });
    const configPath = path.join(tmpDir, '.planning', 'config.json');
    const before = fs.readFileSync(configPath, 'utf-8');

    // The runtime gate honours only a real `true`, so storing anything else
    // would be accept-then-ignore.
    for (const value of ['yes', '1', 'TRUE', 'on', '{"on":true}']) {
      const result = runGsdTools(['config-set', 'audit.enabled', value], tmpDir, env);
      assert.strictEqual(result.success, false, `config-set audit.enabled ${value} must be rejected`);
      const envelope = JSON.parse(result.error);
      assert.strictEqual(envelope.ok, false);
      assert.notStrictEqual(envelope.reason, 'config_invalid_key',
        `audit.enabled ${value}: the key is valid — the VALUE must be what is refused`);
    }
    assert.strictEqual(fs.readFileSync(configPath, 'utf-8'), before, 'a rejected config-set must not write anything');
  });
});

// ─── config-set/config-get context ─────────────────────────────────────────

describe('config-set/config-get context', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    runGsdTools('config-ensure-section', tmpDir, homeSandboxEnv(tmpDir));
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('config set context dev succeeds', () => {
    const result = runGsdTools('config-set context dev', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.context, 'dev');
  });

  test('config set context research succeeds', () => {
    const result = runGsdTools('config-set context research', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.context, 'research');
  });

  test('config set context review succeeds', () => {
    const result = runGsdTools('config-set context review', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.context, 'review');
  });

  test('config get context returns the set value', () => {
    runGsdTools('config-set context dev', tmpDir);
    const result = runGsdTools('config-get context', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output, 'dev');
  });

  test('config set context rejects invalid values', () => {
    const result = runGsdTools('config-set context foobar', tmpDir);
    assert.strictEqual(result.success, false);
    assert.ok(
      result.error.includes('Invalid context value'),
      `Expected "Invalid context value" in error: ${result.error}`
    );
  });

  test('all three context profile files exist', () => {
    const contextsDir = path.join(__dirname, '..', 'gsd-core', 'contexts');
    assert.ok(fs.existsSync(path.join(contextsDir, 'dev.md')), 'dev.md should exist');
    assert.ok(fs.existsSync(path.join(contextsDir, 'research.md')), 'research.md should exist');
    assert.ok(fs.existsSync(path.join(contextsDir, 'review.md')), 'review.md should exist');
  });
});

// ─── config-path (#2282) ────────────────────────────────────────────────────

describe('config-path command (#2282)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    runGsdTools('config-ensure-section', tmpDir);
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('returns root config path when no workstream is active', () => {
    const result = runGsdTools('config-path', tmpDir);
    assert.ok(result.success, `config-path failed: ${result.error}`);
    // Normalize separators: Windows emits backslashes in the resolved path.
    assert.ok(result.output.trim().replace(/\\/g, '/').endsWith('.planning/config.json'), `expected root config path, got: ${result.output}`);
    assert.ok(!result.output.includes('workstreams'), 'should not include workstreams in path');
  });

  test('returns workstream config path when GSD_WORKSTREAM is set', () => {
    const result = runGsdTools('config-path', tmpDir, { GSD_WORKSTREAM: 'my-stream' });
    assert.ok(result.success, `config-path failed: ${result.error}`);
    assert.ok(result.output.trim().replace(/\\/g, '/').includes('workstreams/my-stream/config.json'), `expected workstream config path, got: ${result.output}`);
  });

  test('config-path and config-get agree on the active path', () => {
    // Write a value via config-set (uses planningDir internally)
    runGsdTools('config-set model_profile quality', tmpDir);
    // config-path should point to a file containing that value
    const pathResult = runGsdTools('config-path', tmpDir);
    const configPath = pathResult.output.trim();
    const configContent = JSON.parse(require('fs').readFileSync(configPath, 'utf-8'));
    assert.strictEqual(configContent.model_profile, 'quality', 'config-path should point to the file config-set wrote');
  });
});

// ─── config-set prototype-pollution guard (#663) ─────────────────────────────

describe('config-set prototype-pollution guard (#663)', () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = createTempProject();
    // Initialise config so there is a config.json to write to. Retry + assert
    // so a transient config-ensure-section child failure under scoped-lane load
    // cannot leave config.json absent (#770).
    await ensureConfigReady(tmpDir);
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('rejects __proto__ key segment and does not pollute Object.prototype', () => {
    const result = runGsdTools('config-set __proto__.polluted true', tmpDir);

    assert.strictEqual(result.success, false, `Expected failure but got: ${result.output}`);

    // No prototype pollution.
    assert.strictEqual(({}).polluted, undefined, '__proto__ pollution: {}.polluted should be undefined');
    assert.strictEqual(Object.prototype.polluted, undefined, '__proto__ pollution: Object.prototype.polluted should be undefined');

    // Confirm .planning/config.json does not have a 'polluted' property at any level.
    const config = readConfig(tmpDir);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(config, 'polluted'), false,
      'config.json root must not gain a "polluted" key');
  });

  test('rejects constructor.prototype key and does not pollute Object.prototype', () => {
    const result = runGsdTools('config-set constructor.prototype.polluted2 true', tmpDir);

    assert.strictEqual(result.success, false, `Expected failure but got: ${result.output}`);

    assert.strictEqual(({}).polluted2, undefined, 'constructor chain pollution: {}.polluted2 should be undefined');
    assert.strictEqual(Object.prototype.polluted2, undefined,
      'constructor chain pollution: Object.prototype.polluted2 should be undefined');
  });

  test('rejects bare prototype key segment', () => {
    const result = runGsdTools('config-set prototype.x true', tmpDir);

    assert.strictEqual(result.success, false, `Expected failure but got: ${result.output}`);
    assert.strictEqual(Object.prototype.x, undefined, 'prototype.x should not leak onto Object.prototype');
  });

  test('positive control: legitimate nested key workflow.research succeeds', () => {
    const result = runGsdTools('config-set workflow.research true', tmpDir);

    assert.ok(result.success, `Legitimate key rejected unexpectedly: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.workflow.research, true, 'workflow.research should be written to config.json');
  });
});

// ─── config-set prototype-pollution guard via dynamic-key prefixes (alert #26) ─

describe('config-set prototype-pollution guard via dynamic-key prefixes (alert #26)', () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = createTempProject();
    // Initialise config so there is a config.json to write to. Retry + assert
    // so a transient config-ensure-section child failure under scoped-lane load
    // cannot leave config.json absent (#770).
    await ensureConfigReady(tmpDir);
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('agent_skills.__proto__ is blocked by setConfigValue guard (not schema gate)', () => {
    const result = runGsdTools('config-set agent_skills.__proto__ somevalue', tmpDir);

    assert.strictEqual(result.success, false, `Expected failure but got: ${result.output}`);

    // Must be the pollution guard, not the schema gate.
    assert.ok(
      result.error.includes('prototype pollution guard'),
      `Expected "prototype pollution guard" in error, got: ${result.error}`,
    );
    // No schema-gate message.
    assert.ok(
      !result.error.includes('Unknown config key'),
      `Should not hit schema gate, got: ${result.error}`,
    );

    // No prototype pollution occurred.
    assert.strictEqual(({}).somevalue, undefined, 'agent_skills.__proto__: {}.somevalue should be undefined');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(Object.prototype, 'somevalue'), false,
      'agent_skills.__proto__: Object.prototype should not gain "somevalue"');
  });

  test('agent_skills.constructor is blocked by setConfigValue guard (not schema gate)', () => {
    const result = runGsdTools('config-set agent_skills.constructor somevalue', tmpDir);

    assert.strictEqual(result.success, false, `Expected failure but got: ${result.output}`);

    assert.ok(
      result.error.includes('prototype pollution guard'),
      `Expected "prototype pollution guard" in error, got: ${result.error}`,
    );
    assert.ok(
      !result.error.includes('Unknown config key'),
      `Should not hit schema gate, got: ${result.error}`,
    );

    assert.strictEqual(Object.prototype.hasOwnProperty.call(Object.prototype, 'somevalue'), false,
      'agent_skills.constructor: Object.prototype should not gain "somevalue"');
  });

  test('agent_skills.prototype is blocked by setConfigValue guard (not schema gate)', () => {
    const result = runGsdTools('config-set agent_skills.prototype somevalue', tmpDir);

    assert.strictEqual(result.success, false, `Expected failure but got: ${result.output}`);

    assert.ok(
      result.error.includes('prototype pollution guard'),
      `Expected "prototype pollution guard" in error, got: ${result.error}`,
    );
    assert.ok(
      !result.error.includes('Unknown config key'),
      `Should not hit schema gate, got: ${result.error}`,
    );

    assert.strictEqual(Object.prototype.hasOwnProperty.call(Object.prototype, 'somevalue'), false,
      'agent_skills.prototype: Object.prototype should not gain "somevalue"');
  });

  test('features.__proto__ is blocked by setConfigValue guard (not schema gate)', () => {
    const result = runGsdTools('config-set features.__proto__ somevalue', tmpDir);

    assert.strictEqual(result.success, false, `Expected failure but got: ${result.output}`);

    assert.ok(
      result.error.includes('prototype pollution guard'),
      `Expected "prototype pollution guard" in error, got: ${result.error}`,
    );
    assert.ok(
      !result.error.includes('Unknown config key'),
      `Should not hit schema gate, got: ${result.error}`,
    );

    assert.strictEqual(({}).somevalue, undefined, 'features.__proto__: {}.somevalue should be undefined');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(Object.prototype, 'somevalue'), false,
      'features.__proto__: Object.prototype should not gain "somevalue"');
  });

  test('agent_skills.constructor is blocked by setConfigValue guard (not schema gate)', () => {
    // #2797: this case used `review.models.constructor`, which reached the
    // setConfigValue guard only because the central pattern
    // ^review\.models\.[a-zA-Z0-9_-]+$ accepted it first. That pattern is now
    // federated to the lane capabilities and gone from the central schema, so
    // the key is rejected at the schema gate instead (asserted separately below).
    //
    // The GUARD still needs coverage, so this exercises it through a surviving
    // dynamic prefix. Losing this assertion would have quietly deleted the
    // regression test for alert #26 rather than relocating it.
    const result = runGsdTools('config-set agent_skills.constructor somevalue', tmpDir);

    assert.strictEqual(result.success, false, `Expected failure but got: ${result.output}`);

    assert.ok(
      result.error.includes('prototype pollution guard'),
      `Expected "prototype pollution guard" in error, got: ${result.error}`,
    );
    assert.ok(
      !result.error.includes('Unknown config key'),
      `Should not hit schema gate, got: ${result.error}`,
    );

    assert.strictEqual(Object.prototype.hasOwnProperty.call(Object.prototype, 'somevalue'), false,
      'agent_skills.constructor: Object.prototype should not gain "somevalue"');
  });

  test('review.models.constructor is now rejected at the schema gate (#2797)', () => {
    // Defence in depth: after federation the key never reaches setConfigValue at
    // all, because no lane declares `review.models.constructor`. Rejecting
    // earlier is strictly safer than rejecting later — this locks that it is
    // still rejected, by whichever gate gets there first.
    const result = runGsdTools('config-set review.models.constructor somevalue', tmpDir);

    assert.strictEqual(result.success, false, `Expected failure but got: ${result.output}`);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(Object.prototype, 'somevalue'), false,
      'Object.prototype must not gain "somevalue"');
  });

  test('positive control: agent_skills.sonnet-coder with valid value succeeds', () => {
    const result = runGsdTools('config-set agent_skills.sonnet-coder true', tmpDir);

    assert.ok(result.success, `Legitimate agent_skills key rejected unexpectedly: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.agent_skills['sonnet-coder'], true,
      'agent_skills.sonnet-coder should be written to config.json');
  });
});

// ─── plan_review.source_grounding + _authority (#22) ─────────────────────────

describe('plan_review.source_grounding and plan_review.source_grounding_authority (#22)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    runGsdTools('config-ensure-section', tmpDir, homeSandboxEnv(tmpDir));
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // (a) Default of plan_review.source_grounding is true
  test('plan_review.source_grounding defaults to true when not set in config.json', () => {
    const config = readConfig(tmpDir);
    assert.strictEqual(
      config.plan_review?.source_grounding,
      true,
      'plan_review.source_grounding must default to true'
    );
  });

  // (b) Default of plan_review.source_grounding_authority is "grep"
  test('plan_review.source_grounding_authority defaults to "grep" when not set in config.json', () => {
    const config = readConfig(tmpDir);
    assert.strictEqual(
      config.plan_review?.source_grounding_authority,
      'grep',
      'plan_review.source_grounding_authority must default to "grep"'
    );
  });

  // (c) Both keys are recognized as valid config keys
  test('plan_review.source_grounding is a valid config key accepted by config-set', () => {
    const result = runGsdTools('config-set plan_review.source_grounding false', tmpDir);
    assert.ok(result.success, `config-set plan_review.source_grounding failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.plan_review.source_grounding, false);
  });

  test('plan_review.source_grounding_authority is a valid config key accepted by config-set', () => {
    const result = runGsdTools('config-set plan_review.source_grounding_authority intel', tmpDir);
    assert.ok(result.success, `config-set plan_review.source_grounding_authority failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.plan_review.source_grounding_authority, 'intel');
  });

  // Enum positive: all valid authority values
  test('plan_review.source_grounding_authority accepts all valid enum values', () => {
    const validValues = ['grep', 'intel', 'treesitter', 'lsp', 'scip'];
    for (const v of validValues) {
      const result = runGsdTools(`config-set plan_review.source_grounding_authority ${v}`, tmpDir);
      assert.ok(result.success, `config-set plan_review.source_grounding_authority ${v} failed: ${result.error}`);
      const config = readConfig(tmpDir);
      assert.strictEqual(config.plan_review.source_grounding_authority, v);
    }
  });

  // (d) NEGATIVE MATRIX — invalid enum values are rejected
  test('plan_review.source_grounding_authority rejects invalid value "bogus"', () => {
    const result = runGsdTools('config-set plan_review.source_grounding_authority bogus', tmpDir);
    assert.strictEqual(result.success, false, 'bogus should be rejected');
    assert.ok(
      result.error.includes('Invalid plan_review.source_grounding_authority'),
      `Expected "Invalid plan_review.source_grounding_authority" in error: ${result.error}`
    );
  });

  test('plan_review.source_grounding_authority rejects flag-looking value "--grep"', () => {
    const result = runGsdTools(['config-set', 'plan_review.source_grounding_authority', '--grep'], tmpDir);
    assert.strictEqual(result.success, false, '--grep should be rejected');
    assert.ok(
      result.error.includes('Invalid plan_review.source_grounding_authority'),
      `Expected "Invalid plan_review.source_grounding_authority" in error: ${result.error}`
    );
  });

  test('plan_review.source_grounding_authority rejects empty string', () => {
    const result = runGsdTools(['config-set', 'plan_review.source_grounding_authority', ''], tmpDir);
    assert.strictEqual(result.success, false, 'empty string should be rejected');
  });

  test('plan_review.source_grounding rejects non-boolean value "yes"', () => {
    const result = runGsdTools('config-set plan_review.source_grounding yes', tmpDir);
    assert.strictEqual(result.success, false, '"yes" should be rejected as non-boolean');
    assert.ok(
      result.error.includes('Invalid plan_review.source_grounding'),
      `Expected "Invalid plan_review.source_grounding" in error: ${result.error}`
    );
  });

  test('plan_review.source_grounding rejects numeric value 1', () => {
    const result = runGsdTools('config-set plan_review.source_grounding 1', tmpDir);
    assert.strictEqual(result.success, false, 'numeric 1 should be rejected as non-boolean');
    assert.ok(
      result.error.includes('Invalid plan_review.source_grounding'),
      `Expected "Invalid plan_review.source_grounding" in error: ${result.error}`
    );
  });
});

// ─── config-set workflow.test_command (#1216) ────────────────────────────────

describe('config-set workflow.test_command (#1216)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    runGsdTools('config-ensure-section', tmpDir);
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('config-set accepts workflow.test_command', () => {
    const result = runGsdTools(['config-set', 'workflow.test_command', 'npm test'], tmpDir);
    assert.ok(result.success, `config-set should accept workflow.test_command: ${result.error}`);
    const config = readConfig(tmpDir);
    assert.strictEqual(config.workflow?.test_command, 'npm test', 'value must be persisted');
  });

  test('config-set workflow.test_command persists a custom make command', () => {
    const result = runGsdTools(['config-set', 'workflow.test_command', 'make test'], tmpDir);
    assert.ok(result.success, `config-set should accept workflow.test_command: ${result.error}`);
    const config = readConfig(tmpDir);
    assert.strictEqual(config.workflow?.test_command, 'make test', 'make test must be persisted');
  });

  test('config-get workflow.test_command returns the set value', () => {
    runGsdTools(['config-set', 'workflow.test_command', 'cargo test'], tmpDir);
    const result = runGsdTools('config-get workflow.test_command', tmpDir);
    assert.ok(result.success, `config-get should return workflow.test_command: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.strictEqual(output, 'cargo test', 'config-get must return the persisted value');
  });

  test('config-set accepts workflow.build_command', () => {
    const result = runGsdTools(['config-set', 'workflow.build_command', 'npm run build'], tmpDir);
    assert.ok(result.success, `config-set should accept workflow.build_command: ${result.error}`);
    const config = readConfig(tmpDir);
    assert.strictEqual(config.workflow?.build_command, 'npm run build', 'value must be persisted');
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-2601-inherit-model-profile.test.cjs — consolidation epic #1969 (B2 #1971)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-2601-inherit-model-profile (consolidation epic #1969 B2 #1971)", () => {
'use strict';

/**
 * Regression tests for bug #2601
 *
 * `config-set-model-profile inherit` (and `config-set model_profile inherit`)
 * was rejected by the validator even though the runtime accepts 'inherit' as a
 * valid model_profile value meaning "inherit from parent configuration".
 *
 * Root cause: VALID_PROFILES in model-profiles.cjs is derived from
 * Object.keys(MODEL_PROFILES['gsd-planner']), which does not include 'inherit'.
 * cmdConfigSetModelProfile() rejects any value not in VALID_PROFILES.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

describe('bug #2601: config-set-model-profile accepts inherit', () => {
  test('config-set-model-profile inherit succeeds', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    const result = runGsdTools(['config-set-model-profile', 'inherit'], tmpDir);
    assert.ok(result.success, `should accept inherit: ${result.error}`);
  });

  test('config-set model_profile inherit succeeds', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    const result = runGsdTools(['config-set', 'model_profile', 'inherit'], tmpDir);
    assert.ok(result.success, `config-set model_profile inherit should succeed: ${result.error}`);
  });

  test('config-set-model-profile inherit writes inherit to config', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    runGsdTools(['config-set-model-profile', 'inherit'], tmpDir);
    const getResult = runGsdTools(['config-get', 'model_profile'], tmpDir);
    assert.ok(getResult.success, `config-get should succeed: ${getResult.error}`);
    assert.strictEqual(JSON.parse(getResult.output), 'inherit');
  });

  test('config-set-model-profile still rejects truly invalid profiles', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    const result = runGsdTools(['config-set-model-profile', 'not-a-real-profile'], tmpDir);
    assert.ok(!result.success, 'should reject invalid profiles');
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3197-gsd-tools-config-whitelist.test.cjs — consolidation epic #1969 (B2 #1971)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3197-gsd-tools-config-whitelist (consolidation epic #1969 B2 #1971)", () => {
'use strict';

/**
 * Regression test for #3197 — gsd-tools config-set rejects workflow._auto_chain_active.
 *
 * Root cause: RUNTIME_STATE_KEYS was added to sdk/src/query/config-schema.ts in #3162
 * but not to gsd-core/bin/lib/config-schema.cjs, so gsd-tools.cjs users still hit
 * "Unknown config key" when setting workflow._auto_chain_active.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTempProject, cleanup, runGsdTools } = require('./helpers.cjs');

describe('#3197 — gsd-tools.cjs config-set workflow._auto_chain_active', () => {
  test('config-set workflow._auto_chain_active true succeeds via gsd-tools.cjs (CJS path)', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));

    const result = runGsdTools(['config-set', 'workflow._auto_chain_active', 'true'], tmpDir);
    assert.ok(
      result.success,
      `config-set workflow._auto_chain_active true should succeed, got:\nstdout: ${result.output}\nstderr: ${result.error}`
    );
  });

  test('config-set workflow._auto_chain_active true writes value to config.json', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));

    runGsdTools(['config-set', 'workflow._auto_chain_active', 'true'], tmpDir);

    const configPath = path.join(tmpDir, '.planning', 'config.json');
    assert.ok(fs.existsSync(configPath), '.planning/config.json must exist after config-set');

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.ok(
      config.workflow !== undefined && config.workflow._auto_chain_active === true,
      `Expected workflow._auto_chain_active: true in config.json, got: ${JSON.stringify(config)}`
    );
  });

  test('config-set workflow._auto_chain_active false writes false to config.json', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));

    // #6124: with the key present, a clear writes false (absent already reads false, so a clear of an absent key
    // is a no-op, covered below).
    runGsdTools(['config-set', 'workflow._auto_chain_active', 'true'], tmpDir);
    runGsdTools(['config-set', 'workflow._auto_chain_active', 'false'], tmpDir);

    const configPath = path.join(tmpDir, '.planning', 'config.json');
    assert.ok(fs.existsSync(configPath), '.planning/config.json must exist after config-set');

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.ok(
      config.workflow !== undefined && config.workflow._auto_chain_active === false,
      `Expected workflow._auto_chain_active: false in config.json, got: ${JSON.stringify(config)}`
    );
  });
});

// ─── #6124 — clearing the chaining flag when it is absent leaves the committed config untouched ──────────────────
// "The tree stays clean" is "the config file is byte-identical to what was committed", so the committed state is a
// snapshot of the file's bytes: no git process is needed.
describe('#6124 — config-set workflow._auto_chain_active false does not dirty a committed config that lacks the key', () => {
  const FLAG = 'workflow._auto_chain_active';
  const configFile = (dir) => path.join(dir, '.planning', 'config.json');
  const readConfig6124 = (dir) => fs.readFileSync(configFile(dir), 'utf8');

  function newProject(t) {
    const dir = createTempProject('gsd-6124-');
    t.after(() => cleanup(dir));
    const created = runGsdTools(['config-new-project', '{}'], dir);
    assert.ok(created.success, created.error);
    assert.equal('_auto_chain_active' in (JSON.parse(readConfig6124(dir)).workflow || {}), false, 'a new project config omits the flag');
    return { dir, committed: readConfig6124(dir) };
  }

  test('the plan-phase clear on a committed config without the key leaves the file byte-identical', (t) => {
    const { dir, committed } = newProject(t);
    const result = runGsdTools(['config-set', FLAG, 'false'], dir);
    assert.ok(result.success, result.error);
    assert.equal(readConfig6124(dir), committed, 'the committed config is untouched');
    assert.equal(JSON.parse(result.output).value, false, 'the command still reports the requested value');
  });

  test('a config with no workflow block at all is not given one by the clear', (t) => {
    const dir = createTempProject('gsd-6124-');
    t.after(() => cleanup(dir));
    fs.writeFileSync(configFile(dir), '{}\n');
    assert.ok(runGsdTools(['config-set', FLAG, 'false'], dir).success);
    assert.equal(readConfig6124(dir), '{}\n');
  });

  test('no config file is created by the clear, and a non-object workflow value is still replaced', (t) => {
    const missing = createTempDir('gsd-6124-');
    t.after(() => cleanup(missing));
    fs.mkdirSync(path.join(missing, '.planning'), { recursive: true });
    assert.ok(runGsdTools(['config-set', FLAG, 'false'], missing).success);
    assert.equal(fs.existsSync(configFile(missing)), false, 'reading an absent config already yields false, so nothing is written');

    const odd = createTempProject('gsd-6124-');
    t.after(() => cleanup(odd));
    fs.writeFileSync(configFile(odd), JSON.stringify({ workflow: 'broken' }));
    assert.ok(runGsdTools(['config-set', FLAG, 'false'], odd).success);
    assert.deepEqual(JSON.parse(readConfig6124(odd)).workflow, { _auto_chain_active: false }, 'a malformed parent keeps the pre-#6124 replacement');
  });

  test('--dry-run states what the write does: no update for the absent-key clear, an update otherwise', (t) => {
    const { dir, committed } = newProject(t);
    const cleared = JSON.parse(runGsdTools(['config-set', FLAG, 'false', '--dry-run'], dir).output);
    assert.equal(cleared.dry_run, true);
    assert.equal(cleared.would_update, false, 'the real run writes nothing');
    const set = JSON.parse(runGsdTools(['config-set', FLAG, 'true', '--dry-run'], dir).output);
    assert.equal(set.would_update, true, 'setting true is a real change');
    assert.equal(readConfig6124(dir), committed, 'a dry run never writes');
  });

  test('clearing a committed true writes false, and starting a chained run writes true', (t) => {
    const { dir } = newProject(t);
    assert.ok(runGsdTools(['config-set', FLAG, 'true'], dir).success);
    assert.equal(JSON.parse(readConfig6124(dir)).workflow._auto_chain_active, true);
    const committedTrue = readConfig6124(dir);
    assert.ok(runGsdTools(['config-set', FLAG, 'false'], dir).success);
    assert.equal(JSON.parse(readConfig6124(dir)).workflow._auto_chain_active, false, 'a stale true is cleared');
    assert.notEqual(readConfig6124(dir), committedTrue, 'the clear of a present key is a real change');
  });

  test('a committed false cleared again leaves the file untouched, and any other explicit config-set still writes', (t) => {
    const { dir } = newProject(t);
    assert.ok(runGsdTools(['config-set', FLAG, 'true'], dir).success);
    assert.ok(runGsdTools(['config-set', FLAG, 'false'], dir).success);
    const committedFalse = readConfig6124(dir);
    assert.ok(runGsdTools(['config-set', FLAG, 'false'], dir).success);
    assert.equal(readConfig6124(dir), committedFalse, 'rewriting the same false changes nothing');
    assert.ok(runGsdTools(['config-set', 'workflow.auto_advance', 'false'], dir).success);
    assert.equal(JSON.parse(readConfig6124(dir)).workflow.auto_advance, false, 'an explicit set of another key still writes the file');
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3086-git-create-tag-config-gate.test.cjs — consolidation epic #1969 (B2 #1971)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3086-git-create-tag-config-gate (consolidation epic #1969 B2 #1971)", () => {
// allow-test-rule: source-text-is-the-product (see #3086)
// Justification: complete-milestone.md IS the runtime — the agent reads and
// follows it directly. Asserting the <config-check> block is present in the
// markdown is the only way to verify the gate is wired. Per CONTEXT.md L611.
'use strict';

/**
 * #3086 — git.create_tag config gate for milestone tagging.
 *
 * Tests:
 *   A. Default value: fresh project returns `true` for git.create_tag
 *   B. config-set false → config-get returns false
 *   C. Invalid value (e.g. "maybe") is rejected by schema validator
 *   D. complete-milestone.md workflow contains the <config-check> gate for git.create_tag
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createTempProject, cleanup, runGsdTools } = require('./helpers.cjs');

const WORKFLOW_PATH = path.join(
  __dirname,
  '..',
  'gsd-core',
  'workflows',
  'complete-milestone.md',
);

describe('#3086: git.create_tag config key', () => {
  test('A. fresh project: config-get git.create_tag returns true (default)', (t) => {
    const tmpDir = createTempProject('gsd-3086-default-');
    t.after(() => cleanup(tmpDir));

    const result = runGsdTools(['config-get', 'git.create_tag'], tmpDir, homeSandboxEnv(tmpDir));
    assert.ok(result.success, `config-get git.create_tag failed:\n${result.error}`);
    assert.strictEqual(
      result.output.trim(),
      'true',
      `Expected default value 'true', got: '${result.output.trim()}'`,
    );
  });

  test('B. config-set git.create_tag false → config-get returns false', (t) => {
    const tmpDir = createTempProject('gsd-3086-set-false-');
    t.after(() => cleanup(tmpDir));

    const setResult = runGsdTools(['config-set', 'git.create_tag', 'false'], tmpDir, homeSandboxEnv(tmpDir));
    assert.ok(setResult.success, `config-set git.create_tag false failed:\n${setResult.error}`);

    const getResult = runGsdTools(['config-get', 'git.create_tag'], tmpDir, homeSandboxEnv(tmpDir));
    assert.ok(getResult.success, `config-get after set failed:\n${getResult.error}`);
    assert.strictEqual(
      getResult.output.trim(),
      'false',
      `Expected 'false' after set, got: '${getResult.output.trim()}'`,
    );
  });

  test('C. config-set git.create_tag with invalid value "maybe" is rejected', (t) => {
    const tmpDir = createTempProject('gsd-3086-invalid-');
    t.after(() => cleanup(tmpDir));

    const result = runGsdTools(['config-set', 'git.create_tag', 'maybe'], tmpDir, homeSandboxEnv(tmpDir));
    assert.ok(
      !result.success,
      `Expected config-set to fail for invalid value "maybe", but it succeeded`,
    );
  });

  test('D. complete-milestone.md gates git_tag behind state:git-create-tag (#2994: <config-check> hoisted into cmdInitCompleteMilestone)', () => {
    // #2994: the inline <config-check> (`gsd-tools.cjs query config-get
    // git.create_tag ... || echo "true"`) that used to gate the git_tag step's
    // own inclusion was hoisted into `detectGitCreateTag` (src/init.cts),
    // consumed by the new `cmdInitCompleteMilestone` entry point and exposed
    // as the init-bundle's `git_create_tag` field / the `state:git-create-tag`
    // when= atom. The workflow markdown no longer contains a literal
    // <config-check> block or `git.create_tag` string — it gates the whole
    // git_tag step behind a gsd:section marker instead.
    const content = fs.readFileSync(WORKFLOW_PATH, 'utf8');
    assert.ok(
      content.includes('<!-- gsd:section id="git-tag" when="state:git-create-tag" -->'),
      'complete-milestone.md must gate the git_tag step behind the state:git-create-tag section marker',
    );
    assert.ok(
      content.includes('gsd-core/workflows/complete-milestone/steps/git-tag.md'),
      'complete-milestone.md must point the git-tag section at its step file',
    );

    const stepFile = fs.readFileSync(
      path.join(__dirname, '..', 'gsd-core', 'workflows', 'complete-milestone', 'steps', 'git-tag.md'),
      'utf8',
    );
    assert.ok(
      stepFile.includes('<step name="git_tag">') && stepFile.includes('git tag -a'),
      'git-tag.md step file must contain the git_tag step body (git tag creation)',
    );
  });

  // #3508: behavioral replacement for the `detectGitCreateTag` source-grep
  // that used to sit here. `detectGitCreateTag` (src/init.cts) is unexported,
  // but its EFFECT is observable through `init complete-milestone`'s
  // `git_create_tag` output field (wired at cmdInitCompleteMilestone,
  // gsd-core/bin/lib/init-command-router.cjs's 'complete-milestone' handler)
  // -- driving the real CLI with git.create_tag set both ways proves
  // detectGitCreateTag resolves THAT config key specifically (not just that
  // config-get does, which tests A/B above already cover) without reading
  // init.cts's source text.
  test('D2. init complete-milestone\'s git_create_tag field tracks the git.create_tag config key (behavioral form of detectGitCreateTag)', (t) => {
    const tmpDir = createTempProject('gsd-3086-detect-git-create-tag-');
    t.after(() => cleanup(tmpDir));

    const setFalse = runGsdTools(['config-set', 'git.create_tag', 'false'], tmpDir, homeSandboxEnv(tmpDir));
    assert.ok(setFalse.success, `config-set git.create_tag false failed:\n${setFalse.error}`);

    const falseResult = runGsdTools(['init', 'complete-milestone'], tmpDir, homeSandboxEnv(tmpDir));
    assert.ok(falseResult.success, `init complete-milestone failed:\n${falseResult.error}`);
    assert.strictEqual(
      JSON.parse(falseResult.output).git_create_tag,
      false,
      'init complete-milestone must report git_create_tag: false once git.create_tag is set false',
    );

    const setTrue = runGsdTools(['config-set', 'git.create_tag', 'true'], tmpDir, homeSandboxEnv(tmpDir));
    assert.ok(setTrue.success, `config-set git.create_tag true failed:\n${setTrue.error}`);

    const trueResult = runGsdTools(['init', 'complete-milestone'], tmpDir, homeSandboxEnv(tmpDir));
    assert.ok(trueResult.success, `init complete-milestone failed:\n${trueResult.error}`);
    assert.strictEqual(
      JSON.parse(trueResult.output).git_create_tag,
      true,
      'init complete-milestone must report git_create_tag: true once git.create_tag is set true',
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/feat-3167-ship-pr-body-sections.test.cjs — consolidation epic #1969 (B2 #1971)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:feat-3167-ship-pr-body-sections (consolidation epic #1969 B2 #1971)", () => {
/**
 * Regression tests for issue #3167: configurable /gsd-ship PR body sections.
 */

// allow-test-rule: source-text-is-the-product (see #3167)
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, test, afterEach } = require('node:test');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

const repoRoot = path.resolve(__dirname, '..');
const tmpDirs = [];

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function makeProject() {
  const tmpDir = createTempProject('gsd-3167-');
  tmpDirs.push(tmpDir);
  return tmpDir;
}

afterEach(() => {
  while (tmpDirs.length) {
    cleanup(tmpDirs.pop());
  }
});

describe('ship.pr_body_sections config (#3167)', () => {
  test('CLI config-set accepts additional PR body section arrays', () => {
    const cwd = makeProject();
    const value = JSON.stringify([
      {
        heading: 'Risks & Rollback',
        enabled: true,
        source: 'PLAN.md ## Risks || PLAN.md ## Rollback',
        fallback: '- Rollback: revert this PR.',
      },
      {
        heading: 'Stakeholder Sign-off',
        enabled: false,
        template: '- Product owner: pending',
      },
    ]);

    const result = runGsdTools(['config-set', 'ship.pr_body_sections', value, '--raw'], cwd, homeSandboxEnv(cwd));

    assert.equal(result.success, true, result.error);
    const config = JSON.parse(fs.readFileSync(path.join(cwd, '.planning', 'config.json'), 'utf8'));
    assert.deepEqual(config.ship.pr_body_sections, [
      {
        heading: 'Risks & Rollback',
        enabled: true,
        source: 'PLAN.md ## Risks || PLAN.md ## Rollback',
        fallback: '- Rollback: revert this PR.',
      },
      {
        heading: 'Stakeholder Sign-off',
        enabled: false,
        template: '- Product owner: pending',
      },
    ]);
  });

  test('CLI config-set rejects malformed PR body section values before writing config', () => {
    const cwd = makeProject();

    const notArray = runGsdTools(
      ['config-set', 'ship.pr_body_sections', JSON.stringify({ heading: 'Not an array' }), '--raw'],
      cwd,
      homeSandboxEnv(cwd)
    );
    assert.equal(notArray.success, false);
    assert.match(notArray.error, /ship\.pr_body_sections.*JSON array/);

    const missingHeading = runGsdTools(
      ['config-set', 'ship.pr_body_sections', JSON.stringify([{ fallback: '- Missing heading' }]), '--raw'],
      cwd,
      homeSandboxEnv(cwd)
    );
    assert.equal(missingHeading.success, false);
    assert.match(missingHeading.error, /heading/);

    const invalidEnabled = runGsdTools(
      ['config-set', 'ship.pr_body_sections', JSON.stringify([{ heading: 'Toggle', enabled: 'yes', fallback: '- item' }]), '--raw'],
      cwd,
      homeSandboxEnv(cwd)
    );
    assert.equal(invalidEnabled.success, false);
    assert.match(invalidEnabled.error, /enabled/);

    assert.equal(fs.existsSync(path.join(cwd, '.planning', 'config.json')), false);
  });

  test('CLI config-new-project validates onboarded PR body sections before writing config', () => {
    const cwd = makeProject();
    const choices = JSON.stringify({
      ship: {
        pr_body_sections: [
          {
            heading: 'Invalid source',
            source: 'package.json ## Scripts',
          },
        ],
      },
    });

    const result = runGsdTools(['config-new-project', choices], cwd, homeSandboxEnv(cwd));

    assert.equal(result.success, false);
    assert.match(result.error, /source must use selectors/);
    assert.equal(fs.existsSync(path.join(cwd, '.planning', 'config.json')), false);
  });

  test('ship workflow composes configured sections as append-only extensions', () => {
    const workflow = readRepoFile('gsd-core/workflows/ship.md');

    assert.match(workflow, /config-get ship\.pr_body_sections --default '\[\]'/);
    assert.match(workflow, /append-only/i);
    assert.match(workflow, /enabled.*false/i);
    assert.match(workflow, /cannot replace/i);
    assert.match(workflow, /Summary[\s\S]*Changes[\s\S]*Requirements Addressed[\s\S]*Verification[\s\S]*Key Decisions/);
    assert.match(workflow, /\{phase_number\}[\s\S]*\{phase_name\}[\s\S]*\{phase_dir\}[\s\S]*\{base_branch\}[\s\S]*\{padded_phase\}/);
    assert.match(workflow, /User Stories & Acceptance Criteria/);
    assert.match(workflow, /Definition of Done/);
    assert.match(workflow, /--body-file/);
    assert.match(workflow, /trap 'rm -f "\$\{PR_BODY_FILE:-\}"' EXIT/);
  });

  test('default config and documentation describe ship.pr_body_sections', () => {
    const template = JSON.parse(readRepoFile('gsd-core/templates/config.json'));
    assert.deepEqual(template.ship.pr_body_sections, []);

    const docs = readRepoFile('docs/CONFIGURATION.md');
    assert.match(docs, /`ship\.pr_body_sections`/);
    assert.match(docs, /additional PR body sections/i);
    assert.match(docs, /append-only/i);
    assert.match(docs, /lean\/agile PRD/i);
    assert.match(docs, /Definition of Done/);

    const planningConfig = readRepoFile('gsd-core/references/planning-config.md');
    assert.match(planningConfig, /ship\.pr_body_sections/);
  });

  test('new-project onboarding can seed enabled or disabled PR body sections', () => {
    const workflow = readRepoFile('gsd-core/workflows/new-project.md');

    assert.match(workflow, /ship\.pr_body_sections/);
    assert.match(workflow, /enabled.*true/);
    assert.match(workflow, /enabled.*false/);
    assert.match(workflow, /User Stories & Acceptance Criteria/);
    assert.match(workflow, /Risks & Dependencies/);
    assert.match(workflow, /Success Metrics & Release Criteria/);
    assert.match(workflow, /Stakeholder Review & Approval/);
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/feat-3210-fallow-schema-enum.test.cjs — consolidation epic #1969 (B2 #1971)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:feat-3210-fallow-schema-enum (consolidation epic #1969 B2 #1971)", () => {
'use strict';

/**
 * Enum validation for code_quality.fallow.scope and code_quality.fallow.profile.
 *
 * Fixes H5 from #3424 review: config-set silently accepted invalid enum values
 * (e.g. scope=fullrepo) and fell through to default behavior. This test asserts
 * that invalid values are rejected with a helpful error, and valid values pass.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { createTempProject, cleanup, runGsdTools } = require('./helpers.cjs');

describe('feat-3210 / H5: enum validation for code_quality.fallow.scope and .profile', () => {
  // --- code_quality.fallow.scope ---

  test('config-set code_quality.fallow.scope=fullrepo is REJECTED with helpful error', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));

    const result = runGsdTools(
      ['config-set', 'code_quality.fallow.scope', 'fullrepo'],
      tmpDir
    );
    assert.ok(
      !result.success,
      'config-set code_quality.fallow.scope=fullrepo must fail, but it succeeded'
    );
    const combined = (result.output || '') + (result.error || '');
    assert.ok(
      combined.includes('phase') && combined.includes('repo'),
      `Error message must mention valid values "phase" and "repo", got: ${combined}`
    );
  });

  test('config-set code_quality.fallow.scope=phase is ACCEPTED', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));

    const result = runGsdTools(
      ['config-set', 'code_quality.fallow.scope', 'phase'],
      tmpDir
    );
    assert.ok(
      result.success,
      [
        'config-set code_quality.fallow.scope=phase must succeed,',
        'stdout: ' + result.output,
        'stderr: ' + result.error,
      ].join('\n')
    );
  });

  test('config-set code_quality.fallow.scope=repo is ACCEPTED', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));

    const result = runGsdTools(
      ['config-set', 'code_quality.fallow.scope', 'repo'],
      tmpDir
    );
    assert.ok(
      result.success,
      [
        'config-set code_quality.fallow.scope=repo must succeed,',
        'stdout: ' + result.output,
        'stderr: ' + result.error,
      ].join('\n')
    );
  });

  test('config-set code_quality.fallow.scope=PHASE (wrong case) is REJECTED', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));

    const result = runGsdTools(
      ['config-set', 'code_quality.fallow.scope', 'PHASE'],
      tmpDir
    );
    assert.ok(
      !result.success,
      'config-set code_quality.fallow.scope=PHASE must fail (values are case-sensitive)'
    );
  });

  // --- code_quality.fallow.profile ---

  test('config-set code_quality.fallow.profile=aggressive is REJECTED with helpful error', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));

    const result = runGsdTools(
      ['config-set', 'code_quality.fallow.profile', 'aggressive'],
      tmpDir
    );
    assert.ok(
      !result.success,
      'config-set code_quality.fallow.profile=aggressive must fail, but it succeeded'
    );
    const combined = (result.output || '') + (result.error || '');
    assert.ok(
      combined.includes('minimal') && combined.includes('standard') && combined.includes('strict'),
      `Error message must mention valid values "minimal", "standard", "strict", got: ${combined}`
    );
  });

  test('config-set code_quality.fallow.profile=minimal is ACCEPTED', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));

    const result = runGsdTools(
      ['config-set', 'code_quality.fallow.profile', 'minimal'],
      tmpDir
    );
    assert.ok(
      result.success,
      [
        'config-set code_quality.fallow.profile=minimal must succeed,',
        'stdout: ' + result.output,
        'stderr: ' + result.error,
      ].join('\n')
    );
  });

  test('config-set code_quality.fallow.profile=standard is ACCEPTED', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));

    const result = runGsdTools(
      ['config-set', 'code_quality.fallow.profile', 'standard'],
      tmpDir
    );
    assert.ok(
      result.success,
      [
        'config-set code_quality.fallow.profile=standard must succeed,',
        'stdout: ' + result.output,
        'stderr: ' + result.error,
      ].join('\n')
    );
  });

  test('config-set code_quality.fallow.profile=strict is ACCEPTED', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));

    const result = runGsdTools(
      ['config-set', 'code_quality.fallow.profile', 'strict'],
      tmpDir
    );
    assert.ok(
      result.success,
      [
        'config-set code_quality.fallow.profile=strict must succeed,',
        'stdout: ' + result.output,
        'stderr: ' + result.error,
      ].join('\n')
    );
  });

  test('config-set code_quality.fallow.profile=unknown is REJECTED', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));

    const result = runGsdTools(
      ['config-set', 'code_quality.fallow.profile', 'unknown'],
      tmpDir
    );
    assert.ok(
      !result.success,
      'config-set code_quality.fallow.profile=unknown must fail'
    );
  });
});
  });
}

// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3212-execute-phase-stall-safe-resume.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3212-execute-phase-stall-safe-resume (consolidation epic #1969 B3 #1972)", () => {
'use strict';

// allow-test-rule: source-text-is-the-product [#3212]
// The bug is in workflow/config contracts consumed by agents at runtime.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { cleanup } = require('./helpers.cjs');
const { runGsdToolsCaptured } = require('./helpers.cjs');

const ROOT = path.join(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

describe('bug #3212 execute-phase stall detection and safe resume', () => {
  test('config schemas register executor stall detector keys', () => {
    // After Cycle 5 (#3536), both CJS and SDK source from the manifest.
    // Use the CJS runtime Set for CJS; use the manifest directly for SDK-side
    // verification (since config-schema.ts no longer has inline literals).
    const { VALID_CONFIG_KEYS: cjsKeys } = require('../gsd-core/bin/lib/config-schema.cjs');
    const manifest = JSON.parse(read('gsd-core/bin/shared/config-schema.manifest.json'));
    const manifestKeys = new Set(manifest.validKeys);

    for (const key of ['executor.stall_detect_interval_minutes', 'executor.stall_threshold_minutes']) {
      assert.ok(cjsKeys.has(key), `CJS VALID_CONFIG_KEYS must include ${key}`);
      assert.ok(manifestKeys.has(key), `Manifest validKeys must include ${key} (SDK sources from manifest)`);
    }
  });

  test('configuration docs describe stall detector defaults', () => {
    const docs = read('docs/CONFIGURATION.md');

    assert.match(docs, /`executor\.stall_detect_interval_minutes`\s*\|\s*number\s*\|\s*`5`/);
    assert.match(docs, /`executor\.stall_threshold_minutes`\s*\|\s*number\s*\|\s*`10`/);
  });

  test('config-get returns schema defaults for executor stall detector keys', (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3212-'));
    t.after(() => cleanup(tmp));
    fs.mkdirSync(path.join(tmp, '.planning'));
    fs.writeFileSync(path.join(tmp, '.planning/config.json'), '{}\n');

    const interval = runGsdToolsCaptured(['config-get', 'executor.stall_detect_interval_minutes', '--raw'], tmp);
    const threshold = runGsdToolsCaptured(['config-get', 'executor.stall_threshold_minutes', '--raw'], tmp);

    assert.equal(interval.exitCode, 0, interval.stderr);
    assert.equal(interval.stdout.trim(), '5');
    assert.equal(threshold.exitCode, 0, threshold.stderr);
    assert.equal(threshold.stdout.trim(), '10');
  });

  test('execute-phase verifies partial-plan drift before dispatch', () => {
    const workflow = read('gsd-core/workflows/execute-phase.md');

    assert.match(workflow, /<step name="safe_resume_gate"/, 'execute-phase must define a safe_resume_gate step');
    // #4003 -> #5164: the gate asks the evaluation-scope resolver, which matches an anchored,
    // zero-pad-tolerant subject pattern for the current plan id (a bare padded substring matched
    // other milestones' plans), bounded to the current milestone.
    assert.match(workflow, /gsd_run check evaluation-scope --plan "\$\{PHASE_NUMBER\}-\{plan_padded\}" --commits-only --milestone-bound/, 'safe resume gate must check commits for the current plan id through the resolver');
    assert.match(workflow, /SUMMARY.md is missing/, 'safe resume gate must detect production commits with missing SUMMARY.md');
    assert.match(workflow, /close out manually/, 'safe resume gate must offer manual close-out recovery');
    assert.match(workflow, /re-execute from scratch/, 'safe resume gate must offer re-execute recovery');
    assert.match(workflow, /mark-and-skip/, 'safe resume gate must offer mark-and-skip recovery');
  });

  test('execute-phase has configurable executor stall surveillance after dispatch', () => {
    const workflow = read('gsd-core/workflows/execute-phase.md');

    assert.match(workflow, /EXECUTOR_STALL_INTERVAL_MINUTES=.*executor\.stall_detect_interval_minutes/);
    assert.match(workflow, /EXECUTOR_STALL_THRESHOLD_MINUTES=.*executor\.stall_threshold_minutes/);
    assert.match(workflow, /DISPATCH_TS=/, 'execute-phase must record dispatch timestamp');
    assert.match(workflow, /EXPECTED_BRANCH=/, 'execute-phase must record expected branch');
    assert.match(workflow, /git log "\$\{EXPECTED_BRANCH\}" --since="\$\{DISPATCH_TS\}"/, 'stall check must inspect branch commits since dispatch');
    assert.match(workflow, /continue waiting/, 'stall warning must offer continue waiting');
    assert.match(workflow, /kill and retry/, 'stall warning must offer kill and retry');
    assert.match(workflow, /kill and switch to inline execution/, 'stall warning must offer inline fallback');
  });

  test('execute-plan documents atomic close-out invariant', () => {
    const workflow = read('gsd-core/workflows/execute-plan.md');

    assert.match(workflow, /<atomic_close_out_invariant>/, 'execute-plan must contain a formal atomic close-out invariant');
    assert.match(workflow, /production-code commit\(s\) -> SUMMARY commit -> STATE\/ROADMAP update/, 'invariant must name the legal close-out sequence');
    assert.match(workflow, /only legal half-state is mid-production-commits/, 'invariant must define the only legal half-state');
  });

  test('forensics includes the partial-plan drift detector', () => {
    const workflow = read('gsd-core/workflows/forensics.md');

    assert.match(workflow, /Partial-plan Drift Detection/);
    assert.match(workflow, /commits exist but SUMMARY.md is missing/);
    assert.match(workflow, /safe-resume verifier/);
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3227-config-set-model-overrides.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3227-config-set-model-overrides (consolidation epic #1969 B3 #1972)", () => {
'use strict';

/**
 * Regression test for bug #3227 — config-set rejects model_overrides.<agent-id>.
 *
 * `gsd-sdk query config-set model_overrides.gsd-plan-checker opus` was
 * rejected with "Unknown config key" because `model_overrides.<agent-id>` was
 * missing from DYNAMIC_KEY_PATTERNS in both the CJS schema and the SDK schema.
 *
 * The override mechanism itself worked correctly (resolve-model returned the
 * override after a direct file edit). Only the write path was gated wrong.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTempProject, cleanup, runGsdTools } = require('./helpers.cjs');
const { DYNAMIC_KEY_PATTERNS, isValidConfigKey } = require('../gsd-core/bin/lib/config-schema.cjs');

describe('#3227 — config-set accepts model_overrides.<agent-id>', () => {
  test('isValidConfigKey accepts model_overrides.gsd-plan-checker', () => {
    assert.ok(
      isValidConfigKey('model_overrides.gsd-plan-checker'),
      'model_overrides.gsd-plan-checker must be accepted by isValidConfigKey'
    );
  });

  test('isValidConfigKey accepts model_overrides with various agent-id formats', () => {
    const validKeys = [
      'model_overrides.gsd-executor',
      'model_overrides.gsd-planner',
      'model_overrides.gsd-codebase-mapper',
      'model_overrides.my_custom_agent',
      'model_overrides.agent123',
    ];
    for (const key of validKeys) {
      assert.ok(isValidConfigKey(key), `isValidConfigKey must accept ${key}`);
    }
  });

  test('isValidConfigKey rejects bare model_overrides (no agent-id)', () => {
    assert.ok(
      !isValidConfigKey('model_overrides'),
      'bare model_overrides must be rejected (use model_overrides.<agent-id>)'
    );
  });

  test('DYNAMIC_KEY_PATTERNS includes an entry for model_overrides', () => {
    const hasPattern = DYNAMIC_KEY_PATTERNS.some(
      (p) => p.description && p.description.includes('model_overrides')
    );
    assert.ok(hasPattern, 'DYNAMIC_KEY_PATTERNS must have an entry covering model_overrides.<agent-id>');
  });

  test('config-set model_overrides.gsd-plan-checker opus succeeds via gsd-tools.cjs', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));

    const result = runGsdTools(
      ['config-set', 'model_overrides.gsd-plan-checker', 'opus'],
      tmpDir
    );
    assert.ok(
      result.success,
      [
        'config-set model_overrides.gsd-plan-checker opus should succeed,',
        'got:',
        'stdout: ' + result.output,
        'stderr: ' + result.error,
      ].join('\n')
    );
  });

  test('config-set model_overrides.gsd-plan-checker opus writes to config.json', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));

    runGsdTools(['config-set', 'model_overrides.gsd-plan-checker', 'opus'], tmpDir);

    const configPath = path.join(tmpDir, '.planning', 'config.json');
    assert.ok(fs.existsSync(configPath), '.planning/config.json must exist after config-set');

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.ok(
      config.model_overrides !== undefined &&
        config.model_overrides['gsd-plan-checker'] === 'opus',
      [
        'Expected model_overrides["gsd-plan-checker"]: "opus" in config.json,',
        'got: ' + JSON.stringify(config),
      ].join('\n')
    );
  });

  test('config-get model_overrides.gsd-plan-checker returns opus after config-set', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));

    runGsdTools(['config-set', 'model_overrides.gsd-plan-checker', 'opus'], tmpDir);

    const getResult = runGsdTools(
      ['config-get', 'model_overrides.gsd-plan-checker'],
      tmpDir
    );
    assert.ok(
      getResult.success,
      [
        'config-get model_overrides.gsd-plan-checker should succeed,',
        'got:',
        'stdout: ' + getResult.output,
        'stderr: ' + getResult.error,
      ].join('\n')
    );
    assert.ok(
      getResult.output.includes('opus'),
      'config-get output should contain "opus", got: ' + getResult.output
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/feat-1452-context-guard-mode.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:feat-1452-context-guard-mode (consolidation epic #1969 B3 #1972)", () => {
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
    const result = runGsdTools('config-ensure-section', tmpDir, homeSandboxEnv(tmpDir));
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
    runGsdTools('config-ensure-section', tmpDir, homeSandboxEnv(tmpDir));
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
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/feat-3309-human-verify-mode.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:feat-3309-human-verify-mode (consolidation epic #1969 B3 #1972)", () => {
// allow-test-rule: source-text-is-the-product (see #3309)
// Planner and verifier agent .md files ARE the runtime contract loaded by
// the AI runtimes. Asserting that the canonical wording for the new
// `workflow.human_verify_mode` flag is present in those files is the only
// way to verify the agents will respect the flag at runtime.

/**
 * Enhancement #3309: workflow.human_verify_mode = end-of-phase
 *
 * "mid-flight" preserves the pre-#3309 behavior — the planner emits
 * `<task type="checkpoint:human-verify">` tasks, and the executor halts at
 * each one. Each halt costs a full executor cold-start (CLAUDE.md, MEMORY.md,
 * STATE.md, plan re-read) because subagent context is discarded across the
 * pause.
 *
 * "end-of-phase" (the new default) instructs the planner NOT to emit
 * `checkpoint:human-verify` tasks and instead embed the verification details
 * into the relevant `auto` task's `<verify><human-check>` block. The verifier
 * (Step 8) harvests these blocks at end-of-phase and consolidates them into the existing
 * `human_needed` → HUMAN-UAT.md path, restoring the v1.35-shaped behavior
 * the reporter wanted without resurrecting the v1.35 writer.
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

describe('workflow.human_verify_mode in VALID_CONFIG_KEYS', () => {
  test('is a recognized config key', () => {
    const { VALID_CONFIG_KEYS } = require('../gsd-core/bin/lib/config.cjs');
    assert.ok(
      VALID_CONFIG_KEYS.has('workflow.human_verify_mode'),
      'workflow.human_verify_mode should be in VALID_CONFIG_KEYS',
    );
  });
});

// ─── Default value (CJS) ──────────────────────────────────────────────────────

describe('workflow.human_verify_mode default value', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { cleanup(tmpDir); });

  test('defaults to end-of-phase in new project config', () => {
    const result = runGsdTools('config-ensure-section', tmpDir, homeSandboxEnv(tmpDir));
    assert.ok(result.success, `config-ensure-section failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(
      config.workflow.human_verify_mode,
      'end-of-phase',
      'workflow.human_verify_mode should default to "end-of-phase" — the cost-control mode is the project default; opt back into the pre-#3309 mid-flight behavior with config-set',
    );
  });
});

// ─── Round-trip ──────────────────────────────────────────────────────────────

describe('workflow.human_verify_mode config round-trip', () => {
  let tmpDir;
  beforeEach(() => {
    tmpDir = createTempProject();
    runGsdTools('config-ensure-section', tmpDir, homeSandboxEnv(tmpDir));
  });
  afterEach(() => { cleanup(tmpDir); });

  test('config-set end-of-phase persists to config.json', () => {
    const setResult = runGsdTools('config-set workflow.human_verify_mode end-of-phase', tmpDir);
    assert.ok(setResult.success, `config-set failed: ${setResult.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.workflow.human_verify_mode, 'end-of-phase');
  });

  test('config-set mid-flight overwrites end-of-phase in config.json', () => {
    runGsdTools('config-set workflow.human_verify_mode end-of-phase', tmpDir);

    const setResult = runGsdTools('config-set workflow.human_verify_mode mid-flight', tmpDir);
    assert.ok(setResult.success, `config-set failed: ${setResult.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.workflow.human_verify_mode, 'mid-flight');
  });

  test('persists in config.json as string', () => {
    runGsdTools('config-set workflow.human_verify_mode end-of-phase', tmpDir);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.workflow.human_verify_mode, 'end-of-phase');
    assert.strictEqual(typeof config.workflow.human_verify_mode, 'string');
  });

  test('rejects invalid mode values', () => {
    const result = runGsdTools('config-set workflow.human_verify_mode midflight', tmpDir);
    assert.strictEqual(result.success, false);
    assert.match(result.error, /Invalid workflow\.human_verify_mode 'midflight'/);
    assert.match(result.error, /mid-flight, end-of-phase/);
  });
});

// ─── Planner agent contract ──────────────────────────────────────────────────

describe('agents/gsd-planner.md acknowledges workflow.human_verify_mode', () => {
  let plannerSrc;

  test('loads', () => {
    plannerSrc = fs.readFileSync(path.join(REPO_ROOT, 'agents', 'gsd-planner.md'), 'utf-8');
    assert.ok(plannerSrc.length > 0);
  });

  test('mentions workflow.human_verify_mode by canonical name', () => {
    plannerSrc = plannerSrc || fs.readFileSync(path.join(REPO_ROOT, 'agents', 'gsd-planner.md'), 'utf-8');
    assert.ok(
      plannerSrc.includes('workflow.human_verify_mode'),
      'planner must reference the flag by canonical key so the runtime can resolve config-driven behavior',
    );
  });

  test('explains the end-of-phase behavior (do NOT emit checkpoint:human-verify)', () => {
    plannerSrc = plannerSrc || fs.readFileSync(path.join(REPO_ROOT, 'agents', 'gsd-planner.md'), 'utf-8');
    // The planner must instruct: when end-of-phase, do NOT emit checkpoint:human-verify
    assert.ok(
      /end-of-phase[\s\S]{0,400}checkpoint:human-verify/i.test(plannerSrc) ||
      /checkpoint:human-verify[\s\S]{0,400}end-of-phase/i.test(plannerSrc),
      'planner must couple "end-of-phase" mode with the rule that checkpoint:human-verify tasks are not emitted',
    );
  });

  test('routes deferred verification through the <verify><human-check> block on auto tasks', () => {
    plannerSrc = plannerSrc || fs.readFileSync(path.join(REPO_ROOT, 'agents', 'gsd-planner.md'), 'utf-8');
    assert.ok(
      /`?<verify>`?\s*[\s\S]{0,200}`?<human-check>`?/i.test(plannerSrc) ||
      plannerSrc.includes('<verify><human-check>') ||
      plannerSrc.includes('`<verify><human-check>`'),
      'planner must document the <verify><human-check>...</human-check></verify> shape so the verifier can harvest deferred items',
    );
  });
});

// ─── Verifier agent contract ─────────────────────────────────────────────────

describe('agents/gsd-verifier.md harvests deferred human verification items', () => {
  test('Step 8 mentions harvesting <verify><human-check> blocks from PLAN.md', () => {
    const verifierSrc = fs.readFileSync(path.join(REPO_ROOT, 'agents', 'gsd-verifier.md'), 'utf-8');
    assert.ok(
      verifierSrc.includes('<verify><human-check>') || /<verify>[\s\S]{0,200}<human-check>/i.test(verifierSrc),
      'verifier must instruct itself to harvest <verify><human-check> blocks from PLAN.md when human_verify_mode = end-of-phase',
    );
    assert.ok(
      verifierSrc.includes('human_verify_mode'),
      'verifier must reference the flag by canonical key',
    );
  });
});

// ─── References doc parity ───────────────────────────────────────────────────

describe('references/checkpoints.md documents the flag', () => {
  test('mentions workflow.human_verify_mode in the human-verify section', () => {
    const refSrc = fs.readFileSync(
      path.join(REPO_ROOT, 'gsd-core', 'references', 'checkpoints.md'),
      'utf-8',
    );
    assert.ok(
      refSrc.includes('workflow.human_verify_mode'),
      'checkpoints reference must document the new flag so users know the cost-control alternative exists',
    );
  });
});
  });
}

describe('config-set hooks.context_warning_threshold / hooks.context_critical_threshold (#4285)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    runGsdTools('config-ensure-section', tmpDir, homeSandboxEnv(tmpDir));
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // Registration: before #4285 both keys were rejected outright as unknown, so
  // the only way to tune a fire-point was editing the managed hook file.
  test('both keys are accepted by config-set and persisted', () => {
    for (const [key, value] of [
      ['hooks.context_warning_threshold', 45],
      ['hooks.context_critical_threshold', 30],
    ]) {
      const result = runGsdTools(`config-set ${key} ${value}`, tmpDir);
      assert.ok(result.success, `config-set ${key} failed: ${result.error}`);
      const config = readConfig(tmpDir);
      assert.strictEqual(config.hooks[key.split('.')[1]], value);
    }
  });

  // The domain the hook compares against (remaining_percentage) is 0-100
  // inclusive, but the two ENDPOINTS that can never form a valid pair are
  // refused rather than stored (#4285 review). `critical < warning` must hold at
  // read time and both sides are clamped to 0-100, so `warning: 0` has no legal
  // partner below it and `critical: 100` has none above it. Each is discarded by
  // the hook for EVERY value of the other key, so storing one would report a
  // tuning that can never take effect.
  //
  // Stated as a pair of tables rather than one row per case, because the
  // asymmetry is the point: 0 is legal for critical and illegal for warning, and
  // 100 is the reverse. A single "bounds are inclusive" row (which this replaces)
  // asserted the misleading half and was what let the dead value through.
  test('refuses the two endpoints that can never form a valid pair', () => {
    for (const [key, dead] of [
      ['hooks.context_warning_threshold', 0],
      ['hooks.context_critical_threshold', 100],
    ]) {
      const before = JSON.stringify(readConfig(tmpDir));
      const result = runGsdTools(`config-set ${key} ${dead}`, tmpDir);
      assert.ok(!result.success, `config-set ${key} ${dead} must fail — no partner value can satisfy the pair check`);
      assert.strictEqual(JSON.stringify(readConfig(tmpDir)), before,
        `${key}: a refused write must leave the config byte-identical`);
    }
  });

  test('accepts the endpoints that ARE reachable, and the values just inside the dead ones', () => {
    // The controls for the row above. Without these, refusing 0 and 100
    // outright would pass it just as well as refusing only the dead pairing.
    for (const [key, live] of [
      ['hooks.context_warning_threshold', 100],   // warning 100 pairs with the default critical 25
      ['hooks.context_critical_threshold', 0],    // critical 0 pairs with the default warning 35
      ['hooks.context_warning_threshold', 0.001], // just inside the dead endpoint
      ['hooks.context_critical_threshold', 99.999],
    ]) {
      const result = runGsdTools(`config-set ${key} ${live}`, tmpDir);
      assert.ok(result.success, `config-set ${key} ${live} must succeed: ${result.error}`);
      assert.strictEqual(readConfig(tmpDir).hooks[key.split('.')[1]], live);
    }
  });

  // The query surface must agree with the reader: an ABSENT key resolves to the
  // hook's own default rather than "Key not found" (#4285 review). SCHEMA_DEFAULTS
  // necessarily restates 35/25 outside the hook — the hook is a standalone
  // subprocess on a hot path and cannot read a manifest to learn its own
  // defaults — so this row pins the two copies against each other. If either
  // moves alone, this goes red.
  test('an absent threshold resolves to the hook\'s own constant, not "Key not found"', () => {
    const monitor = require('../hooks/gsd-context-monitor.js');
    for (const [key, constant] of [
      ['hooks.context_warning_threshold', monitor.WARNING_THRESHOLD],
      ['hooks.context_critical_threshold', monitor.CRITICAL_THRESHOLD],
    ]) {
      const result = runGsdTools(`config-get ${key}`, tmpDir);
      assert.ok(result.success, `config-get ${key} failed: ${result.error}`);
      assert.strictEqual(Number(String(result.output).trim()), constant,
        `${key} must resolve to the hook's own default (${constant}); a drift here means ` +
        'SCHEMA_DEFAULTS and the hook constants disagree');
    }
  });

  // Accept and honour must agree ON THE DOMAIN: the hook falls back to its
  // default for a value outside 0-100, so config-set reporting success on such
  // a value would tell the operator a tuning took effect when it did not. The
  // agreement is per-key and no wider — an accepted value can still lose to the
  // hook's pair check at read time, and a scoped write (GSD_PROJECT /
  // GSD_WORKSTREAM) lands in a config the hook does not read at all.
  test('rejects values the hook would discard, and leaves the config untouched', () => {
    const before = JSON.stringify(readConfig(tmpDir));

    for (const value of ['101', '-1', 'high', 'true']) {
      for (const key of ['hooks.context_warning_threshold', 'hooks.context_critical_threshold']) {
        const result = runGsdTools(`config-set ${key} ${value}`, tmpDir);
        assert.ok(!result.success, `config-set ${key} ${value} must be rejected, not silently stored`);
      }
    }

    assert.strictEqual(JSON.stringify(readConfig(tmpDir)), before,
      'a rejected config-set must not have written anything');
  });

  // Deliberate non-guard, documented in docs/context-monitor.md: config-set
  // writes ONE key per call, so a two-step retune (warning first, then
  // critical) is transiently inconsistent on disk. Refusing it here would block
  // a legitimate configuration; the hook resolves the pair at read time
  // instead, falling back to both defaults while it is inconsistent.
  test('does NOT enforce the pair ordering across two calls', () => {
    const warn = runGsdTools('config-set hooks.context_warning_threshold 20', tmpDir);
    assert.ok(warn.success, `config-set must accept a warning threshold below the default critical: ${warn.error}`);

    const crit = runGsdTools('config-set hooks.context_critical_threshold 10', tmpDir);
    assert.ok(crit.success, `config-set must accept the second half of the retune: ${crit.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.hooks.context_warning_threshold, 20);
    assert.strictEqual(config.hooks.context_critical_threshold, 10);
  });
});

// ─── config-new-project properties: choices held to config-set leaf by leaf (#5268) ───

/**
 * Property-based tests for config-new-project's choice validation (#5268).
 * Exported: cmdConfigNewProject(cwd, choicesJson, raw, { dryRun })
 *           cmdConfigSet(cwd, keyPath, value, raw, { dryRun })
 *
 * `config-new-project` takes its choices as one nested JSON object and holds
 * each leaf to the key and value rules `config-set` applies to that leaf. The
 * table rows above pin chosen cases; these properties pin the walk:
 *   (a) a payload is accepted exactly when config-set accepts every one of its
 *       leaves, it is refused with the error config-set gives for one of them,
 *       and an accepted leaf is written as config-set would write it
 *   (b) one unknown leaf anywhere in a payload refuses the whole payload, and
 *       nothing is written
 *
 * The leaf values are JSON-typed, and the text handed to config-set is the
 * text config-set parses back to that same value. A string config-set would
 * coerce ("true", "5") is left out on purpose: config-new-project does not
 * coerce, and the rows above pin that difference by name.
 *
 * Both verbs run in-process: error() throws ExitError (ADR-3889) rather than
 * exiting, so each verdict is a caught throw, not a spawned CLI.
 */

/**
 * Run one in-process verb call with fd 1 and fd 2 recorded instead of
 * written. Returns { ok, out, err }; `ok` is false when the verb refused
 * through error(). Built on suppressFdAsync for the reason it exists
 * (#4448): io.output()'s fd-1 write races node:test's child-to-parent IPC,
 * and the window here is one verb call that nothing else writes into.
 */
async function runQuietly(fn) {
  let thrown = null;
  let err = '';
  const out = await suppressFdAsync(1, async () => {
    err = await suppressFdAsync(2, () => {
      try {
        fn();
      } catch (caught) {
        thrown = caught;
      }
    });
  });
  if (thrown !== null && !(thrown instanceof ExitError)) throw thrown;
  return { ok: thrown === null, out, err };
}

/**
 * runQuietly with --json-errors on, so a refusal's typed reason can be read:
 * `error` is the parsed stderr line, or null when the verb succeeded.
 */
async function runQuietlyJson(fn) {
  const { setJsonErrorMode, getJsonErrorMode } = require('../gsd-core/bin/lib/cli-exit.cjs');
  const previous = getJsonErrorMode();
  setJsonErrorMode(true);
  try {
    const result = await runQuietly(fn);
    return { ...result, error: result.ok ? null : JSON.parse(result.err) };
  } finally {
    setJsonErrorMode(previous);
  }
}

/** A refused `--json-errors` CLI call: exit 1, no stack trace, and the typed reason. */
function assertRefused(result, reason) {
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.exitCode, 1);
  assert.strictEqual(/\n\s*at\s/.test(result.error), false, 'a refusal must not print a stack trace');
  assert.strictEqual(JSON.parse(result.error).reason, reason);
}

/** Every leaf of a JSON object as [keyPath, value]; arrays and null are leaves. */
function keyPathLeaves(obj, prefix = []) {
  return Object.entries(obj).flatMap(([k, v]) =>
    v !== null && typeof v === 'object' && !Array.isArray(v) ? keyPathLeaves(v, [...prefix, k]) : [[[...prefix, k], v]]);
}

/** The text that config-set parses back to `value`. */
function cliText(value) {
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function setPath(target, keyPath, value) {
  const segments = keyPath.split('.');
  let node = target;
  for (const segment of segments.slice(0, -1)) {
    if (node[segment] === undefined) node[segment] = {};
    node = node[segment];
  }
  node[segments[segments.length - 1]] = value;
  return target;
}

function valueAt(obj, keyPath) {
  return keyPath.split('.').reduce((node, segment) => (node == null ? undefined : node[segment]), obj);
}

// Each leaf draws from values its rule accepts and values it refuses, so both
// verdicts occur. `null` is drawn too: config-set clears the key, and
// config-new-project leaves it unchosen; both accept.
const orNull = (arb) => fc.oneof({ weight: 1, arbitrary: fc.constant(null) }, { weight: 6, arbitrary: arb });
const LEAVES = {
  mode: orNull(fc.constantFrom('yolo', 'interactive', 'nonsense', 'YOLO')),
  granularity: orNull(fc.constantFrom('coarse', 'standard', 'fine', 'huge')),
  context_window: orNull(fc.integer({ min: -2, max: 3 })),
  project_code: orNull(fc.constantFrom('PROJ', 'APP_CODE')),
  'workflow.research': orNull(fc.oneof(fc.boolean(), fc.constant('maybe'))),
  'workflow.code_review_depth': orNull(fc.constantFrom('quick', 'standard', 'deep', 'weird')),
  'workflow.security_asvs_level': orNull(fc.integer({ min: -1, max: 5 })),
  'workflow.drift_threshold': orNull(fc.integer({ min: -1, max: 3 })),
  'workflow.human_verify_mode': orNull(fc.constantFrom('mid-flight', 'end-of-phase', 'never')),
  'git.create_tag': orNull(fc.oneof(fc.boolean(), fc.constant('yes'))),
  'git.branching_strategy': orNull(fc.constantFrom('none', 'phase', 'milestone', 'sometimes')),
  'hooks.context_warning_threshold': orNull(fc.integer({ min: -1, max: 101 })),
  'review.default_reviewers': orNull(fc.subarray(['codex', 'Codex', 'gemini', 'not-a-reviewer'])),
  'ship.pr_body_sections': orNull(fc.constantFrom([], 'x', [{}])),
};

const leafEntries = fc
  .uniqueArray(fc.constantFrom(...Object.keys(LEAVES)), { minLength: 1, maxLength: 5 })
  .chain((keys) => fc.tuple(...keys.map((key) => LEAVES[key].map((value) => [key, value]))));

const UNKNOWN_LEAVES = ['bogus_key', 'workflow.reserch', 'git.no_such_setting', 'hooks.nope', 'review.not_a_setting'];

describe('config-new-project: choices are held to config-set leaf by leaf (#5268)', () => {
  let projectDir;
  let gsdHome;
  let savedGsdHome;

  before(() => {
    // Neither verb may see this host's defaults or installed capabilities.
    gsdHome = createTempDir('gsd-5268-prop-home-');
    savedGsdHome = process.env.GSD_HOME;
    process.env.GSD_HOME = gsdHome;
    // config-set previews against an existing config; config-new-project
    // previews from a directory that has none.
    projectDir = createTempDir('gsd-5268-prop-project-');
    fs.mkdirSync(path.join(projectDir, '.planning'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, '.planning', 'config.json'), '{}');
  });

  after(() => {
    if (savedGsdHome === undefined) delete process.env.GSD_HOME;
    else process.env.GSD_HOME = savedGsdHome;
    cleanup(projectDir);
    cleanup(gsdHome);
  });

  test('property: a payload is accepted exactly when config-set accepts each leaf, and written as config-set writes it', async (t) => {
    const seen = { accepted: 0, refused: 0 };
    const bareDir = createTempDir('gsd-5268-prop-bare-');
    t.after(() => cleanup(bareDir));
    await fc.assert(
      fc.asyncProperty(leafEntries, async (entries) => {
        const viaSet = [];
        for (const [key, value] of entries) {
          viaSet.push(await runQuietly(() => configLib.cmdConfigSet(projectDir, key, cliText(value), false, { dryRun: true })));
        }
        const choices = entries.reduce((acc, [key, value]) => setPath(acc, key, value), {});
        const viaNewProject = await runQuietly(() =>
          configLib.cmdConfigNewProject(bareDir, JSON.stringify(choices), false, { dryRun: true }),
        );

        const setAcceptsAll = viaSet.every((verdict) => verdict.ok);
        assert.strictEqual(
          viaNewProject.ok,
          setAcceptsAll,
          `config-new-project ${viaNewProject.ok ? 'accepted' : 'refused'} ${JSON.stringify(choices)}; config-set verdicts: ${
            entries.map(([key], i) => `${key}=${viaSet[i].ok}`).join(', ')}\n${viaNewProject.err}`,
        );

        if (!viaNewProject.ok) {
          seen.refused += 1;
          const setErrors = viaSet.filter((verdict) => !verdict.ok).map((verdict) => verdict.err);
          assert.ok(setErrors.includes(viaNewProject.err), `refused with an error config-set does not give: ${viaNewProject.err}`);
          return;
        }

        seen.accepted += 1;
        const preview = JSON.parse(viaNewProject.out).config;
        entries.forEach(([key, value], i) => {
          if (value === null) return; // unchosen: the key keeps its default
          assert.deepStrictEqual(valueAt(preview, key), JSON.parse(viaSet[i].out).value, `${key} is not written as config-set writes it`);
        });
      }),
    );
    // Positive control: a generator that only ever produced one verdict would
    // pass the property vacuously.
    assert.ok(seen.accepted > 0 && seen.refused > 0, `both verdicts must occur: ${JSON.stringify(seen)}`);
  });

  test('property: one unknown leaf anywhere in a payload refuses it and nothing is written', async (t) => {
    const dirs = [];
    t.after(() => dirs.forEach((dir) => cleanup(dir)));
    await fc.assert(
      fc.asyncProperty(
        leafEntries,
        fc.constantFrom(...UNKNOWN_LEAVES),
        fc.nat(),
        async (entries, unknownKey, position) => {
          const withUnknown = [...entries];
          withUnknown.splice(position % (entries.length + 1), 0, [unknownKey, true]);
          const choices = withUnknown.reduce((acc, [key, value]) => setPath(acc, key, value), {});

          const dir = createTempDir('gsd-5268-prop-unknown-');
          dirs.push(dir);
          const result = await runQuietly(() => configLib.cmdConfigNewProject(dir, JSON.stringify(choices), false));
          assert.strictEqual(result.ok, false, `accepted ${JSON.stringify(choices)}`);
          assert.strictEqual(fs.existsSync(path.join(dir, '.planning')), false, '.planning must not be created');

          let othersAccepted = true;
          for (const [key, value] of entries) {
            const verdict = await runQuietly(() => configLib.cmdConfigSet(projectDir, key, cliText(value), false, { dryRun: true }));
            othersAccepted = othersAccepted && verdict.ok;
          }
          if (othersAccepted) {
            assert.match(result.err, new RegExp(`^Error: Unknown config key: "${unknownKey.replace(/\./g, '\\.')}"`));
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ─── #5681 fixtures ─────────────────────────────────────────────────────────

/**
 * Point process.env.GSD_HOME at `gsdHome` for the rest of the test, for rows that
 * call config.cjs in-process. Restored in t.after rather than through
 * withIsolatedProcessState, which restores when its callback returns, before an
 * awaited in-process save has finished.
 */
function useGsdHome(t, gsdHome) {
  const saved = process.env.GSD_HOME;
  process.env.GSD_HOME = gsdHome;
  t.after(() => {
    if (saved === undefined) delete process.env.GSD_HOME;
    else process.env.GSD_HOME = saved;
  });
}

/**
 * A temp GSD_HOME holding the global defaults store, removed after the test.
 * `defaults` seeds `.gsd/defaults.json`: an object is written as JSON, a string as
 * given, and undefined writes nothing, not even `.gsd/`. `inProcess` points
 * process.env.GSD_HOME at it.
 */
function defaultsHome(t, defaults, { inProcess = false } = {}) {
  const { gsdHome, defaultsPath } = defaultsStoreHome(t, defaults);
  if (inProcess) useGsdHome(t, gsdHome);
  const env = { GSD_HOME: gsdHome };
  const { INSTALL_MIGRATION_LOCK_NAME } = require('../gsd-core/bin/lib/installer-migrations.cjs');
  return {
    gsdHome,
    env,
    defaultsPath,
    lockPath: path.join(gsdHome, '.gsd', INSTALL_MIGRATION_LOCK_NAME),
    readText: () => fs.readFileSync(defaultsPath, 'utf-8'),
    read: () => JSON.parse(fs.readFileSync(defaultsPath, 'utf-8')),
    /** config-save-defaults through the CLI with --json-errors; `args` are its positionals. */
    run: (args, cwd = gsdHome) => runGsdTools(['--json-errors', 'config-save-defaults', ...args], cwd, env),
    save: (settings, cwd = gsdHome) => runGsdTools(['--json-errors', 'config-save-defaults', JSON.stringify(settings)], cwd, env),
    /** config-save-defaults in-process, through runQuietlyJson (needs `inProcess`). */
    saveInProcess: (settings) => runQuietlyJson(() => configLib.cmdConfigSaveDefaults(gsdHome, JSON.stringify(settings), false)),
  };
}

/** A temp project directory, removed after the test. */
function tempProject(t) {
  const dir = createTempDir('gsd-5681-proj-');
  t.after(() => cleanup(dir));
  return dir;
}

/**
 * Make the installer lock give up at once instead of after its 30 s default, so a
 * held lock is refused on the first look. Not a subprocess timeout: the lock's own
 * wait budget, zero.
 */
function lockWaitNone(t) {
  const installerMigrations = require('../gsd-core/bin/lib/installer-migrations.cjs');
  const realAcquire = installerMigrations.acquireInstallMigrationLock;
  const LOCK_WAIT_NONE_MS = 0;
  t.mock.method(installerMigrations, 'acquireInstallMigrationLock', (dir) => realAcquire(dir, { timeoutMs: LOCK_WAIT_NONE_MS }));
}

describe('#5681 regression: config-save-defaults merges into the global defaults store', () => {
  // The settings workflow's "save as global defaults" step wrote a fixed object,
  // so every key only the defaults file carried was deleted, and the next install
  // re-baked the agents without those overrides.
  const store = defaultsHome;

  test('keys the settings flow does not manage survive a save; the chosen settings are updated', (t) => {
    const { save, read } = store(t, JSON.stringify({
      model_profile: 'quality',
      model_overrides: { 'gsd-codebase-mapper': 'opus' },
      effort: { agent_overrides: { 'gsd-codebase-mapper': 'high' } },
      runtime: 'codex',
      resolve_model_ids: 'omit',
      workflow: { research: true, unlisted_toggle: true },
    }));
    const result = save({ model_profile: 'balanced', workflow: { research: false, plan_check: true } });
    assert.ok(result.success, result.error);
    assert.deepStrictEqual(read(), {
      model_profile: 'balanced',
      model_overrides: { 'gsd-codebase-mapper': 'opus' },
      effort: { agent_overrides: { 'gsd-codebase-mapper': 'high' } },
      runtime: 'codex',
      resolve_model_ids: 'omit',
      workflow: { research: false, unlisted_toggle: true, plan_check: true },
    });
  });

  test('a missing store is created with the saved settings', (t) => {
    const { save, read } = store(t);
    const result = save({ mode: 'yolo', workflow: { verifier: true } });
    assert.ok(result.success, result.error);
    assert.strictEqual(JSON.parse(result.output).created, true);
    assert.deepStrictEqual(read(), { mode: 'yolo', workflow: { verifier: true } });
  });

  // The keys come from the one list new-project detection reads, so an eighth
  // integration is covered here without a new row.
  const DETECTED_KEYS = configLib.DETECTED_SEARCH_INTEGRATIONS.map(({ key }) => key);

  test('machine-detected search flags are not copied to the global store, and are reported as skipped', (t) => {
    assert.ok(DETECTED_KEYS.includes('brave_search'), 'precondition: the list is the search integrations');
    const { save, read } = store(t, JSON.stringify({ mode: 'yolo' }));
    const result = save({ model_profile: 'quality', ...Object.fromEntries(DETECTED_KEYS.map((key) => [key, true])) });
    assert.ok(result.success, result.error);
    assert.deepStrictEqual(read(), { mode: 'yolo', model_profile: 'quality' });
    assert.deepStrictEqual(JSON.parse(result.output).skipped, DETECTED_KEYS);
  });

  // docs/CLI-TOOLS.md lists the keys a save never stores; it must name exactly
  // the keys the verb skips, in the same order.
  test('the CLI-TOOLS.md list of never-saved keys is the list the verb skips', () => {
    const doc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'CLI-TOOLS.md'), 'utf-8').split(/\s+/).join(' ');
    const lead = 'These keys are never saved: the search flags that new projects detect from this machine (';
    const start = doc.indexOf(lead);
    assert.ok(start !== -1, 'CLI-TOOLS.md must keep the never-saved sentence');
    const listed = doc.slice(start + lead.length, doc.indexOf(')', start + lead.length));
    assert.deepStrictEqual([...listed.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]), DETECTED_KEYS);
  });

  test('a save that gives only search flags writes an empty store and lists every flag as skipped', (t) => {
    const { save, read } = store(t);
    const result = save({ brave_search: true, firecrawl: true });
    assert.ok(result.success, result.error);
    assert.deepStrictEqual(JSON.parse(result.output), { saved: true, created: true, path: JSON.parse(result.output).path, skipped: ['brave_search', 'firecrawl'] });
    assert.deepStrictEqual(read(), {});
  });

  // config-set accepts `{}` as parallelization's value, and the loader reads an
  // object without `enabled` as the default, which is on. So `{}` sets nothing:
  // a stored value of any shape stays, and none is created.
  for (const [label, stored] of [['false', false], ['true', true], ['an object', { enabled: false }], ['absent', undefined]]) {
    test(`an empty object given as a setting value leaves a stored ${label} as it was`, (t) => {
      const before = stored === undefined ? { model_profile: 'quality' } : { parallelization: stored, model_profile: 'quality' };
      const { save, read } = store(t, JSON.stringify(before));
      const result = save({ parallelization: {} });
      assert.ok(result.success, result.error);
      assert.deepStrictEqual(read(), before);
    });
  }

  // The same at any depth: a section patch whose leaves are all `{}` sets
  // nothing, and neither does a null for a key the stored value does not hold.
  for (const [label, before, settings] of [
    ['{"enabled":{}} over a stored parallelization: false', { parallelization: false }, { parallelization: { enabled: {} } }],
    ['{"enabled":{}} over a stored parallelization: true', { parallelization: true }, { parallelization: { enabled: {} } }],
    ['{"branching_strategy":{}} over a stored scalar git', { git: 'x' }, { git: { branching_strategy: {} } }],
    ['{"gsd-planner":{}} over a stored empty model_overrides', { model_overrides: {} }, { model_overrides: { 'gsd-planner': {} } }],
  ]) {
    test(`a save of ${label} leaves the store as it was`, (t) => {
      const { save, read } = store(t, before);
      const result = save(settings);
      assert.ok(result.success, result.error);
      assert.deepStrictEqual(read(), before);
    });
  }

  test('a section patch that sets a value replaces a stored non-object', (t) => {
    const { save, read } = store(t, { parallelization: true });
    assert.ok(save({ parallelization: { enabled: false } }).success);
    assert.deepStrictEqual(read(), { parallelization: { enabled: false } });
  });

  // parallelization is a boolean, or an object whose `enabled` holds it. Where
  // the stored value and the saved one differ in shape, the boolean is merged
  // as `enabled`, so neither a section field nor a boolean turns the stored
  // setting over, and a null `enabled` clears a stored boolean.
  for (const [label, before, settings, after] of [
    ['a section field over a stored false', { parallelization: false }, { parallelization: { max_concurrent_agents: 3 } }, { parallelization: { enabled: false, max_concurrent_agents: 3 } }],
    ['a section field over a stored true', { parallelization: true }, { parallelization: { max_concurrent_agents: 3 } }, { parallelization: { enabled: true, max_concurrent_agents: 3 } }],
    ['{"enabled":null} over a stored false', { parallelization: false }, { parallelization: { enabled: null } }, {}],
    ['{"enabled":null} over a stored true', { parallelization: true }, { parallelization: { enabled: null } }, {}],
    ['true over a stored section', { parallelization: { enabled: false, max_concurrent_agents: 3 } }, { parallelization: true }, { parallelization: { enabled: true, max_concurrent_agents: 3 } }],
    ['false over a stored section without enabled', { parallelization: { max_concurrent_agents: 3 } }, { parallelization: false }, { parallelization: { max_concurrent_agents: 3, enabled: false } }],
    ['null over a stored section', { parallelization: { enabled: false, max_concurrent_agents: 3 } }, { parallelization: null }, {}],
  ]) {
    test(`parallelization: a save of ${label} keeps what the stored value meant`, (t) => {
      const { save, read } = store(t, { model_profile: 'quality', ...before });
      const result = save(settings);
      assert.ok(result.success, result.error);
      assert.deepStrictEqual(read(), { model_profile: 'quality', ...after });
    });
  }

  test('parallelization: a section field saved over a stored false still resolves to false', (t) => {
    const { loadConfig } = require('../gsd-core/bin/lib/config-loader.cjs');
    const { gsdHome, save } = store(t, { parallelization: false });
    assert.ok(save({ parallelization: { max_concurrent_agents: 3 } }).success);
    const outside = tempProject(t);
    const loaded = withIsolatedProcessState(() => {
      process.env.GSD_HOME = gsdHome;
      return loadConfig(outside);
    });
    assert.strictEqual(loaded.parallelization, false);
  });

  // Only a boolean is carried into `enabled`. The loader reads a top-level
  // non-boolean as the default (on); carried into `enabled` it would be read as
  // itself, so a stored 0 would turn the setting off when only a sibling was saved.
  for (const [label, stored] of [['0', 0], ['"false"', 'false'], ['[]', []]]) {
    test(`parallelization: a section field saved over a stored ${label} keeps reading as the default`, (t) => {
      const { loadConfig, CONFIG_DEFAULTS } = require('../gsd-core/bin/lib/config-loader.cjs');
      const { gsdHome, env, save, read } = store(t, { parallelization: stored });
      assert.ok(save({ parallelization: { max_concurrent_agents: 3 } }).success);
      assert.deepStrictEqual(read(), { parallelization: { max_concurrent_agents: 3 } });
      const outside = tempProject(t);
      const loaded = withIsolatedProcessState(() => {
        process.env.GSD_HOME = gsdHome;
        return loadConfig(outside);
      });
      assert.strictEqual(loaded.parallelization, CONFIG_DEFAULTS.parallelization);
      const projectDir = tempProject(t);
      assert.ok(runGsdTools(['config-new-project', '{}'], projectDir, env).success);
      assert.strictEqual(loadConfig(projectDir).parallelization, CONFIG_DEFAULTS.parallelization);
    });
  }

  test('a saved {} leaves a stored parallelization: false resolving to false', (t) => {
    const { loadConfig } = require('../gsd-core/bin/lib/config-loader.cjs');
    const { gsdHome, save } = store(t, { parallelization: false });
    assert.ok(save({ parallelization: {} }).success);
    const outside = tempProject(t);
    const loaded = withIsolatedProcessState(() => {
      process.env.GSD_HOME = gsdHome;
      return loadConfig(outside);
    });
    assert.strictEqual(loaded.parallelization, false);
  });

  test('a save with no search flags reports an empty skipped list', (t) => {
    const { save } = store(t);
    const result = save({ mode: 'yolo' });
    assert.ok(result.success, result.error);
    assert.deepStrictEqual(JSON.parse(result.output).skipped, []);
  });

  for (const [label, contents] of [['not valid JSON', '{"model_profile": "quality",'], ['not a JSON object', '["quality"]']]) {
    test(`a store that is ${label} is refused and left byte-identical`, (t) => {
      const { defaultsPath, save } = store(t, contents);
      assertRefused(save({ model_profile: 'balanced' }), 'config_defaults_invalid');
      assert.strictEqual(fs.readFileSync(defaultsPath, 'utf-8'), contents);
    });
  }

  test('settings that are not a JSON object are refused before the store is touched', (t) => {
    const { defaultsPath, save } = store(t);
    assertRefused(save(['model_profile']), 'usage');
    assert.ok(!fs.existsSync(defaultsPath));
  });
});

describe('#5681 regression: a saved setting replaces its legacy flat or nested twin', () => {
  // Merging kept both spellings of a setting, and the stale one won: the loader
  // reads a flat key first, and new-project creation keeps a nested value over a
  // flat one. Each row follows the save through config-new-project and loadConfig.
  const { loadConfig } = require('../gsd-core/bin/lib/config-loader.cjs');
  function newProjectAfterSave(t, defaults, settings) {
    const home = defaultsHome(t, defaults);
    const projectDir = tempProject(t);
    const saved = home.save(settings, projectDir);
    assert.ok(saved.success, saved.error);
    const created = runGsdTools(['config-new-project', '{}'], projectDir, home.env);
    assert.ok(created.success, created.error);
    return { config: loadConfig(projectDir), store: home.read() };
  }

  test('turning research off wins over a stale flat research: true', (t) => {
    const { config } = newProjectAfterSave(t, { research: true }, { workflow: { research: false } });
    assert.strictEqual(config.research, false);
  });

  // The save must use the nested spelling: new-project creation always writes
  // git.branching_strategy (default "none"), and the loader keeps a set nested
  // key over a flat one, so a saved flat "phase" came back as "none".
  test('a saved non-default branching strategy reaches a new project', (t) => {
    const { config } = newProjectAfterSave(t, {}, { git: { branching_strategy: 'phase' } });
    assert.strictEqual(config.branching_strategy, 'phase');
  });

  // New-project creation writes the flat commit_docs and search_gitignored, and
  // the loader reads the flat key first, so a saved nested spelling must reach
  // that flat key: the save has dropped the flat value.
  test('a saved nested planning.commit_docs reaches a new project over a stale flat value', (t) => {
    const { config, store } = newProjectAfterSave(t, { commit_docs: true }, { planning: { commit_docs: false } });
    assert.deepStrictEqual(store, { planning: { commit_docs: false } });
    assert.strictEqual(config.commit_docs, false);
  });

  test('a saved nested planning.search_gitignored reaches a new project over a stale flat value', (t) => {
    const { config, store } = newProjectAfterSave(t, { search_gitignored: false }, { planning: { search_gitignored: true } });
    assert.deepStrictEqual(store, { planning: { search_gitignored: true } });
    assert.strictEqual(config.search_gitignored, true);
  });

  // A workstream config is merged over the root's before the loader's
  // flat-first read, so the new project must carry the flat key with the chosen
  // value: a nested-only workstream config would lose to the root's flat
  // `commit_docs: true`, and planning files would be committed.
  test('a nested choice in a workstream overrides the flat value in the root config', (t) => {
    const { gsdHome } = defaultsHome(t, JSON.stringify({ commit_docs: true, search_gitignored: false }));
    const projectDir = tempProject(t);
    const env = { GSD_HOME: gsdHome };
    fs.mkdirSync(path.join(projectDir, '.planning'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, '.planning', 'config.json'), JSON.stringify({ commit_docs: true, search_gitignored: false }));
    const created = runGsdTools(['config-new-project', JSON.stringify({ planning: { commit_docs: false, search_gitignored: true } }), '--ws', 'lane'], projectDir, env);
    assert.ok(created.success, created.error);
    const read = (key) => runGsdTools(['config-get', key, '--raw', '--ws', 'lane'], projectDir, env);
    assert.strictEqual(read('commit_docs').output.trim(), 'false');
    assert.strictEqual(read('search_gitignored').output.trim(), 'true');
  });

  // The flat key the template writes takes the chosen value, and a nested twin
  // in the new project is given the same value, so the two spellings agree.
  // A nested value of another type than the template's default counts as no
  // setting. Copied into the flat key, a string "false" would read as false to
  // config-get but as true to check-commit, and a stored 1e400 (Infinity) would
  // be written as null.
  test('a nested commit_docs that is not a boolean is no setting', (t) => {
    for (const bad of ['"false"', '0', '1e400']) {
      for (const [label, store, choices, want] of [
        ['in the store', `{"planning":{"commit_docs":${bad}}}`, '{}', true],
        ['as a choice', '{}', `{"planning":{"commit_docs":${bad}}}`, true],
        ['as a choice over a flat store value', '{"commit_docs":false}', `{"planning":{"commit_docs":${bad}}}`, false],
      ]) {
        const { gsdHome } = defaultsHome(t, store);
        const projectDir = tempProject(t);
        const created = runGsdTools(['config-new-project', choices], projectDir, { GSD_HOME: gsdHome });
        assert.ok(created.success, created.error);
        const written = JSON.parse(fs.readFileSync(path.join(projectDir, '.planning', 'config.json'), 'utf-8'));
        assert.strictEqual(written.commit_docs, want, `${bad} ${label}: flat`);
        if (written.planning && 'commit_docs' in written.planning) {
          assert.strictEqual(written.planning.commit_docs, want, `${bad} ${label}: nested`);
        }
      }
    }
  });

  // Outside a project the loader reads the store as a new project made from it
  // does. commit_docs and search_gitignored, which the template writes flat, take
  // a nested value only of the default's type (copied flat, a string "false"
  // would read as true to check-commit); every other twin is read as stored,
  // because new-project creation copies it as stored.
  test('outside a project and in a new project, a stored nested twin reads the same', (t) => {
    const { CONFIG_DEFAULTS } = require('../gsd-core/bin/lib/config-loader.cjs');
    for (const [stored, key, want] of [
      [{ planning: { commit_docs: 'false' } }, 'commit_docs', CONFIG_DEFAULTS.commit_docs],
      [{ planning: { commit_docs: false } }, 'commit_docs', false],
      [{ workflow: { research: 'false' } }, 'research', 'false'],
      [{ workflow: { post_planning_gaps: 0 } }, 'post_planning_gaps', 0],
      [{ workflow: { subagent_timeout: '5' } }, 'subagent_timeout', '5'],
      [{ workflow: { subagent_timeout: 5000 } }, 'subagent_timeout', 5000],
    ]) {
      const { gsdHome } = defaultsHome(t, stored);
      const outside = tempProject(t);
      const loaded = withIsolatedProcessState(() => {
        process.env.GSD_HOME = gsdHome;
        return loadConfig(outside);
      });
      assert.strictEqual(loaded[key], want, `${JSON.stringify(stored)}: ${key} outside a project`);
      const projectDir = tempProject(t);
      assert.ok(runGsdTools(['config-new-project', '{}'], projectDir, { GSD_HOME: gsdHome }).success);
      assert.strictEqual(loadConfig(projectDir)[key], want, `${JSON.stringify(stored)}: ${key} in a new project`);
    }
  });

  // In a project and outside one, config-get and the loader read a stored
  // parallelization alike: a value that is neither a boolean nor an object is
  // no setting to either, as with no store at all.
  test('config-get and loadConfig read a stored parallelization that is neither a boolean nor an object alike, in a project and outside one', (t) => {
    const read = (stored, inProject) => {
      const { gsdHome } = defaultsHome(t, stored);
      const projectDir = tempProject(t);
      if (inProject) {
        fs.mkdirSync(path.join(projectDir, '.planning'), { recursive: true });
        fs.writeFileSync(path.join(projectDir, '.planning', 'config.json'), JSON.stringify({ model_profile: 'balanced' }));
      }
      const got = runGsdTools(['config-get', 'parallelization', '--raw'], projectDir, { GSD_HOME: gsdHome });
      const loaded = withIsolatedProcessState(() => {
        process.env.GSD_HOME = gsdHome;
        return loadConfig(projectDir).parallelization;
      });
      // The exit status, stdout and stderr, with this run's temp directory named
      // the same way in each, so two runs compare whole.
      const named = (text) => String(text ?? '').split(projectDir).join('<project>').trim();
      return { exitCode: got.exitCode, output: named(got.output), error: named(got.error), loaded };
    };
    for (const inProject of [true, false]) {
      const where = inProject ? 'in a project' : 'outside a project';
      const unset = read(undefined, inProject);
      assert.strictEqual(unset.loaded, true, where);
      for (const stored of ['"yes"', '0', '"false"', 'null', '[]']) {
        assert.deepStrictEqual(read(`{"parallelization":${stored}}`, inProject), unset, `${stored} ${where}`);
      }
      assert.deepStrictEqual(read('{"parallelization":false}', inProject), { exitCode: 0, output: 'false', error: '', loaded: false }, where);
    }
  });

  // The two twins the template writes flat are the loader's FLAT_WRITTEN_TWIN_KEYS:
  // a new project writes each of them flat.
  test('the flat-written twins are the ones a new project writes flat', (t) => {
    const { FLAT_WRITTEN_TWIN_KEYS } = require('../gsd-core/bin/lib/config-loader.cjs');
    const projectDir = tempProject(t);
    const { gsdHome } = defaultsHome(t);
    assert.ok(runGsdTools(['config-new-project', '{}'], projectDir, { GSD_HOME: gsdHome }).success);
    const written = JSON.parse(fs.readFileSync(path.join(projectDir, '.planning', 'config.json'), 'utf-8'));
    assert.deepStrictEqual([...FLAT_WRITTEN_TWIN_KEYS].sort(), ['commit_docs', 'search_gitignored']);
    for (const key of FLAT_WRITTEN_TWIN_KEYS) assert.ok(Object.prototype.hasOwnProperty.call(written, key), key);
  });

  test('check-commit refuses planning files when a string "false" was chosen over a stored false', (t) => {
    const { gitOrThrow } = require('./helpers/git-fixture.cjs');
    const { gsdHome } = defaultsHome(t, JSON.stringify({ commit_docs: false }));
    const projectDir = tempProject(t);
    const env = { GSD_HOME: gsdHome };
    gitOrThrow(['init', '-q'], { cwd: projectDir });
    const created = runGsdTools(['config-new-project', JSON.stringify({ planning: { commit_docs: 'false' } })], projectDir, env);
    assert.ok(created.success, created.error);
    fs.writeFileSync(path.join(projectDir, '.planning', 'REVIEW.md'), '# Review\n');
    gitOrThrow(['add', '.planning/REVIEW.md'], { cwd: projectDir });
    const checked = runGsdTools(['check-commit', '--raw'], projectDir, env);
    assert.ok(!checked.success, 'a staged .planning/ file must be refused');
    assert.ok(checked.error.includes('commit_docs is false'), checked.error);
  });

  test('the flat and nested commit_docs of a new project agree', (t) => {
    for (const [label, store, choices, want] of [
      ['a saved nested default', { planning: { commit_docs: false } }, {}, false],
      ['a flat choice over a saved nested default', { planning: { commit_docs: false } }, { commit_docs: true }, true],
      ['a nested choice over a flat store value', { commit_docs: false }, { planning: { commit_docs: true } }, true],
    ]) {
      const { gsdHome } = defaultsHome(t, JSON.stringify(store));
      const projectDir = tempProject(t);
      const created = runGsdTools(['config-new-project', JSON.stringify(choices)], projectDir, { GSD_HOME: gsdHome });
      assert.ok(created.success, created.error);
      const written = JSON.parse(fs.readFileSync(path.join(projectDir, '.planning', 'config.json'), 'utf-8'));
      assert.strictEqual(written.commit_docs, want, `${label}: flat`);
      assert.strictEqual(written.planning.commit_docs, want, `${label}: nested`);
      assert.strictEqual(loadConfig(projectDir).commit_docs, want, `${label}: resolved`);
    }
  });

  test('a null nested commit_docs in the store is no setting, so the template default stands', (t) => {
    const { gsdHome } = defaultsHome(t, JSON.stringify({ planning: { commit_docs: null, search_gitignored: null } }));
    const projectDir = tempProject(t);
    const created = runGsdTools(['config-new-project', '{}'], projectDir, { GSD_HOME: gsdHome });
    assert.ok(created.success, created.error);
    const config = loadConfig(projectDir);
    assert.strictEqual(config.commit_docs, true);
    assert.strictEqual(config.search_gitignored, false);
  });

  test('a null flat commit_docs in the store is no setting, so the template default stands', (t) => {
    const { gsdHome } = defaultsHome(t, JSON.stringify({ commit_docs: null }));
    const projectDir = tempProject(t);
    const created = runGsdTools(['config-new-project', '{}'], projectDir, { GSD_HOME: gsdHome });
    assert.ok(created.success, created.error);
    assert.strictEqual(loadConfig(projectDir).commit_docs, true);
  });

  // A hand-written flat null beside a nested value: the loader's flat-first read
  // stops at the null and resolves the default, so new-project creation must
  // resolve the default too, not the nested value behind the null.
  for (const [key, nestedValue, fallback] of [['commit_docs', false, true], ['search_gitignored', true, false]]) {
    test(`a null flat ${key} beside a nested value resolves the default in the loader and in a new project alike`, (t) => {
      const { gsdHome } = defaultsHome(t, JSON.stringify({ [key]: null, planning: { [key]: nestedValue } }));
      const projectDir = tempProject(t);
      const outside = tempProject(t);
      const created = runGsdTools(['config-new-project', '{}'], projectDir, { GSD_HOME: gsdHome });
      assert.ok(created.success, created.error);
      const written = JSON.parse(fs.readFileSync(path.join(projectDir, '.planning', 'config.json'), 'utf-8'));
      assert.strictEqual(written[key], fallback, 'new project');
      if (key === 'commit_docs') {
        // The global-defaults branch projects commit_docs (not search_gitignored).
        const loaded = withIsolatedProcessState(() => {
          process.env.GSD_HOME = gsdHome;
          return loadConfig(outside);
        });
        assert.strictEqual(loaded[key], fallback, 'loader outside a project');
      }
    });
  }

  // Every twin the loader reads (CONFIG_KEY_ALIASES, less parallelization, whose
  // nested field sits under the flat key): its nested spelling saved with a
  // value that is not the default, over a store holding the flat default, is
  // the value the loader resolves in a new project.
  test('every saved nested twin reaches a new project as the value the loader resolves', (t) => {
    const { CONFIG_KEY_ALIASES, CONFIG_DEFAULTS, readResolvedAlias } = require('../gsd-core/bin/lib/config-loader.cjs');
    const chosen = {
      sub_repos: ['svc'], branching_strategy: 'phase', base_branch: 'trunk', max_prompt_tokens: 50000,
      phase_branch_template: 'p/{phase}-{slug}', milestone_branch_template: 'm/{milestone}-{slug}', quick_branch_template: 'q/{num}-{slug}',
    };
    const twins = CONFIG_KEY_ALIASES.filter((alias) => alias.section !== alias.key);
    assert.ok(twins.some((alias) => alias.key === 'commit_docs'), 'precondition: commit_docs is a twin');
    for (const alias of twins) {
      const fallback = CONFIG_DEFAULTS[alias.key];
      const want = Object.hasOwn(chosen, alias.key) ? chosen[alias.key]
        : typeof fallback === 'number' ? fallback + 1 : typeof fallback === 'boolean' ? !fallback : true;
      const { config } = newProjectAfterSave(t, { [alias.key]: fallback ?? false }, { [alias.section]: { [alias.field]: want } });
      assert.deepStrictEqual(readResolvedAlias(config, alias), want, `${alias.section}.${alias.field}`);
    }
  });

  // The same order holds for config-new-project's own choices: a nested
  // choice is not shadowed by the template's flat default, and it outranks a
  // saved default under either spelling.
  test('a nested planning choice reaches the new project over the template and the store', (t) => {
    const { gsdHome } = defaultsHome(t, JSON.stringify({ commit_docs: true }));
    const projectDir = tempProject(t);
    const created = runGsdTools(['config-new-project', JSON.stringify({ planning: { commit_docs: false } })], projectDir, { GSD_HOME: gsdHome });
    assert.ok(created.success, created.error);
    assert.strictEqual(loadConfig(projectDir).commit_docs, false);
  });

  test('a saved branching strategy wins over a stale flat branching_strategy', (t) => {
    const { config } = newProjectAfterSave(t, { branching_strategy: 'milestone' }, { git: { branching_strategy: 'phase' } });
    assert.strictEqual(config.branching_strategy, 'phase');
  });

  // A stale depth beside granularity is never migrated, so it was copied into
  // every new project's config.json.
  test('a saved granularity removes a stale depth from the store', (t) => {
    const { config, store } = newProjectAfterSave(t, { depth: 'quick' }, { granularity: 'fine' });
    assert.strictEqual(config.granularity, 'fine');
    assert.deepStrictEqual(store, { granularity: 'fine' });
  });

  // Outside a project the loader reads these keys flat, then nested, so a save
  // that stores the nested spelling and drops the flat one keeps a saved
  // `workflow.research: false`.
  test('turning research off outside a project survives the save that drops the flat spelling', (t) => {
    const { gsdHome } = defaultsHome(t, JSON.stringify({ research: false }));
    const outside = tempProject(t);
    assert.ok(runGsdTools(['config-save-defaults', JSON.stringify({ workflow: { research: false } })], outside, { GSD_HOME: gsdHome }).success);
    const loaded = withIsolatedProcessState(() => {
      process.env.GSD_HOME = gsdHome;
      return loadConfig(outside);
    });
    assert.strictEqual(loaded.research, false);
  });

  // The global-defaults branch reads every twin it projects through the one
  // list, NESTED_TWINS, so the rows come from that list, not a hand-typed one.
  test('outside a project, each twin key the loader reads is honored under its nested spelling', (t) => {
    const { NESTED_TWINS, GLOBAL_DEFAULTS_RESOLUTION_KEYS, CONFIG_DEFAULTS } = require('../gsd-core/bin/lib/config-loader.cjs');
    const keys = NESTED_TWINS.map((twin) => twin.key).filter((key) => GLOBAL_DEFAULTS_RESOLUTION_KEYS.includes(key));
    assert.ok(keys.includes('post_planning_gaps') && keys.includes('research_before_questions'), `precondition: the hand-read keys are in the list (${keys.join(', ')})`);
    const { gsdHome } = defaultsHome(t);
    fs.mkdirSync(path.join(gsdHome, '.gsd'), { recursive: true });
    const outside = tempProject(t);
    const store = {};
    const want = {};
    for (const key of keys) {
      const { section, field } = NESTED_TWINS.find((twin) => twin.key === key);
      const fallback = CONFIG_DEFAULTS[key];
      want[key] = typeof fallback === 'number' ? fallback + 1 : !fallback;
      store[section] = { ...store[section], [field]: want[key] };
    }
    fs.writeFileSync(path.join(gsdHome, '.gsd', 'defaults.json'), JSON.stringify(store));
    const loaded = withIsolatedProcessState(() => {
      process.env.GSD_HOME = gsdHome;
      return loadConfig(outside);
    });
    assert.deepStrictEqual(Object.fromEntries(keys.map((key) => [key, loaded[key]])), want);
  });

  // A null flat value is the flat key set to null: the read stops there and the
  // default applies, for every twin outside a project as inside one, whatever
  // the nested spelling holds.
  test('outside a project, a null flat twin stops the nested read and resolves the default', (t) => {
    const { NESTED_TWINS, GLOBAL_DEFAULTS_RESOLUTION_KEYS, CONFIG_DEFAULTS } = require('../gsd-core/bin/lib/config-loader.cjs');
    const keys = NESTED_TWINS.map((twin) => twin.key).filter((key) => GLOBAL_DEFAULTS_RESOLUTION_KEYS.includes(key));
    const store = {};
    for (const key of keys) {
      const { section, field } = NESTED_TWINS.find((twin) => twin.key === key);
      const fallback = CONFIG_DEFAULTS[key];
      store[key] = null;
      store[section] = { ...store[section], [field]: typeof fallback === 'number' ? fallback + 1 : !fallback };
    }
    const { gsdHome } = defaultsHome(t, store);
    const outside = tempProject(t);
    const loaded = withIsolatedProcessState(() => {
      process.env.GSD_HOME = gsdHome;
      return loadConfig(outside);
    });
    assert.deepStrictEqual(Object.fromEntries(keys.map((key) => [key, loaded[key]])),
      Object.fromEntries(keys.map((key) => [key, CONFIG_DEFAULTS[key]])));
  });

  // The loader reads a flat research_before_questions ahead of
  // workflow.research_before_questions, so saving the nested one must drop a
  // stale flat value.
  test('a saved workflow.research_before_questions replaces a stale flat value', (t) => {
    const { gsdHome, defaultsPath } = defaultsHome(t, JSON.stringify({ research_before_questions: true }));
    const outside = tempProject(t);
    const saved = runGsdTools(['config-save-defaults', JSON.stringify({ workflow: { research_before_questions: false } })], outside, { GSD_HOME: gsdHome });
    assert.ok(saved.success, saved.error);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(defaultsPath, 'utf-8')), { workflow: { research_before_questions: false } });
    const loaded = withIsolatedProcessState(() => {
      process.env.GSD_HOME = gsdHome;
      return loadConfig(outside);
    });
    assert.strictEqual(loaded.research_before_questions, false);
  });

  // A hand-written `depth` naming an Object.prototype member is an unknown depth,
  // kept as given: read from the depth-to-granularity table it would yield that
  // member, and the new project would get no granularity.
  test('a stored depth named like an Object.prototype member is kept as the granularity', (t) => {
    const { gsdHome } = defaultsHome(t, JSON.stringify({ depth: 'constructor' }));
    const projectDir = tempProject(t);
    const created = runGsdTools(['config-new-project', '{}'], projectDir, { GSD_HOME: gsdHome });
    assert.ok(created.success, created.error);
    const config = JSON.parse(fs.readFileSync(path.join(projectDir, '.planning', 'config.json'), 'utf-8'));
    assert.strictEqual(config.granularity, 'constructor');
  });

  test('clearing a setting with null removes it and its legacy spelling, so the default applies', (t) => {
    const { config, store } = newProjectAfterSave(
      t,
      { quick_branch_template: 'old/{slug}', git: { quick_branch_template: 'older/{slug}' } },
      { git: { quick_branch_template: null } },
    );
    assert.strictEqual(config.quick_branch_template, null);
    assert.deepStrictEqual(store, {});
  });

  // Every key the /gsd-settings template saves, each set to a value that is not
  // its default, over a store holding the stale legacy spellings. The saved
  // values are what the new project's config.json holds. The keys are checked
  // against the template in settings.md, so a key the workflow saves under a
  // spelling new projects drop (a flat branching_strategy) fails here.
  test('every setting the settings template saves reaches a new project', (t) => {
    const template = {
      mode: 'yolo', granularity: 'fine', model_profile: 'quality', commit_docs: false, parallelization: false,
      git: { branching_strategy: 'phase', quick_branch_template: 'q/{slug}' },
      workflow: {
        research: false, plan_check: false, verifier: false, auto_advance: true, nyquist_validation: false,
        pattern_mapper: false, ui_phase: false, ui_safety_gate: false, ai_integration_phase: false, tdd_mode: true,
        code_review: false, code_review_depth: 'deep', ui_review: false, skip_discuss: true, compact_content: true,
        agent_hint_routing: false,
      },
      plan_review: { source_grounding: false },
      intel: { enabled: true },
      graphify: { enabled: true, auto_update: true },
    };
    const dotted = (obj) => keyPathLeaves(obj).map(([keyPath]) => keyPath.join('.')).sort();
    const settingsMd = fs.readFileSync(path.join(__dirname, '..', 'gsd-core', 'workflows', 'settings.md'), 'utf-8');
    const open = "DEFAULTS_JSON=$(cat <<'JSON'\n";
    const start = settingsMd.indexOf(open);
    assert.ok(start !== -1, 'settings.md must assign DEFAULTS_JSON with a quoted heredoc');
    const body = settingsMd.slice(start + open.length, settingsMd.indexOf('\nJSON\n', start));
    const workflowTemplate = JSON.parse(body.replaceAll('<current>', 'null'));
    assert.deepStrictEqual(dotted(template), dotted(workflowTemplate));

    const { gsdHome } = defaultsHome(t);
    fs.mkdirSync(path.join(gsdHome, '.gsd'), { recursive: true });
    const projectDir = tempProject(t);
    fs.writeFileSync(path.join(gsdHome, '.gsd', 'defaults.json'), JSON.stringify({
      research: true, plan_checker: true, branching_strategy: 'none', quick_branch_template: 'old/{slug}', depth: 'quick',
    }));
    const env = { GSD_HOME: gsdHome };
    assert.ok(runGsdTools(['config-save-defaults', JSON.stringify(template)], projectDir, env).success);
    assert.ok(runGsdTools(['config-new-project', '{}'], projectDir, env).success);
    const created = JSON.parse(fs.readFileSync(path.join(projectDir, '.planning', 'config.json'), 'utf-8'));
    for (const [keyPath, want] of keyPathLeaves(template)) {
      assert.strictEqual(valueAt(created, keyPath.join('.')), want, keyPath.join('.'));
    }
    const config = loadConfig(projectDir);
    assert.strictEqual(config.research, false);
    assert.strictEqual(config.plan_checker, false);
    assert.strictEqual(config.branching_strategy, 'phase');
    assert.strictEqual(config.quick_branch_template, 'q/{slug}');
    assert.strictEqual(config.granularity, 'fine');
  });
});

describe('#5681: a save removes the other spelling of every spelling twin', () => {
  // Table-driven over SPELLING_TWINS, the one list of [legacy, canonical] pairs,
  // so a new CONFIG_KEY_ALIASES entry is covered without a new row.
  const { SPELLING_TWINS } = configLib;
  const at = valueAt;
  const nested = (dotted, value) => {
    const [head, field] = dotted.split('.');
    return field === undefined ? { [head]: value } : { [head]: { [field]: value } };
  };
  const store = defaultsHome;

  test('the twin pairs are the loader\'s NESTED_TWINS, and depth is retired for granularity', () => {
    const { NESTED_TWINS } = require('../gsd-core/bin/lib/config-loader.cjs');
    assert.deepStrictEqual(SPELLING_TWINS.map(([legacy, canonical]) => `${legacy}=${canonical}`),
      NESTED_TWINS.map(({ key, section, field }) => `${key}=${section}.${field}`));
    assert.deepStrictEqual(configLib.RETIRED_SPELLINGS, [['depth', 'granularity']]);
  });

  // A save of granularity removes a stored depth, which the loader would read
  // only while granularity is absent; depth itself is refused by the
  // config-set rules, so it never removes a stored granularity.
  test('saving granularity drops a stored depth, and depth is refused untouched', (t) => {
    const { defaultsPath, save, read } = store(t, { mode: 'yolo', depth: 'quick' });
    assert.ok(save({ granularity: {} }).success);
    assert.deepStrictEqual(read(), { mode: 'yolo', depth: 'quick' }, 'an empty granularity sets nothing and keeps depth');
    assert.ok(save({ granularity: 'fine' }).success);
    assert.deepStrictEqual(read(), { mode: 'yolo', granularity: 'fine' });
    const before = fs.readFileSync(defaultsPath, 'utf-8');
    assertRefused(save({ depth: 'quick' }), 'config_invalid_key');
    assert.strictEqual(fs.readFileSync(defaultsPath, 'utf-8'), before);
  });

  test('saving each canonical spelling drops its stale legacy spelling', (t) => {
    assert.ok(SPELLING_TWINS.length > 0, 'precondition: the twin table is not empty');
    const seeded = {};
    const patch = {};
    for (const [legacy, canonical] of SPELLING_TWINS) {
      seeded[legacy] = 'stale-legacy';
      const [head, field] = canonical.split('.');
      if (field === undefined) patch[head] = true;
      else patch[head] = { ...patch[head], [field]: true };
    }
    // config-set's value rules accept `true` for every canonical key; the row is
    // about which spelling survives, not the value.
    const { save, read } = store(t, seeded);
    const result = save(patch);
    assert.ok(result.success, result.error);
    const saved = read();
    for (const [legacy, canonical] of SPELLING_TWINS) {
      assert.strictEqual(at(saved, legacy), undefined, `${legacy} must be dropped when ${canonical} is saved`);
      assert.strictEqual(at(saved, canonical), true, `${canonical} must hold the saved value`);
    }
  });

  test('saving a legacy spelling drops its stale canonical spelling, or is refused untouched', (t) => {
    const accepted = [];
    for (const [legacy, canonical] of SPELLING_TWINS) {
      const seeded = nested(canonical, 'stale-canonical');
      const { defaultsPath, save, read } = store(t, seeded);
      const before = fs.readFileSync(defaultsPath, 'utf-8');
      const result = save({ [legacy]: true });
      if (result.success) {
        accepted.push(legacy);
        assert.strictEqual(at(read(), canonical), undefined, `${canonical} must be dropped when ${legacy} is saved`);
        assert.strictEqual(at(read(), legacy), true);
      } else {
        assertRefused(result, 'config_invalid_key');
        assert.strictEqual(fs.readFileSync(defaultsPath, 'utf-8'), before, `a refused ${legacy} save must leave the store as it was`);
      }
    }
    // The settings template saves the flat `commit_docs`, so this direction is live.
    assert.ok(accepted.includes('commit_docs'), `commit_docs must be an accepted legacy spelling (accepted: ${accepted.join(', ')})`);
  });

  // An empty object sets nothing, so it must not count as saving its spelling
  // either: a stored other spelling keeps its value and the loader its reading.
  test('an empty object under either spelling leaves both spellings as stored', (t) => {
    const accepted = [];
    for (const [legacy, canonical] of SPELLING_TWINS) {
      for (const [given, other] of [[canonical, legacy], [legacy, canonical]]) {
        for (const hollow of [{}, { x: {} }]) {
          const seeded = { mode: 'yolo', ...nested(other, 'stored') };
          const { save, read } = store(t, seeded);
          const result = save(nested(given, hollow));
          if (!result.success) continue; // a refused save writes nothing (rows above)
          accepted.push(given);
          assert.deepStrictEqual(read(), seeded, `${JSON.stringify(nested(given, hollow))} must leave ${other} as stored`);
        }
      }
    }
    for (const spelling of ['workflow.verifier', 'workflow.text_mode', 'commit_docs']) {
      assert.ok(accepted.includes(spelling), `precondition: an empty ${spelling} is accepted (accepted: ${accepted.join(', ')})`);
    }
  });

  test('a null for either spelling clears the other spelling too', (t) => {
    const { save, read } = store(t, { mode: 'yolo', verifier: false, depth: 'deep' });
    const result = save({ workflow: { verifier: null }, granularity: null });
    assert.ok(result.success, result.error);
    assert.deepStrictEqual(read(), { mode: 'yolo' });
  });

  // The installer's defaults writers hold this lock for their read-modify-write
  // (bin/install.js), so a save that holds it cannot interleave with them.
  test('a save holds the installer lock on .gsd/ while it writes, and releases it on every path', async (t) => {
    const { gsdHome, lockPath } = defaultsHome(t, undefined, { inProcess: true });
    const heldAtWrite = [];
    const realRename = fs.renameSync;
    t.mock.method(fs, 'renameSync', function (from, to) {
      if (path.basename(String(to)) === 'defaults.json') heldAtWrite.push(fs.existsSync(lockPath));
      return realRename.apply(this, arguments);
    });

    const saved = await runQuietly(() => configLib.cmdConfigSaveDefaults(gsdHome, JSON.stringify({ mode: 'yolo' }), true));
    assert.ok(saved.ok, saved.err);
    assert.deepStrictEqual(heldAtWrite, [true], 'the store must be written while the lock is held');
    assert.ok(!fs.existsSync(lockPath), 'the lock must be released after a save');

    fs.writeFileSync(path.join(gsdHome, '.gsd', 'defaults.json'), '{"mode":');
    const refused = await runQuietly(() => configLib.cmdConfigSaveDefaults(gsdHome, JSON.stringify({ mode: 'yolo' }), true));
    assert.strictEqual(refused.ok, false);
    assert.ok(!fs.existsSync(lockPath), 'the lock must be released when the save is refused');
  });
});

describe('#5681: config-save-defaults holds the settings to the config-set rules', () => {
  // The store seeds every new project, so it takes only what config-set would
  // store, as config-new-project's choices do (#5268).
  const storeWith = defaultsHome;
  const BEFORE = JSON.stringify({ model_profile: 'quality' });

  // config-set's value rules (validateConfigValue) raise no typed reason, in
  // config-set as here, so an invalid value is reported as `unknown`.
  for (const [label, settings, reason] of [
    ['an unknown key', { workflow: { reserch: true } }, 'config_invalid_key'],
    ['a legacy flat spelling', { branching_strategy: 'phase' }, 'config_invalid_key'],
    ['an invalid value', { mode: 'bogus' }, 'unknown'],
    ['a prototype key', JSON.parse('{"workflow":{"__proto__":{"x":1}}}'), 'config_invalid_key'],
  ]) {
    test(`${label} is refused and the store is left byte-identical`, (t) => {
      const { defaultsPath, run } = storeWith(t, BEFORE);
      assertRefused(run([JSON.stringify(settings)]), reason);
      assert.strictEqual(fs.readFileSync(defaultsPath, 'utf-8'), BEFORE);
    });
  }

  // Which reason each prototype-member name gets. As a setting or section key it
  // is an unknown key, and the refusal suggests nothing (an inherited lookup
  // would suggest `[object Object]` for `__proto__` and
  // `function Object() { [native code] }` for `constructor`). As an entry
  // under a setting that takes named entries it reaches the prototype-pollution
  // guard. The JSON is written as text: an object literal's `__proto__` sets
  // the prototype instead of a key.
  for (const name of ['__proto__', 'prototype', 'constructor']) {
    for (const [where, json, reason] of [
      ['a top-level key', `{"${name}":1}`, 'config_invalid_key'],
      ['a workflow key', `{"workflow":{"${name}":1}}`, 'config_invalid_key'],
      ['a model_overrides entry', `{"model_overrides":{"${name}":"opus"}}`, 'config_parse_failed'],
      ['an agent_skills entry', `{"agent_skills":{"${name}":["x"]}}`, 'config_parse_failed'],
      ['a models entry', `{"models":{"${name}":"opus"}}`, 'config_invalid_key'],
      ['a phase_commit_docs entry', `{"phase_commit_docs":{"${name}":true}}`, 'config_invalid_key'],
    ]) {
      test(`${name} as ${where} is refused as ${reason}, suggesting nothing, and the store is left byte-identical`, (t) => {
        const { defaultsPath, run } = storeWith(t, BEFORE);
        const result = run([json]);
        assertRefused(result, reason);
        assert.doesNotMatch(JSON.parse(result.error).message, /Did you mean/);
        assert.strictEqual(fs.readFileSync(defaultsPath, 'utf-8'), BEFORE);
      });
    }
  }

  // CONTRIBUTING.md "CLI and command routing": empty, whitespace-only and
  // flag-like values. A flag-like positional is taken as the settings JSON.
  for (const [label, arg] of [['not valid JSON', '{"model_profile":'], ['empty', ''], ['whitespace only', '   '], ['flag-like', '--weird']]) {
    test(`a settings argument that is ${label} is a usage error`, (t) => {
      const { defaultsPath, run } = storeWith(t, BEFORE);
      const result = run([arg]);
      assertRefused(result, 'usage');
      assert.ok(JSON.parse(result.error).message.startsWith('Invalid JSON for config-save-defaults: '), result.error);
      assert.strictEqual(fs.readFileSync(defaultsPath, 'utf-8'), BEFORE);
    });
  }

  // Both spellings in one save would both be stored, and the loader and
  // new-project creation each read a different one first.
  test('both spellings of one setting in one save is a usage error', (t) => {
    const { defaultsPath, run } = storeWith(t, BEFORE);
    assertRefused(run([JSON.stringify({ commit_docs: false, planning: { commit_docs: true } })]), 'usage');
    assert.strictEqual(fs.readFileSync(defaultsPath, 'utf-8'), BEFORE);
  });

  // An empty object sets nothing, so it is neither a second spelling nor a
  // value of the wrong type.
  test('an empty object beside the other spelling, or alone, is not refused', (t) => {
    const { save, read } = storeWith(t, BEFORE);
    let result = save({ commit_docs: {}, planning: { commit_docs: true } });
    assert.ok(result.success, result.error);
    assert.deepStrictEqual(read(), { model_profile: 'quality', planning: { commit_docs: true } });
    result = save({ search_gitignored: {}, planning: { search_gitignored: { x: {} } } });
    assert.ok(result.success, result.error);
    assert.deepStrictEqual(read(), { model_profile: 'quality', planning: { commit_docs: true } });
  });

  // New-project creation ignores a commit_docs or search_gitignored of another
  // type than the template's boolean while the loader reads it, so the save
  // refuses one under either spelling. A JSON 1e400 is Infinity, a number.
  for (const key of ['commit_docs', 'search_gitignored']) {
    for (const spelling of [key, `planning.${key}`]) {
      for (const bad of ['"false"', '0', '1e400', '[]']) {
        test(`${spelling} given ${bad} is a usage error and the store is left byte-identical`, (t) => {
          const { defaultsPath, run } = storeWith(t, BEFORE);
          const json = spelling === key ? `{"${key}":${bad}}` : `{"planning":{"${key}":${bad}}}`;
          const result = run([json]);
          assertRefused(result, 'usage');
          assert.ok(JSON.parse(result.error).message.includes(`"${spelling}" must be a boolean, got ${bad === '1e400' ? 'Infinity' : bad}.`), result.error);
          assert.strictEqual(fs.readFileSync(defaultsPath, 'utf-8'), BEFORE);
        });
      }
    }
  }

  test('a boolean commit_docs or search_gitignored under either spelling is saved', (t) => {
    const { defaultsPath, run } = storeWith(t, BEFORE);
    assert.ok(run([JSON.stringify({ planning: { commit_docs: false, search_gitignored: true } })]).success);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(defaultsPath, 'utf-8')),
      { model_profile: 'quality', planning: { commit_docs: false, search_gitignored: true } });
  });

  for (const args of [[], ['{}', '{}']]) {
    test(`${args.length} positionals is a usage error`, (t) => {
      const { defaultsPath, run } = storeWith(t, BEFORE);
      const result = run(args);
      assertRefused(result, 'usage');
      if (args.length === 0) {
        assert.strictEqual(JSON.parse(result.error).message, 'Usage: config-save-defaults <settings-json>');
      }
      assert.strictEqual(fs.readFileSync(defaultsPath, 'utf-8'), BEFORE);
    });
  }

  // In-process, so the fault lands on the store write and nothing before it.
  // A partial write that fails (ENOSPC) must not reach the store: the old seam
  // fell back to writing the store in place and truncated it.
  test('a failed write is reported and leaves the existing store and no temp file', async (t) => {
    const before = JSON.stringify({ mode: 'interactive', runtime: 'codex' });
    const { defaultsPath, saveInProcess } = defaultsHome(t, before, { inProcess: true });
    // Matched by name: the store is written at its resolved path, which spells a
    // temp dir differently when it sits behind a link (/var is /private/var on macOS).
    // The temp file is written through an exclusively-created descriptor (#5759),
    // so the write is matched by the path that descriptor was opened under.
    t.after(mockPartialWriteThenThrow(fs, (target) => path.basename(String(target)).startsWith('defaults.json'), 5, { resolveDescriptors: true }));

    const result = await saveInProcess({ mode: 'yolo' });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error.reason, 'config_defaults_write_failed');
    assert.strictEqual(fs.readFileSync(defaultsPath, 'utf-8'), before);
    assert.deepStrictEqual(fs.readdirSync(path.dirname(defaultsPath)), ['defaults.json']);
  });

  // The temp file is written but cannot replace the store (EACCES on every
  // attempt, including the rename's retries): the store keeps its bytes, the
  // temp file is removed, and the lock is released.
  test('a rename that fails is reported and leaves the existing store, no temp file and no lock', async (t) => {
    const before = JSON.stringify({ mode: 'interactive', runtime: 'codex' });
    const { defaultsPath, lockPath, saveInProcess } = defaultsHome(t, before, { inProcess: true });
    const realRename = fs.renameSync;
    t.mock.method(fs, 'renameSync', function (from, to) {
      if (path.basename(String(to)) === 'defaults.json') {
        throw Object.assign(new Error('EACCES: permission denied, rename (injected)'), { code: 'EACCES' });
      }
      return realRename.apply(this, arguments);
    });

    const result = await saveInProcess({ mode: 'yolo' });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error.reason, 'config_defaults_write_failed');
    assert.strictEqual(fs.readFileSync(defaultsPath, 'utf-8'), before);
    assert.deepStrictEqual(fs.readdirSync(path.dirname(defaultsPath)), ['defaults.json']);
    assert.ok(!fs.existsSync(lockPath), 'the lock must be released');
  });
});

describe('#5681: config-save-defaults reports lock failures through error()', () => {
  // A lock that cannot be taken is a typed refusal, not a plain Error (a stack
  // trace from runMain), and a release that fails never replaces the save's own
  // result.
  function inProcessHome(t, contents) {
    const home = defaultsHome(t, contents, { inProcess: true });
    fs.mkdirSync(path.dirname(home.defaultsPath), { recursive: true });
    return { ...home, save: () => home.saveInProcess({ mode: 'yolo' }) };
  }
  function failLockUnlink(t, lockPath) {
    const realUnlink = fs.unlinkSync;
    t.mock.method(fs, 'unlinkSync', function (target) {
      if (path.resolve(String(target)) === path.resolve(lockPath)) {
        throw Object.assign(new Error('EPERM: operation not permitted, unlink (injected)'), { code: 'EPERM' });
      }
      return realUnlink.apply(this, arguments);
    });
  }

  test('a lock that cannot be released after a save is reported, and the save is kept', async (t) => {
    const { defaultsPath, lockPath, save } = inProcessHome(t);
    failLockUnlink(t, lockPath);
    const result = await save();
    assert.strictEqual(result.ok, false);
    const { reason, saved, created, path: savedPath } = result.error;
    assert.deepStrictEqual({ reason, saved, created, path: savedPath },
      { reason: 'config_defaults_lock_release_failed', saved: true, created: true, path: defaultsPath });
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(defaultsPath, 'utf-8')), { mode: 'yolo' });
  });

  test('a lock that cannot be released after a refusal keeps the refusal as the one error', async (t) => {
    const { defaultsPath, lockPath, save } = inProcessHome(t, '{"mode":');
    failLockUnlink(t, lockPath);
    const result = await save();
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.err.trim().split('\n').length, 1, '--json-errors writes exactly one line to stderr');
    assert.strictEqual(result.error.reason, 'config_defaults_invalid');
    assert.strictEqual(fs.readFileSync(defaultsPath, 'utf-8'), '{"mode":');
  });

  // A lock held by another live process is refused with its holder's pid: those
  // rows hold the lock with a process they spawn, so they live in
  // config.platform.test.cjs.

  // A lock file whose contents name no owner (a crash between creating it and
  // writing its payload) is never reclaimed, so the refusal names the file and
  // when to remove it.
  test('a lock file that names no owner is refused with its path and the remedy, and left in place', async (t) => {
    const before = '{"mode":"interactive"}';
    const { defaultsPath, lockPath, save } = inProcessHome(t, before);
    fs.writeFileSync(lockPath, '');
    lockWaitNone(t);
    const result = await save();
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error.reason, 'config_defaults_lock_unavailable');
    assert.strictEqual(result.error.lock_path, lockPath);
    assert.strictEqual(result.error.holder_pid, undefined);
    assert.ok(result.error.message.includes(`remove ${lockPath} and save again`), result.error.message);
    assert.strictEqual(fs.readFileSync(defaultsPath, 'utf-8'), before);
    assert.ok(fs.existsSync(lockPath), 'the lock file is left for the user');
  });
});

describe('#5681: new-project creation migrates a stored depth the way a save writes the store', () => {
  // The plan reads defaults.json and migrates `depth` to `granularity` in memory;
  // the rewrite that persists it ran later, unlocked, from that snapshot, so a
  // config-save-defaults landing in between was overwritten. It now takes the
  // installer lock, re-reads the store and migrates what it holds then.
  const installerMigrations = require('../gsd-core/bin/lib/installer-migrations.cjs');
  function project(t, store) {
    const home = defaultsHome(t, store, { inProcess: true });
    const projectDir = tempProject(t);
    const create = () => runQuietlyJson(() => configLib.cmdConfigNewProject(projectDir, '{}', true));
    return { ...home, projectDir, create };
  }

  test('a save that lands between the plan and the rewrite is kept', async (t) => {
    const { defaultsPath, create, read } = project(t, { depth: 'quick', mode: 'yolo' });
    const realAcquire = installerMigrations.acquireInstallMigrationLock;
    t.mock.method(installerMigrations, 'acquireInstallMigrationLock', (dir) => {
      // The interleaved save: it lands after the plan read the store.
      fs.writeFileSync(defaultsPath, JSON.stringify({ depth: 'quick', mode: 'yolo', model_overrides: { 'gsd-planner': 'opus' } }));
      return realAcquire(dir);
    });
    const result = await create();
    assert.strictEqual(result.ok, true, result.err);
    assert.deepStrictEqual(read(), { mode: 'yolo', model_overrides: { 'gsd-planner': 'opus' }, granularity: 'coarse' });
  });

  test('a save that sets granularity first leaves nothing to migrate', async (t) => {
    const { defaultsPath, create, read } = project(t, { depth: 'quick' });
    const realAcquire = installerMigrations.acquireInstallMigrationLock;
    t.mock.method(installerMigrations, 'acquireInstallMigrationLock', (dir) => {
      fs.writeFileSync(defaultsPath, JSON.stringify({ granularity: 'fine' }));
      return realAcquire(dir);
    });
    assert.strictEqual((await create()).ok, true);
    assert.deepStrictEqual(read(), { granularity: 'fine' });
  });

  test('the rewrite is written while the lock is held, through a temp file renamed over the store, and the lock is released', async (t) => {
    const { lockPath, create, read } = project(t, { depth: 'comprehensive' });
    const renames = [];
    const realRename = fs.renameSync;
    t.mock.method(fs, 'renameSync', function (from, to) {
      if (path.basename(String(to)) === 'defaults.json') renames.push({ from: path.basename(String(from)), locked: fs.existsSync(lockPath) });
      return realRename.apply(this, arguments);
    });
    assert.strictEqual((await create()).ok, true);
    assert.strictEqual(renames.length, 1, 'one rename over the store');
    assert.notStrictEqual(renames[0].from, 'defaults.json', 'renamed from a temp file');
    assert.strictEqual(renames[0].locked, true, 'written under the lock');
    assert.ok(!fs.existsSync(lockPath), 'the lock is released');
    assert.deepStrictEqual(read(), { granularity: 'fine' });
  });

  test('a lock that cannot be taken skips the rewrite; the project is still created', async (t) => {
    const before = JSON.stringify({ depth: 'quick' });
    const { defaultsPath, projectDir, create } = project(t, JSON.parse(before));
    t.mock.method(installerMigrations, 'acquireInstallMigrationLock', () => {
      throw new Error('installer migration lock is held (injected)');
    });
    const result = await create();
    assert.strictEqual(result.ok, true, result.err);
    assert.strictEqual(fs.readFileSync(defaultsPath, 'utf-8'), before);
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(projectDir, '.planning', 'config.json'), 'utf-8')).granularity, 'coarse');
  });

  // Best effort, so it never waits: a held lock, or an ownerless one a crash left
  // (never reclaimed), would otherwise hold up every project creation for the
  // lock's 30 s default.
  test('the rewrite takes the lock without waiting', async (t) => {
    const { create } = project(t, { depth: 'quick' });
    const realAcquire = installerMigrations.acquireInstallMigrationLock;
    const waits = [];
    t.mock.method(installerMigrations, 'acquireInstallMigrationLock', (dir, options) => {
      waits.push(options && options.timeoutMs);
      return realAcquire(dir, options);
    });
    assert.strictEqual((await create()).ok, true);
    assert.deepStrictEqual(waits, [0]);
  });

  test('a lock file that names no owner skips the rewrite; the project is still created', async (t) => {
    const before = JSON.stringify({ depth: 'quick' });
    const { defaultsPath, lockPath, projectDir, create } = project(t, JSON.parse(before));
    fs.writeFileSync(lockPath, '');
    const result = await create();
    assert.strictEqual(result.ok, true, result.err);
    assert.strictEqual(fs.readFileSync(defaultsPath, 'utf-8'), before);
    assert.ok(fs.existsSync(lockPath), 'the lock file is left as it was');
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(projectDir, '.planning', 'config.json'), 'utf-8')).granularity, 'coarse');
  });

  test('a .gsd directory removed before the rewrite is not recreated', async (t) => {
    const { defaultsPath, create } = project(t, { depth: 'quick' });
    const realAcquire = installerMigrations.acquireInstallMigrationLock;
    const gsdDir = path.dirname(defaultsPath);
    let removed = false;
    const realExists = fs.existsSync;
    t.mock.method(fs, 'existsSync', function (target) {
      // Remove .gsd/ once the plan has read the store, as a concurrent cleanup would.
      if (!removed && String(target) === gsdDir) { cleanup(gsdDir); removed = true; }
      return realExists.apply(this, arguments);
    });
    t.mock.method(installerMigrations, 'acquireInstallMigrationLock', (dir, options) => realAcquire(dir, options));
    assert.strictEqual((await create()).ok, true);
    assert.ok(removed, 'precondition: the directory was removed before the rewrite');
    assert.ok(!fs.existsSync(gsdDir));
  });

  test('a store removed before the rewrite is not recreated', async (t) => {
    const { defaultsPath, create } = project(t, { depth: 'quick' });
    const realAcquire = installerMigrations.acquireInstallMigrationLock;
    t.mock.method(installerMigrations, 'acquireInstallMigrationLock', (dir) => {
      fs.unlinkSync(defaultsPath);
      return realAcquire(dir);
    });
    assert.strictEqual((await create()).ok, true);
    assert.ok(!fs.existsSync(defaultsPath));
  });
});

describe('#5681: mergeIntoGlobalDefaults properties', () => {
  const { mergeIntoGlobalDefaults } = configLib;
  // Few key names, so base and patch collide often and sections nest.
  const key = fc.constantFrom('mode', 'git', 'workflow', 'research', 'effort');
  const leaf = fc.oneof(fc.boolean(), fc.integer(), fc.string(), fc.array(fc.integer(), { maxLength: 3 }));
  const tree = (withNull) => fc.letrec((tie) => ({
    node: fc.dictionary(key, fc.oneof({ depthSize: 'small' }, withNull ? fc.oneof(leaf, fc.constant(null)) : leaf, tie('node')), { maxKeys: 4 }),
  })).node;

  test('a base key the patch does not name survives unchanged', () => {
    fc.assert(fc.property(tree(false), tree(true), (base, patch) => {
      const merged = mergeIntoGlobalDefaults(base, patch);
      for (const k of Object.keys(base)) {
        if (!(k in patch)) assert.deepStrictEqual(merged[k], base[k]);
      }
    }));
  });

  test('every patch leaf is in the result, and a null leaf is absent', () => {
    fc.assert(fc.property(tree(false), tree(true), (base, patch) => {
      const merged = mergeIntoGlobalDefaults(base, patch);
      for (const [keyPath, value] of keyPathLeaves(patch)) {
        if (value === null) assert.strictEqual(valueAt(merged, keyPath.join('.')), undefined);
        else assert.deepStrictEqual(valueAt(merged, keyPath.join('.')), value);
      }
    }));
  });

  // A patch whose leaves are all `{}` sets nothing, over any base: scalars
  // under section keys included (`git: 5` patched with `{"git":{"mode":{}}}`).
  test('a patch whose leaves are all empty objects leaves the base unchanged', () => {
    const hollow = fc.letrec((tie) => ({
      node: fc.dictionary(key, fc.oneof({ depthSize: 'small' }, fc.constant({}), tie('node')), { maxKeys: 4 }),
    })).node;
    // Compared as JSON, the form the store is written in: fast-check builds
    // null-prototype objects, and the merge returns plain ones.
    const asJson = (value) => JSON.parse(JSON.stringify(value));
    fc.assert(fc.property(tree(false), hollow, (base, patch) => {
      assert.deepStrictEqual(asJson(mergeIntoGlobalDefaults(base, patch)), asJson(base));
    }));
  });

  test('saving twice equals saving once', () => {
    fc.assert(fc.property(tree(false), tree(true), (base, patch) => {
      const once = mergeIntoGlobalDefaults(base, patch);
      assert.deepStrictEqual(mergeIntoGlobalDefaults(once, patch), once);
    }));
  });
});

// The store is a config file like any other: since #5759 every config.json read is
// bounded at CONFIG_MAX_BYTES, and the loader already reads defaults.json that way.
// A save reads it under the same cap, so a store the loader refuses is never merged
// into. The cap is inclusive: a store of exactly CONFIG_MAX_BYTES is read.
describe('#5681: config-save-defaults reads the store under the #5759 config cap', () => {
  const { CONFIG_MAX_BYTES } = require('../gsd-core/bin/lib/config-file-read.cjs');

  /**
   * A store of exactly `bytes` bytes holding `mode` plus a padding string, in the
   * form a save writes it (2-space JSON and a trailing newline), so the store's
   * size after a save differs from `bytes` only by the change in `mode`'s length.
   */
  function storeOfSize(bytes, mode = 'interactive', unit = 'x') {
    const render = (pad) => JSON.stringify({ mode, pad }, null, 2) + '\n';
    const room = bytes - render('').length;
    const unitBytes = Buffer.byteLength(unit);
    const text = render(unit.repeat(Math.floor(room / unitBytes)) + 'x'.repeat(room % unitBytes));
    assert.strictEqual(Buffer.byteLength(text), bytes);
    return text;
  }

  function seed(t, text, patch = { mode: 'yolo' }) {
    const home = defaultsHome(t, text, { inProcess: true });
    return { defaultsPath: home.defaultsPath, save: () => home.saveInProcess(patch) };
  }

  for (const [label, bytes] of [['one byte under the cap', CONFIG_MAX_BYTES - 1], ['exactly the cap', CONFIG_MAX_BYTES]]) {
    test(`a store of ${label} is merged into`, async (t) => {
      const before = storeOfSize(bytes);
      const { defaultsPath, save } = seed(t, before);

      const result = await save();

      assert.strictEqual(result.ok, true, result.err);
      const after = JSON.parse(fs.readFileSync(defaultsPath, 'utf-8'));
      assert.strictEqual(after.mode, 'yolo');
      assert.strictEqual(after.pad, JSON.parse(before).pad, 'the key the save does not name survives');
    });
  }

  test('a store one byte over the cap is refused and left as it was', async (t) => {
    const before = storeOfSize(CONFIG_MAX_BYTES + 1);
    const { defaultsPath, save } = seed(t, before);

    const result = await save();

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error.reason, 'config_defaults_invalid');
    assert.strictEqual(fs.readFileSync(defaultsPath, 'utf-8'), before);
    assert.deepStrictEqual(fs.readdirSync(path.dirname(defaultsPath)), ['defaults.json']);
  });

  // The cap holds for what a save writes, not only for what it reads: a save that
  // would grow the store past CONFIG_MAX_BYTES would leave a store that the loader
  // and the next save both refuse, so nothing is written.
  test('a save that would grow the store past the cap is refused and writes nothing', async (t) => {
    const before = storeOfSize(CONFIG_MAX_BYTES, 'yolo');
    const { defaultsPath, save } = seed(t, before, { mode: 'interactive' });

    const result = await save();

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error.reason, 'config_defaults_write_failed');
    assert.strictEqual(fs.readFileSync(defaultsPath, 'utf-8'), before);
    assert.deepStrictEqual(fs.readdirSync(path.dirname(defaultsPath)), ['defaults.json']);
  });

  // The cap is in bytes of the UTF-8 file, not in characters: padded with a
  // two-byte character, this store is about half the cap in characters.
  test('a save is measured in UTF-8 bytes, not characters', async (t) => {
    const before = storeOfSize(CONFIG_MAX_BYTES, 'yolo', 'é');
    assert.ok(before.length < CONFIG_MAX_BYTES / 2 + 64, 'precondition: the store is far under the cap in characters');
    const { defaultsPath, save } = seed(t, before, { mode: 'interactive' });

    const result = await save();

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error.reason, 'config_defaults_write_failed');
    assert.strictEqual(fs.readFileSync(defaultsPath, 'utf-8'), before);
  });

  // A store the loader reads (JSON.parse is iterative) can still be too deep for the
  // recursive merge and serializer. That is a refusal of the store, with its own
  // reason, not a crash of the command. The depth is the deepest the read cap
  // admits (6 bytes a level), so it does not rest on one engine's stack size.
  test('a store nested too deeply to merge is refused and left as it was', async (t) => {
    const depth = Math.floor((CONFIG_MAX_BYTES - 1) / '{"a":}'.length);
    const before = '{"a":'.repeat(depth) + '1' + '}'.repeat(depth);
    assert.ok(Buffer.byteLength(before) <= CONFIG_MAX_BYTES, 'precondition: within the cap');
    const { defaultsPath, save } = seed(t, before);

    const result = await save();

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error.reason, 'config_defaults_invalid');
    assert.strictEqual(fs.readFileSync(defaultsPath, 'utf-8'), before);
    assert.deepStrictEqual(fs.readdirSync(path.dirname(defaultsPath)), ['defaults.json']);
  });

  // The write-side boundary: a save whose result is one byte under, exactly at,
  // and one byte over the cap. The save grows `mode` from "yolo" to
  // "interactive", so the store before it is sized to land the result there.
  for (const [label, resultBytes, written] of [
    ['one byte under the cap', CONFIG_MAX_BYTES - 1, true],
    ['exactly at the cap', CONFIG_MAX_BYTES, true],
    ['one byte over the cap', CONFIG_MAX_BYTES + 1, false],
  ]) {
    test(`a save whose result is ${label} is ${written ? 'written' : 'refused and writes nothing'}`, async (t) => {
      const before = storeOfSize(resultBytes - 'interactive'.length + 'yolo'.length, 'yolo');
      const { defaultsPath, save } = seed(t, before, { mode: 'interactive' });

      const result = await save();

      if (written) {
        assert.strictEqual(result.ok, true, result.err);
        assert.strictEqual(fs.statSync(defaultsPath).size, resultBytes);
        assert.strictEqual(JSON.parse(fs.readFileSync(defaultsPath, 'utf-8')).mode, 'interactive');
      } else {
        assert.strictEqual(result.ok, false);
        assert.strictEqual(result.error.reason, 'config_defaults_write_failed');
        assert.strictEqual(fs.readFileSync(defaultsPath, 'utf-8'), before);
        assert.deepStrictEqual(fs.readdirSync(path.dirname(defaultsPath)), ['defaults.json']);
      }
    });
  }
});

// ─── config-set hooks.secret_read_exempt (#4432) ────────────────────────────
//
// Matrix rows covered (50-test-matrix.md, suite C): 26 39 40.
// The hook (hooks/lib/secret-read-exemptions.js) cannot require src/, so
// config-set re-implements the entry rules; parity with the hook is asserted
// in tests/secret-read-exemptions.test.cjs (suite P).

describe('config-set hooks.secret_read_exempt (#4432)', () => {
  const KEY = 'hooks.secret_read_exempt';
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    seedProjectConfig(tmpDir);
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  const setList = (value) => runGsdTools(['config-set', KEY, typeof value === 'string' ? value : JSON.stringify(value)], tmpDir);

  // Row 39.
  test('stores a valid list as an array', () => {
    const result = setList(['.env.production']);
    assert.ok(result.success, `Command failed: ${result.error}`);
    assert.deepEqual(readConfig(tmpDir).hooks.secret_read_exempt, ['.env.production']);
  });

  test('stores several entries in order', () => {
    const result = setList(['.env.production', 'apps/api/.secrets']);
    assert.ok(result.success, `Command failed: ${result.error}`);
    assert.deepEqual(readConfig(tmpDir).hooks.secret_read_exempt, ['.env.production', 'apps/api/.secrets']);
  });

  // Row 40.
  const REFUSED_VALUES = [
    ['a bare string', '.env.production'],
    ['a JSON string', '".env.production"'],
    ['a JSON object', '{"a":".env.production"}'],
    ['a number', '7'],
    ['a boolean', 'true'],
    ['a list holding a number', '[1]'],
    ['a list holding null', '[null]'],
    ['a list holding an object', '[{}]'],
    ['a valid entry followed by a bad one', '[".env.production","../x"]'],
  ];
  for (const [label, text] of REFUSED_VALUES) {
    test(`refuses ${label} and leaves the config unchanged`, () => {
      const snapshot = fs.readFileSync(path.join(tmpDir, '.planning', 'config.json'), 'utf8');
      const result = setList(text);
      assert.strictEqual(result.success, false, `config-set must refuse ${text}`);
      assert.notStrictEqual(result.exitCode, 0);
      assert.strictEqual(fs.readFileSync(path.join(tmpDir, '.planning', 'config.json'), 'utf8'), snapshot);
    });
  }

  // Row 26: every entry the hook drops is refused here.
  const BAD_ENTRIES = [
    '/etc/x/.env', '../.env', 'a/../.env', 'C:\\x\\.env', 'c:x', '\\\\h\\s\\.env', '//h', '', './', 'a/', '.', 'a\u0000b',
  ];
  for (const entry of BAD_ENTRIES) {
    test(`refuses the entry ${JSON.stringify(entry)} and leaves the config unchanged`, () => {
      const snapshot = fs.readFileSync(path.join(tmpDir, '.planning', 'config.json'), 'utf8');
      const result = setList([entry]);
      assert.strictEqual(result.success, false, `config-set must refuse [${JSON.stringify(entry)}]`);
      assert.notStrictEqual(result.exitCode, 0);
      assert.strictEqual(fs.readFileSync(path.join(tmpDir, '.planning', 'config.json'), 'utf8'), snapshot);
    });
  }

  test('accepts the entries the hook normalizes rather than drops', () => {
    for (const entry of ['./.env.production', '.\\.env.production']) {
      const result = setList([entry]);
      assert.ok(result.success, `config-set must accept ${JSON.stringify(entry)}: ${result.error}`);
    }
  });
});
