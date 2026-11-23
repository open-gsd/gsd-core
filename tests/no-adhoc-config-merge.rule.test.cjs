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
const { RuleTester } = require('eslint');

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
    for (const id of ['layerPathRead', 'configSpreadMerge', 'staleAllowlistEntry']) {
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
