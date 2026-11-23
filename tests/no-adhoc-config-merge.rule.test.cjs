'use strict';

/**
 * no-adhoc-config-merge.rule.test.cjs
 *
 * RuleTester tests for local/no-adhoc-config-merge (#6032, ADR-1411 Decision 5): shape (a) reading a
 * configuration layer file outside the resolver boundary, shape (b) spread-merging parsed config
 * objects, the write/probe exclusions, the two exemption kinds and the same-line marker.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { RuleTester, Linter } = require('eslint');
const fc = require('./helpers/fast-check-setup.cjs');

const rule = require('../eslint-rules/no-adhoc-config-merge.cjs');

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: 2022, sourceType: 'commonjs' },
});

const FILE = 'src/foo.cts';

function run(name, cases) {
  ruleTester.run(name, rule, { valid: cases.valid || [], invalid: cases.invalid || [] });
}

describe('no-adhoc-config-merge rule module', () => {
  test('exports meta and create with the three messages', () => {
    assert.strictEqual(typeof rule.create, 'function');
    assert.strictEqual(rule.meta.type, 'problem');
    for (const id of ['layerPathRead', 'layerWalk', 'configSpreadMerge', 'staleAllowlistEntry']) {
      assert.ok(rule.meta.messages[id], `${id} message must exist`);
    }
  });
});

describe('shape (a): a layer file is read', () => {
  test('global defaults file', () => {
    run('a-global', {
      invalid: [{
        code: `const p = path.join(home, '.gsd', 'defaults.json'); const raw = fs.readFileSync(p, 'utf8');`,
        filename: FILE,
        errors: [{ messageId: 'layerPathRead' }],
      }],
    });
  });

  test('planningDir and planningRoot config.json', () => {
    run('a-planning', {
      invalid: [
        { code: `readConfig(path.join(planningDir(cwd), 'config.json'));`, filename: FILE, errors: [{ messageId: 'layerPathRead' }] },
        { code: `readConfig(path.join(planningRoot(cwd), 'config.json'));`, filename: FILE, errors: [{ messageId: 'layerPathRead' }] },
      ],
    });
  });

  test('literal .planning/config.json, as a hook spells it', () => {
    run('a-literal', {
      invalid: [{
        code: `const cfg = JSON.parse(readConfigFileBounded(path.join(cwd, '.planning', 'config.json')));`,
        filename: 'hooks/gsd-some-hook.js',
        errors: [{ messageId: 'layerPathRead' }],
      }],
    });
  });

  test('Claude settings files', () => {
    run('a-claude', {
      invalid: [
        { code: `read(path.join(cwd, '.claude', 'settings.json'));`, filename: FILE, errors: [{ messageId: 'layerPathRead' }] },
        { code: `read(path.join(cwd, '.claude', 'settings.local.json'));`, filename: FILE, errors: [{ messageId: 'layerPathRead' }] },
      ],
    });
  });

  test('path.resolve spelling', () => {
    run('a-resolve', {
      invalid: [{ code: `read(path.resolve(cwd, '.planning', 'config.json'));`, filename: FILE, errors: [{ messageId: 'layerPathRead' }] }],
    });
  });

  test('a path variable handed to a reader is flagged', () => {
    run('a-variable', {
      invalid: [{
        code: `const p = join(planningDir(cwd), 'config.json'); const raw = readConfigFileBounded(p);`,
        filename: FILE,
        errors: [{ messageId: 'layerPathRead' }],
      }],
    });
  });

  test('an unknown consumer fails closed: a candidate list is a read', () => {
    run('a-candidates', {
      invalid: [{ code: `candidates.push(path.join(probe, '.planning', 'config.json'));`, filename: FILE, errors: [{ messageId: 'layerPathRead' }] }],
    });
  });

  test('a returned path is not exempt: a local helper is a fifth copy', () => {
    run('a-return', {
      invalid: [{ code: `function cfgPath(cwd) { return path.join(cwd, '.planning', 'config.json'); }`, filename: FILE, errors: [{ messageId: 'layerPathRead' }] }],
    });
  });
});

describe('write, probe, report and compare sites never match', () => {
  test('probe: existsSync / statSync / accessSync', () => {
    run('probe', {
      valid: [
        { code: `fs.existsSync(path.join(planningDir(cwd), 'config.json'));`, filename: FILE },
        { code: `fs.statSync(path.join(cwd, '.planning', 'config.json'));`, filename: FILE },
        { code: `fs.accessSync(path.join(cwd, '.planning', 'config.json'), fs.constants.F_OK);`, filename: FILE },
        { code: `const p = path.join(cwd, '.planning', 'config.json'); try { fs.accessSync(p, 0); } catch {}`, filename: FILE },
      ],
    });
  });

  test('read-modify-write: the path also reaches a write', () => {
    run('rmw', {
      valid: [
        {
          code: `const p = path.join(planningDir(cwd), 'config.json'); const c = load(p); platformWriteSync(p, JSON.stringify(c));`,
          filename: FILE,
        },
        {
          code: `const p = path.join(planningDir(cwd), 'config.json'); const c = load(p); fs.writeFileSync(p, JSON.stringify(c));`,
          filename: FILE,
        },
      ],
    });
  });

  test('reported and compared values', () => {
    run('report', {
      valid: [
        { code: `const out = { config_path: toPosixPath(path.join(planningDir(cwd), 'config.json')) };`, filename: FILE },
        { code: `if (file === path.resolve(cwd, '.planning', 'config.json')) { noop(); }`, filename: FILE },
      ],
    });
  });

  test('a join that is not a layer file passes', () => {
    run('not-layer', {
      valid: [
        { code: `read(path.join(dir, 'config.json'));`, filename: FILE },
        { code: `read(path.join(dir, '.planning', 'STATE.md'));`, filename: FILE },
        { code: `read(path.join(dir, 'settings.json'));`, filename: FILE },
        { code: `read(path.join(planningDir(cwd), 'phases'));`, filename: FILE },
      ],
    });
  });
});

describe('shape (c): one function reads two or more layers', () => {
  test('two different layers read through the owner helpers is a walk', () => {
    run('c-walk', {
      invalid: [
        {
          code: `function pick(cwd) { const a = read(projectConfigPath(cwd)); const b = read(rootConfigPath(cwd)); return a ?? b; }`,
          filename: FILE,
          errors: [{ messageId: 'layerWalk' }],
        },
        {
          code: `function pick(cwd) { return read(projectConfigPath(cwd)) ?? read(globalDefaultsPath()); }`,
          filename: FILE,
          errors: [{ messageId: 'layerWalk' }],
        },
        {
          code: `function pick(d) { return read(claudeSettingsPath(d, 'local')) ?? read(claudeSettingsPath(d)); }`,
          filename: FILE,
          errors: [{ messageId: 'layerWalk' }],
        },
        {
          code: `function pick(d, env) { return claudeSettingsPaths(d, env).map(read); }`,
          filename: FILE,
          errors: [{ messageId: 'layerWalk' }],
        },
      ],
    });
  });

  test('a single layer, the same layer twice, and probe or write uses are not a walk', () => {
    run('c-valid', {
      valid: [
        { code: `function one(cwd) { return read(projectConfigPath(cwd)); }`, filename: FILE },
        { code: `function same(cwd) { return [read(projectConfigPath(cwd)), read(projectConfigPath(cwd, 'x'))]; }`, filename: FILE },
        { code: `function probe(cwd) { return fs.existsSync(rootConfigPath(cwd)) && read(projectConfigPath(cwd)); }`, filename: FILE },
        { code: `function save(cwd) { const g = globalDefaultsPath(); fs.writeFileSync(g, '{}'); return read(projectConfigPath(cwd)); }`, filename: FILE },
        { code: `function stat(cwd, fsStatSync) { fsStatSync(rootConfigPath(cwd)); fsStatSync(globalDefaultsPath()); }`, filename: FILE },
      ],
    });
  });

  test('two functions each reading one layer are not a walk', () => {
    run('c-two-functions', {
      valid: [{
        code: `function a(cwd) { return read(projectConfigPath(cwd)); } function b() { return read(globalDefaultsPath()); }`,
        filename: FILE,
      }],
    });
  });

  test('a walk inside a resolverInternal file is exempt', () => {
    run('c-internal', {
      valid: [{
        code: `function pick(cwd) { return read(projectConfigPath(cwd)) ?? read(rootConfigPath(cwd)); }`,
        filename: 'src/config-loader.cts',
        options: [{ resolverInternal: ['src/config-loader.cts'] }],
      }],
    });
  });
});

describe('shape (b): spread-merging parsed config objects', () => {
  test('object spread of two config objects', () => {
    run('b-spread', {
      invalid: [
        { code: `const merged = { ...globalCfg, ...projectCfg };`, filename: FILE, errors: [{ messageId: 'configSpreadMerge' }] },
        { code: `const merged = { ...defaults, ...JSON.parse(raw) };`, filename: FILE, errors: [{ messageId: 'configSpreadMerge' }] },
      ],
    });
  });

  test('Object.assign of two config objects', () => {
    run('b-assign', {
      invalid: [{ code: `const merged = Object.assign({}, globalConfig, projectConfig);`, filename: FILE, errors: [{ messageId: 'configSpreadMerge' }] }],
    });
  });

  test('a single config spread over a literal, and unrelated spreads, pass', () => {
    run('b-valid', {
      valid: [
        { code: `const o = { mode: 'x', ...config };`, filename: FILE },
        { code: `const o = { ...a, ...b };`, filename: FILE },
        { code: `const o = Object.assign({}, options);`, filename: FILE },
      ],
    });
  });
});

describe('exemptions', () => {
  const code = `read(path.join(cwd, '.planning', 'config.json'));`;

  test('resolverInternal is exempt, with or without offences, and is never stale', () => {
    run('internal', {
      valid: [
        { code, filename: 'src/config-loader.cts', options: [{ resolverInternal: ['src/config-loader.cts'] }] },
        { code: `const x = 1;`, filename: 'src/config-loader.cts', options: [{ resolverInternal: ['src/config-loader.cts'] }] },
      ],
    });
  });

  test('temporary: exempt while it offends, stale once it does not', () => {
    run('temporary', {
      valid: [{ code, filename: 'src/legacy.cts', options: [{ temporary: ['src/legacy.cts'] }] }],
      invalid: [
        { code: `const x = 1;`, filename: 'src/legacy.cts', options: [{ temporary: ['src/legacy.cts'] }], errors: [{ messageId: 'staleAllowlistEntry' }] },
        { code, filename: 'src/other.cts', options: [{ temporary: ['src/legacy.cts'] }], errors: [{ messageId: 'layerPathRead' }] },
      ],
    });
  });

  test('a rule configured with no options does not crash', () => {
    run('no-options', { valid: [{ code: `x.y(1);`, filename: FILE }] });
  });

  test('same-line marker with a reason suppresses; an empty reason or a missing colon does not', () => {
    run('marker', {
      valid: [{ code: `${code} // allow-adhoc-config-merge: pre-build bootstrap file`, filename: FILE }],
      invalid: [
        { code: `${code} // allow-adhoc-config-merge:`, filename: FILE, errors: [{ messageId: 'layerPathRead' }] },
        { code: `${code} // allow-adhoc-config-merge no reason`, filename: FILE, errors: [{ messageId: 'layerPathRead' }] },
      ],
    });
  });
});

describe('property: a layer path is classified by how it is used, whatever the names around it', () => {
  const SHAPES = [
    "path.join(home, '.gsd', 'defaults.json')",
    "path.join(planningDir(cwd), 'config.json')",
    "path.join(planningRoot(cwd), 'config.json')",
    "path.join(cwd, '.planning', 'config.json')",
    "path.join(cwd, '.claude', 'settings.json')",
    "path.join(cwd, '.claude', 'settings.local.json')",
  ];
  const ident = fc.stringMatching(/^[a-z0-9]{0,8}$/).map((s) => `v${s}`);
  const linter = new Linter({ configType: 'flat' });
  const ids = (code) => linter
    .verify(code, [{
      files: ['**/*.cts'],
      plugins: { local: { rules: { 'no-adhoc-config-merge': rule } } },
      rules: { 'local/no-adhoc-config-merge': 'error' },
      languageOptions: { ecmaVersion: 2022, sourceType: 'commonjs' },
    }], { filename: FILE })
    .map((m) => m.messageId);

  test('a probe or a read-modify-write never reports; any other consumer always does', () => {
    fc.assert(fc.property(fc.constantFrom(...SHAPES), ident, (shape, name) => {
      assert.deepEqual(ids(`const ${name} = ${shape}; fs.existsSync(${name});`), []);
      assert.deepEqual(ids(`const ${name} = ${shape}; load(${name}); platformWriteSync(${name}, x);`), []);
      assert.deepEqual(ids(`const ${name} = ${shape}; load(${name});`), ['layerPathRead']);
    }));
  });
});
