'use strict';

/**
 * layer-path-helpers.test.cjs
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
const fc = require('./helpers/fast-check-setup.cjs');

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

describe('loader claudeSettingsLayers', () => {
  test('lists project local, project shared, then the user file, highest precedence first', () => {
    const user = path.join(os.tmpdir(), 'gsd-user-claude');
    assert.deepEqual(loader.claudeSettingsLayers(CWD, user), [
      { scope: 'projectLocal', file: path.join(CWD, '.claude', 'settings.local.json') },
      { scope: 'project', file: path.join(CWD, '.claude', 'settings.json') },
      { scope: 'user', file: path.join(user, 'settings.json') },
    ]);
  });

  test('a null user dir drops the user layer', () => {
    assert.deepEqual(loader.claudeSettingsLayers(CWD, null).map((layer) => layer.scope), ['projectLocal', 'project']);
  });
});

describe('loader readConfigFilesQuiet', () => {
  const fs = require('node:fs');
  const { cleanup } = require('./helpers.cjs');

  function project(files) {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-quiet-config-'));
    fs.mkdirSync(path.join(cwd, '.planning', 'workstreams', 'ws1'), { recursive: true });
    for (const [rel, body] of Object.entries(files)) fs.writeFileSync(path.join(cwd, '.planning', rel), body);
    return cwd;
  }

  test('a workstream config merges over the root; an absent file is silent', () => {
    const cwd = project({ 'config.json': '{"a":1,"b":1}', [path.join('workstreams', 'ws1', 'config.json')]: '{"b":2}' });
    try {
      withEnv(NO_SCOPE, () => {
        const read = loader.readConfigFilesQuiet(cwd, 'ws1');
        assert.deepEqual(read.config, { a: 1, b: 2 });
        assert.equal(read.configError, undefined);
        assert.deepEqual(loader.readConfigFilesQuiet(cwd, null).config, { a: 1, b: 1 });
      });
    } finally {
      cleanup(cwd);
    }
  });

  test('a broken workstream config falls back to the root and is named in configError', () => {
    const cwd = project({ 'config.json': '{"a":1}', [path.join('workstreams', 'ws1', 'config.json')]: '{ not json' });
    try {
      withEnv(NO_SCOPE, () => {
        const read = loader.readConfigFilesQuiet(cwd, 'ws1');
        assert.deepEqual(read.config, { a: 1 });
        assert.equal(read.configError.path, path.join(cwd, '.planning', 'workstreams', 'ws1', 'config.json'));
      });
    } finally {
      cleanup(cwd);
    }
  });

  test('a config that is not a JSON object is named in configError and yields no config', () => {
    const cwd = project({ 'config.json': '[1,2]' });
    try {
      withEnv(NO_SCOPE, () => {
        const read = loader.readConfigFilesQuiet(cwd, null);
        assert.equal(read.config, null);
        assert.equal(read.configError.message, 'configuration must be a JSON object');
      });
    } finally {
      cleanup(cwd);
    }
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
});

describe('property: the hook-side and loader helpers agree for any input', () => {
  const text = fc.string({ maxLength: 24 });

  test('globalDefaultsPath: GSD_HOME when non-empty, else the home directory', () => {
    fc.assert(fc.property(text, text, (gsdHome, home) => {
      const expected = path.join(gsdHome || home, '.gsd', 'defaults.json');
      assert.equal(hook.globalDefaultsPath({ GSD_HOME: gsdHome }, home), expected);
      assert.equal(loader.globalDefaultsPath(gsdHome || home), expected);
    }));
  });

  test('projectConfigPath: the planning dir config.json for any workstream name', () => {
    fc.assert(fc.property(fc.stringMatching(/^[a-z0-9]{1,8}$/), (ws) => {
      withEnv({ GSD_PROJECT: undefined }, () => {
        assert.equal(loader.projectConfigPath(CWD, ws), path.join(planningDir(CWD, ws), 'config.json'));
      });
    }));
  });

  test('readConfigFilesQuiet: a workstream config overrides the root per key and keeps the rest', () => {
    const fs = require('node:fs');
    const { cleanup } = require('./helpers.cjs');
    const flat = fc.dictionary(fc.stringMatching(/^k[a-z0-9]{0,5}$/), fc.integer({ min: 0, max: 99 }), { maxKeys: 5 });
    fc.assert(fc.property(flat, flat, (root, scoped) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-quiet-prop-'));
      try {
        fs.mkdirSync(path.join(cwd, '.planning', 'workstreams', 'ws1'), { recursive: true });
        fs.writeFileSync(path.join(cwd, '.planning', 'config.json'), JSON.stringify(root));
        fs.writeFileSync(path.join(cwd, '.planning', 'workstreams', 'ws1', 'config.json'), JSON.stringify(scoped));
        withEnv(NO_SCOPE, () => {
          assert.deepEqual(loader.readConfigFilesQuiet(cwd, 'ws1').config, { ...root, ...scoped });
        });
      } finally {
        cleanup(cwd);
      }
    }), { numRuns: 25 });
  });
});
