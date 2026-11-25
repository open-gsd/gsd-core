// ~/.gsd/defaults.json is machine-wide. The `runtime` key is host-specific
// (written by whichever installer ran last). It must NOT be copied into project
// configs — on a machine with 2+ runtimes, it poisons every new project.

'use strict';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runGsdTools, createTempDir, cleanup, TOOLS_PATH } = require('./helpers.cjs');
const fc = require('./helpers/fast-check-setup.cjs');
const { MODEL_ALIAS_MAP, KNOWN_RUNTIMES } = require('../gsd-core/bin/lib/model-catalog.cjs');
const {
  resolveModelInternal,
  _setInstallRuntimeMarkerForTests,
  _resetInstallRuntimeMarkerCacheForTests,
} = require('../gsd-core/bin/lib/model-resolver.cjs');
const { runNode, OUTCOME } = require('./helpers/process-seam.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { isolatedEnv } = require('./helpers/isolated-env.cjs');

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

    const result = runGsdTools('config-ensure-section', tmpDir, isolatedEnv({ home: tmpDir }));
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

    const result = runGsdTools('config-ensure-section', tmpDir, isolatedEnv({ home: tmpDir }));
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
    env = isolatedEnv({ home, override: { GSD_HOME: store, GSD_RUNTIME: 'claude' } });
    iteration = 0;
  });
  afterEach(() => cleanup(root));

  function creationArgs(command, choices = {}) {
    if (command === 'config-new-project') return [command, JSON.stringify(choices)];
    return command === 'config-set-model-profile' ? [command, 'balanced'] : [command];
  }

  // The in-process rows share process.env and the install-marker seam with
  // runGsdTools; snapshot, apply and restore them in one place.
  const ENV_KEYS = ['GSD_RUNTIME', 'GSD_HOME', 'HOME', 'USERPROFILE', 'GSD_WORKSTREAM', 'GSD_PROJECT'];
  function useProcessEnv(t, runtime) {
    const original = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    t.after(() => {
      _setInstallRuntimeMarkerForTests(null);
      _resetInstallRuntimeMarkerCacheForTests();
      for (const key of ENV_KEYS) {
        if (original[key] === undefined) delete process.env[key];
        else process.env[key] = original[key];
      }
    });
    // Copy only the snapshotted keys: the isolated env is a whole environment.
    for (const key of ENV_KEYS) {
      if (env[key] === undefined) delete process.env[key];
      else process.env[key] = env[key];
    }
    if (runtime === null) delete process.env.GSD_RUNTIME;
    else process.env.GSD_RUNTIME = runtime;
    _setInstallRuntimeMarkerForTests(null);
  }

  // Creates the project through the CLI in this process, so the command's JSON
  // result is captured instead of written to the test reporter's stdout. The
  // helper blanks config-location variables by default, so pass the fixture's.
  function createProject(command, cwd, choices = {}) {
    const fixtureEnv = Object.fromEntries(ENV_KEYS.filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]));
    const result = runGsdTools(creationArgs(command, choices), cwd, fixtureEnv);
    assert.equal(result.exitCode, 0, result.error);
    return JSON.parse(fs.readFileSync(path.join(cwd, '.planning', 'config.json'), 'utf8'));
  }

  function seed(defaults, command, choices = {}, cwd = project, activeRuntime = 'claude') {
    fs.writeFileSync(path.join(store, '.gsd', 'defaults.json'), JSON.stringify(defaults));
    const result = runGsdTools(creationArgs(command, choices), cwd, { ...env, GSD_RUNTIME: activeRuntime });
    assert.equal(result.exitCode, 0, result.error);
    assert.equal(result.error ?? '', '', 'project creation must not write to stderr');
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
      assert.equal(resolve('gsd-executor').model, value === true ? MODEL_ALIAS_MAP.sonnet : 'sonnet');
    });
  }

  test('the install runtime marker determines shared omit with hermetic in-process defaults', (t) => {
    useProcessEnv(t, null);
    fs.writeFileSync(path.join(store, '.gsd', 'defaults.json'), JSON.stringify({
      resolve_model_ids: 'omit', model_profile: 'balanced',
    }));
    for (const runtime of ['claude', 'cline', 'codex']) {
      _setInstallRuntimeMarkerForTests(runtime);
      for (const command of ['config-new-project', 'config-ensure-section', 'config-set-model-profile']) {
        const cwd = path.join(root, `marker-${runtime}-${command}`);
        fs.mkdirSync(cwd);
        const before = ['gsd-executor', 'my-custom-agent'].map((agent) => resolveModelInternal(cwd, agent));
        const config = createProject(command, cwd);
        assert.equal(Object.hasOwn(config, 'resolve_model_ids'), runtime !== 'claude', command);
        assert.deepEqual(['gsd-executor', 'my-custom-agent'].map((agent) => resolveModelInternal(cwd, agent)), before, command);
      }
    }
  });

  for (const runtime of KNOWN_RUNTIMES) {
    for (const profile of ['balanced', 'inherit']) {
      for (const rung of ['environment', 'choice', 'marker']) {
        test(`${runtime} ${profile} ${rung}: known and unknown agent resolution survive seeding`, (t) => {
          useProcessEnv(t, null);
          const defaults = { resolve_model_ids: 'omit', model_profile: profile };
          const choices = {};
          if (rung === 'environment') process.env.GSD_RUNTIME = runtime;
          else if (rung === 'marker') _setInstallRuntimeMarkerForTests(runtime);
          else {
            // The unseeded global layer carries the same identity the explicit
            // creation choice will persist, so this compares one active runtime.
            defaults.runtime = runtime;
            choices.runtime = runtime;
          }
          fs.writeFileSync(path.join(store, '.gsd', 'defaults.json'), JSON.stringify(defaults));
          const agents = ['gsd-executor', 'my-custom-agent'];
          const before = agents.map((agent) => resolveModelInternal(project, agent));
          createProject('config-new-project', project, choices);
          assert.deepEqual(agents.map((agent) => resolveModelInternal(project, agent)), before);
        });
      }
    }
  }

  for (const [choice, runtime, expected] of [
    ['claude', 'claude', 'sonnet'], ['cline', 'claude', 'sonnet'], ['codex', 'cline', ''],
    [null, 'claude', 'sonnet'], ['', 'claude', 'sonnet'], ['foo', 'claude', 'sonnet'],
  ]) {
    test(`runtime choice ${JSON.stringify(choice)} and environment ${runtime} preserve resolution across seeding`, (t) => {
      useProcessEnv(t, runtime);
      fs.writeFileSync(path.join(store, '.gsd', 'defaults.json'), JSON.stringify({ resolve_model_ids: 'omit' }));
      const before = resolveModelInternal(project, 'gsd-executor');
      assert.equal(before, expected);
      const config = createProject('config-new-project', project, { runtime: choice });
      if (choice === null) assert.equal(Object.hasOwn(config, 'runtime'), false);
      else assert.equal(config.runtime, choice);
      assert.equal(resolveModelInternal(project, 'gsd-executor'), expected);
    });
  }

  // The changeset promises these two routes survive seeding. A copied project
  // omit takes the #3703 tier-alias path, which outranks both, so the old
  // seeding collapsed them to the bare alias.
  const PINNED = 'claude-sonnet-4-6';
  for (const [route, extra] of [
    ['model_profile_overrides.claude pin', { model_profile_overrides: { claude: { sonnet: PINNED } } }],
    ['dynamic_routing tier model', {
      dynamic_routing: { enabled: true, tier_models: { light: 'claude-haiku-4-5', standard: PINNED, heavy: 'claude-opus-4-8' } },
    }],
  ]) {
    test(`Claude ${route} survives seeding under a shared omit`, (t) => {
      useProcessEnv(t, 'claude');
      fs.writeFileSync(path.join(store, '.gsd', 'defaults.json'), JSON.stringify({
        resolve_model_ids: 'omit', model_profile: 'balanced', ...extra,
      }));
      assert.equal(resolveModelInternal(project, 'gsd-executor'), PINNED);
      const config = createProject('config-new-project', project);
      const configPath = path.join(project, '.planning', 'config.json');
      assert.equal(Object.hasOwn(config, 'resolve_model_ids'), false);
      assert.equal(resolveModelInternal(project, 'gsd-executor'), PINNED);
      // Control: the omit the old seeding copied would discard the route.
      fs.writeFileSync(configPath, JSON.stringify({ ...config, resolve_model_ids: 'omit' }));
      assert.equal(resolveModelInternal(project, 'gsd-executor'), 'sonnet');
    });
  }

  test('existing project omit survives both creation commands byte-for-byte', () => {
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
      cwd: project, env, timeoutMs: PROBE_TIMEOUT_MS,
    });
    assert.equal(result.outcome, OUTCOME.EXITED);
    assert.equal(result.exitCode, 0);
    // #3703: an explicit project omit on Claude Code resolves the profile tier alias.
    assert.equal(JSON.parse(result.stdout).model, 'sonnet');
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
