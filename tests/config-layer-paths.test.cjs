'use strict';

/**
 * config-layer-paths.test.cjs
 *
 * The owner's path helpers (#6032, ADR-1411 Decision 5) name each configuration layer file in
 * exactly one place per execution context, and the hook-side equivalents (hooks are standalone
 * files staged at install, so they cannot require the built library) are pinned to the loader's.
 * If the two ever disagree this file fails.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');

const loader = require('../gsd-core/bin/lib/config-loader.cjs');
const { planningDir, planningRoot } = require('../gsd-core/bin/lib/planning-workspace.cjs');
const hook = require('../hooks/lib/config-read.js');

function withEnv(env, run) {
  const keys = Object.keys(env);
  const old = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) {
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  try {
    return run();
  } finally {
    for (const key of keys) {
      if (old[key] === undefined) delete process.env[key];
      else process.env[key] = old[key];
    }
  }
}

const NO_SCOPE = { GSD_WORKSTREAM: undefined, GSD_PROJECT: undefined };
const CWD = path.join(os.tmpdir(), 'gsd-layer-paths-fixture');

describe('loader layer path helpers', () => {
  test('projectConfigPath is the planning dir config.json, unscoped and per workstream', () => {
    withEnv(NO_SCOPE, () => {
      assert.equal(loader.projectConfigPath(CWD), path.join(planningDir(CWD), 'config.json'));
      assert.equal(loader.projectConfigPath(CWD, 'alpha'), path.join(planningDir(CWD, 'alpha'), 'config.json'));
      assert.equal(loader.projectConfigPath(CWD, null), path.join(planningDir(CWD, null), 'config.json'));
    });
  });

  test('projectConfigPath follows GSD_WORKSTREAM; rootConfigPath never does', () => {
    withEnv({ GSD_WORKSTREAM: 'beta', GSD_PROJECT: undefined }, () => {
      assert.equal(loader.projectConfigPath(CWD), path.join(planningDir(CWD), 'config.json'));
      assert.equal(loader.rootConfigPath(CWD), path.join(planningRoot(CWD), 'config.json'));
      assert.notEqual(loader.projectConfigPath(CWD), loader.rootConfigPath(CWD));
    });
  });

  test('claudeSettingsPath names the shared and local settings files', () => {
    const dir = path.join(CWD, '.claude');
    assert.equal(loader.claudeSettingsPath(dir), path.join(dir, 'settings.json'));
    assert.equal(loader.claudeSettingsPath(dir, 'shared'), path.join(dir, 'settings.json'));
    assert.equal(loader.claudeSettingsPath(dir, 'local'), path.join(dir, 'settings.local.json'));
  });
});

describe('hook-side helpers agree with the loader', () => {
  test('projectConfigPath matches the loader for an unscoped project', () => {
    withEnv(NO_SCOPE, () => {
      assert.equal(hook.projectConfigPath(CWD), loader.projectConfigPath(CWD));
    });
  });

  for (const [name, value] of [['unset', undefined], ['blank', ''], ['set', path.join(os.tmpdir(), 'gsd-home-fixture')]]) {
    test(`globalDefaultsPath matches the loader with GSD_HOME ${name}`, () => {
      withEnv({ GSD_HOME: value }, () => {
        assert.equal(hook.globalDefaultsPath(), loader.globalDefaultsPath());
        assert.equal(hook.globalDefaultsPath(process.env, os.homedir()), loader.globalDefaultsPath());
      });
    });
  }

  test('globalDefaultsPath takes an injected env and home', () => {
    assert.equal(hook.globalDefaultsPath({}, '/h'), path.join('/h', '.gsd', 'defaults.json'));
    assert.equal(hook.globalDefaultsPath({ GSD_HOME: '/g' }, '/h'), path.join('/g', '.gsd', 'defaults.json'));
  });

  test('claudeSettingsPaths lists project then user files, local before shared', () => {
    const user = path.join(os.tmpdir(), 'gsd-user-claude');
    assert.deepEqual(hook.claudeSettingsPaths(CWD, { CLAUDE_CONFIG_DIR: user }), [
      loader.claudeSettingsPath(path.join(CWD, '.claude'), 'local'),
      loader.claudeSettingsPath(path.join(CWD, '.claude'), 'shared'),
      loader.claudeSettingsPath(user, 'local'),
      loader.claudeSettingsPath(user, 'shared'),
    ]);
  });

  test('claudeSettingsPaths without a project dir lists only the user files', () => {
    const user = path.join(os.tmpdir(), 'gsd-user-claude');
    assert.deepEqual(hook.claudeSettingsPaths('', { CLAUDE_CONFIG_DIR: user }), [
      loader.claudeSettingsPath(user, 'local'),
      loader.claudeSettingsPath(user, 'shared'),
    ]);
  });
});
