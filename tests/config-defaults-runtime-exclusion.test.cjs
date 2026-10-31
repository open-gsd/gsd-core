// ~/.gsd/defaults.json is machine-wide. The `runtime` key is host-specific
// (written by whichever installer ran last). It must NOT be copied into project
// configs — on a machine with 2+ runtimes, it poisons every new project.

'use strict';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runGsdTools, createTempDir, cleanup, TOOLS_PATH, TEST_ENV_BASE } = require('./helpers.cjs');
const fc = require('./helpers/fast-check-setup.cjs');
const { MODEL_ALIAS_MAP, RUNTIME_PROFILE_MAP } = require('../gsd-core/bin/lib/model-catalog.cjs');
const { MODEL_RESOLVER_DIAGNOSTIC, PROJECT_MODEL_OMIT_WARNING } = require('../gsd-core/bin/lib/model-resolver.cjs');
const { runNode, OUTCOME } = require('./helpers/process-seam.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

describe('#2840 — runtime from defaults.json must not poison project config', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempDir('cfg-runtime-');
    fs.mkdirSync(path.join(tmpDir, '.planning'), { recursive: true });
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('runtime key in defaults.json is NOT copied into the new project config', () => {
    // Create ~/.gsd/defaults.json with a runtime key + a legitimate key
    fs.mkdirSync(path.join(tmpDir, '.gsd'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.gsd', 'defaults.json'),
      JSON.stringify({ runtime: 'codex', model_profile: 'opus' }),
    );

    const result = runGsdTools('config-ensure-section', tmpDir, {
      HOME: tmpDir,
      USERPROFILE: tmpDir,
    });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = JSON.parse(
      fs.readFileSync(path.join(tmpDir, '.planning', 'config.json'), 'utf8'),
    );
    // runtime must NOT be in the project config — it's host-specific.
    assert.ok(
      !('runtime' in config),
      `runtime must not be copied from defaults.json into the project config; got: ${JSON.stringify({ runtime: config.runtime })}`,
    );
    // Other defaults must still be copied.
    assert.strictEqual(
      config.model_profile,
      'opus',
      'legitimate defaults (model_profile) must still be copied from defaults.json',
    );
  });

  test('defaults.json without a runtime key works normally', () => {
    fs.mkdirSync(path.join(tmpDir, '.gsd'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.gsd', 'defaults.json'),
      JSON.stringify({ model_profile: 'haiku' }),
    );

    const result = runGsdTools('config-ensure-section', tmpDir, {
      HOME: tmpDir,
      USERPROFILE: tmpDir,
    });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = JSON.parse(
      fs.readFileSync(path.join(tmpDir, '.planning', 'config.json'), 'utf8'),
    );
    assert.strictEqual(config.model_profile, 'haiku');
    assert.ok(!('runtime' in config), 'runtime should not appear when defaults.json lacks it');
  });
});

describe('#5329 — shared omit must not become explicit project model intent', () => {
  let root;
  let home;
  let store;
  let project;
  let env;
  let iteration;

  beforeEach(() => {
    root = createTempDir('cfg-model-omit-');
    home = path.join(root, 'home');
    store = path.join(root, 'store');
    project = path.join(root, 'project');
    for (const dir of [home, project, path.join(store, '.gsd')]) fs.mkdirSync(dir, { recursive: true });
    env = { HOME: home, USERPROFILE: home, GSD_HOME: store, GSD_RUNTIME: 'claude' };
    iteration = 0;
  });
  afterEach(() => cleanup(root));

  function seed(defaults, command, choices = {}, cwd = project, activeRuntime = 'claude') {
    fs.writeFileSync(path.join(store, '.gsd', 'defaults.json'), JSON.stringify(defaults));
    const args = command === 'config-new-project'
      ? [command, JSON.stringify(choices)]
      : command === 'config-set-model-profile' ? [command, 'balanced'] : [command];
    const result = runGsdTools(args, cwd, { ...env, GSD_RUNTIME: activeRuntime });
    assert.equal(result.exitCode, 0, result.error);
    assert.equal(result.error ?? '', '', 'project creation must not emit an omit diagnostic');
    const response = JSON.parse(result.output);
    if (command === 'config-set-model-profile') assert.equal(response.updated, true);
    else assert.equal(response.created, true);
    return JSON.parse(fs.readFileSync(path.join(cwd, '.planning', 'config.json'), 'utf8'));
  }

  function resolve(agent, runtime = 'claude') {
    const result = runGsdTools(['query', 'resolve-model', agent], project, { ...env, GSD_RUNTIME: runtime });
    assert.equal(result.exitCode, 0, result.error);
    return JSON.parse(result.output);
  }

  for (const command of ['config-new-project', 'config-ensure-section', 'config-set-model-profile']) {
    for (const runtime of [undefined, 'codex', 'opencode']) {
      test(`${command} excludes shared omit with runtime=${runtime ?? 'absent'} and resolves Claude tiers`, () => {
        const defaults = { resolve_model_ids: 'omit', model_profile: 'balanced' };
        if (runtime !== undefined) defaults.runtime = runtime;
        const config = seed(defaults, command);
        assert.equal(Object.hasOwn(config, 'resolve_model_ids'), false);
        assert.equal(Object.hasOwn(config, 'runtime'), false);
        assert.equal(config.model_profile, 'balanced');
        assert.equal(resolve('gsd-executor').model, 'sonnet');
        assert.equal(resolve('gsd-planner').model, 'opus');
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(store, '.gsd', 'defaults.json'), 'utf8')), defaults);
      });
    }

    for (const value of [true, false]) {
      test(`${command} preserves shared resolve_model_ids=${value}`, () => {
        const config = seed({ resolve_model_ids: value }, command);
        assert.equal(config.resolve_model_ids, value);
        assert.equal(resolve('gsd-executor').model, value ? MODEL_ALIAS_MAP.sonnet : 'sonnet');
      });
    }
  }

  for (const value of ['omit', true, false]) {
    test(`config-new-project preserves explicit resolve_model_ids=${value}`, () => {
      const config = seed({ resolve_model_ids: 'omit' }, 'config-new-project', { resolve_model_ids: value });
      assert.equal(config.resolve_model_ids, value);
      assert.equal(resolve('gsd-executor').model, value === 'omit' ? '' : value ? MODEL_ALIAS_MAP.sonnet : 'sonnet');
    });
  }

  for (const runtime of ['codex', 'opencode']) {
    test(`${runtime} still resolves its runtime tier map after project seeding`, () => {
      seed({ resolve_model_ids: 'omit', runtime }, 'config-new-project', {}, project, runtime);
      assert.equal(resolve('gsd-executor', runtime).model, RUNTIME_PROFILE_MAP[runtime].sonnet.model);
    });
  }

  for (const runtime of ['cline', 'kimi', 'kimi-code', 'cursor', 'windsurf', 'zcode', 'augment', 'trae', 'codebuddy', 'antigravity']) {
    test(`${runtime} keeps shared omit because it has no runtime tier map`, () => {
      const config = seed({ resolve_model_ids: 'omit', runtime }, 'config-new-project', {}, project, runtime);
      assert.equal(config.resolve_model_ids, 'omit');
      assert.equal(Object.hasOwn(config, 'runtime'), false);
      assert.equal(resolve('gsd-executor', runtime).model, '');
    });
  }

  test('existing project CLI resolution warns without either creation command rewriting its config', () => {
    fs.mkdirSync(path.join(project, '.planning'));
    const configPath = path.join(project, '.planning', 'config.json');
    const bytes = Buffer.from('{\n    "resolve_model_ids": "omit",\n    "model_profile": "balanced"\n}\n');
    fs.writeFileSync(configPath, bytes);
    for (const args of [['config-new-project', '{"resolve_model_ids":false}'], ['config-ensure-section']]) {
      const result = runGsdTools(args, project, env);
      assert.equal(result.exitCode, 0, result.error);
      assert.equal(JSON.parse(result.output).created, false);
      assert.deepEqual(fs.readFileSync(configPath), bytes);
    }
    const result = runNode([TOOLS_PATH, 'query', 'resolve-model', 'gsd-executor'], {
      cwd: project, env: { ...process.env, ...TEST_ENV_BASE, ...env }, timeoutMs: PROBE_TIMEOUT_MS,
    });
    assert.equal(result.outcome, OUTCOME.EXITED);
    assert.equal(result.exitCode, 0);
    assert.equal(JSON.parse(result.stdout).model, '');
    assert.equal(result.stderr, PROJECT_MODEL_OMIT_WARNING + '\n');
    assert.equal(MODEL_RESOLVER_DIAGNOSTIC.PROJECT_MODEL_OMIT, 'project_model_omit');
    assert.deepEqual(fs.readFileSync(configPath), bytes);
  });

  test('seeding preserves every explicit JSON choice and excludes only exact shared omit', async () => {
    await fc.assert(fc.property(
      fc.oneof(fc.constantFrom('omit', 'OMIT', ' omit', 'omit ', '', true, false, null, 0, [], {}), fc.jsonValue()),
      fc.jsonValue(), fc.boolean(),
      (sharedValue, choiceValue, explicit) => {
        const cwd = path.join(root, `property-${iteration++}`);
        fs.mkdirSync(cwd);
        const defaults = { resolve_model_ids: sharedValue, model_profile: 'budget', runtime: 'codex' };
        const choices = explicit ? { resolve_model_ids: choiceValue } : {};
        const config = seed(defaults, 'config-new-project', choices, cwd);
        assert.equal(Object.hasOwn(config, 'resolve_model_ids'), explicit || sharedValue !== 'omit');
        if (Object.hasOwn(config, 'resolve_model_ids')) {
          assert.deepEqual(config.resolve_model_ids, explicit ? choiceValue : sharedValue);
        }
        assert.equal(config.model_profile, 'budget');
        assert.equal(Object.hasOwn(config, 'runtime'), false);
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(store, '.gsd', 'defaults.json'), 'utf8')), defaults);
      },
    // Fixed cases above own the sentinel matrix. Forty isolated CLI runs retain
    // seeded arbitrary-JSON coverage without multiplying every platform lane by
    // fast-check's default 100 subprocesses.
    ), { numRuns: 40 });
  });
});
