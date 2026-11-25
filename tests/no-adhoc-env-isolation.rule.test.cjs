'use strict';

/**
 * no-adhoc-env-isolation.rule.test.cjs
 *
 * #6035 (epic #4635 Phase 3): tests for the local/no-adhoc-env-isolation ESLint rule: arm 1
 * (an inline PATH split or filter), arm 2 (a hand-built HOME / USERPROFILE env), the boundary the rule's reference page documents (the rule header links it), a red
 * demonstration through the repository's own eslint.config.mjs, and the guards that the rule
 * has no exemption surface (#3148's shape): no allowlist file, no rule option, and every file
 * under tests/ lints to zero sites with inline config off, so an `eslint-disable` comment
 * naming the rule cannot hide a site.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { RuleTester, ESLint } = require('eslint');

const rule = require('../eslint-rules/no-adhoc-env-isolation.cjs');

const REPO_ROOT = path.join(__dirname, '..');
const ALLOWLIST_PATH = path.join(REPO_ROOT, 'eslint-rules', 'no-adhoc-env-isolation.allowlist.json');
const RULE_ID = 'local/no-adhoc-env-isolation';
const EXEMPT_FILE = 'tests/helpers/isolated-env.cjs';

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'commonjs',
  },
});

const FILE = 'tests/some-new.test.cjs';

function run(valid, invalid) {
  ruleTester.run('no-adhoc-env-isolation', rule, { valid, invalid });
}

// ─── Arm 1: inline PATH split / filter ───────────────────────────────────────

describe('no-adhoc-env-isolation: arm 1 fires on a PATH split or filter', () => {
  const pathFilter = { messageId: 'inlinePathFilter' };

  test('red demonstration: a reintroduced inline PATH filter (the #4348 shape)', () => {
    run([], [
      {
        code: [
          'function buildPath(basePath = process.env.PATH) {',
          '  return (basePath ?? "")',
          '    .split(path.delimiter)',
          '    .filter((p) => path.isAbsolute(p) && !hasTool(p));',
          '}',
        ].join('\n'),
        filename: FILE,
        errors: [pathFilter],
      },
    ]);
  });

  test('red demonstration: a split-and-rejoin of the full system PATH (the #4411 shape)', () => {
    run([], [
      {
        code: [
          'function makePath(extraBefore) {',
          '  const systemPaths = (process.env.PATH || "/usr/bin:/bin").split(path.delimiter);',
          '  return [...extraBefore, ...systemPaths].join(path.delimiter);',
          '}',
        ].join('\n'),
        filename: FILE,
        errors: [pathFilter],
      },
    ]);
  });

  test('six spellings of a direct process.env PATH read are a split of PATH', () => {
    run([], [
      { code: 'process.env.PATH.split(path.delimiter);', filename: FILE, errors: [pathFilter] },
      { code: "process.env['PATH'].split(':');", filename: FILE, errors: [pathFilter] },
      { code: "String(process.env.PATH || process.env.Path || '').split(';');", filename: FILE, errors: [pathFilter] },
      { code: "(cond ? process.env.Path : '').split(x);", filename: FILE, errors: [pathFilter] },
      { code: 'process.env.PATH?.split(path.delimiter);', filename: FILE, errors: [pathFilter] },
      { code: 'const p = process.env.PATH; p.split(path.delimiter);', filename: FILE, errors: [pathFilter] },
    ]);
  });

  test('a delimiter split consumed by .filter fires whatever its receiver', () => {
    run([], [
      { code: 'dirs.split(delimiter).filter(Boolean);', filename: FILE, errors: [pathFilter] },
      { code: 'opts.env.PATH.split(path.posix.delimiter).filter((d) => d !== bin);', filename: FILE, errors: [pathFilter] },
      { code: "(process.env.PATH || '').split(':').filter(keep);", filename: FILE, errors: [pathFilter] },
    ]);
  });
});

describe('no-adhoc-env-isolation: arm 1 leaves alone what builds no env', () => {
  test('valid: splits of a PATH some other object carries, unfiltered', () => {
    run([
      { code: 'assert.ok(!result.path.split(path.delimiter).includes(dir));', filename: FILE },
      { code: 'assert.deepEqual(env.PATH.split(path.delimiter), [bin]);', filename: FILE },
      { code: 'const dirs = isolatedBinPath.split(path.delimiter);', filename: FILE },
      { code: "line.split(':').filter(Boolean);", filename: FILE },
      { code: 'process.env.NODE_PATH.split(path.delimiter);', filename: FILE },
      // Only one const hop is followed, and never a `let`.
      { code: 'const a = process.env.PATH; const b = a; b.split(path.delimiter);', filename: FILE },
      { code: "let p = process.env.PATH; p = 'x'; p.split(':');", filename: FILE },
    ], []);
  });
});

// ─── Arm 2: hand-built HOME / USERPROFILE ────────────────────────────────────

describe('no-adhoc-env-isolation: arm 2 fires on a hand-built HOME env', () => {
  const home = { messageId: 'adhocHomeConstruction' };

  test('red demonstration: a direct { HOME: … } construction', () => {
    run([], [
      {
        code: 'spawnSync(cmd, args, { env: { ...process.env, HOME: tmp } });',
        filename: FILE,
        errors: [{ messageId: 'adhocHomeConstruction', data: { key: 'HOME' } }],
      },
    ]);
  });

  test('every key spelling, reported once per object literal', () => {
    run([], [
      { code: "runGsdTools(args, cwd, { HOME: tmp, USERPROFILE: tmp });", filename: FILE, errors: [home] },
      { code: "const e = { 'USERPROFILE': dir };", filename: FILE, errors: [{ messageId: 'adhocHomeConstruction', data: { key: 'USERPROFILE' } }] },
      { code: "const e = { ['HOME']: dir };", filename: FILE, errors: [home] },
      { code: 'const e = { [`HOME`]: dir };', filename: FILE, errors: [home] },
      { code: 'const e = { HOME: undefined };', filename: FILE, errors: [home] },
    ]);
  });

  test('an assignment that builds a child env by hand', () => {
    run([], [
      { code: 'childEnv.HOME = tmp;', filename: FILE, errors: [home] },
      { code: "env['USERPROFILE'] = tmp;", filename: FILE, errors: [home] },
      { code: 'opts.env.HOME = tmp;', filename: FILE, errors: [home] },
    ]);
  });
});

describe('no-adhoc-env-isolation: arm 2 leaves alone what it does not own', () => {
  test('valid: in-process mutation, reads, destructuring, other names', () => {
    run([
      // In-process isolation is sandboxHome(), not the child-env helper.
      { code: 'process.env.HOME = tmp;', filename: FILE },
      { code: "process.env['USERPROFILE'] = tmp;", filename: FILE },
      { code: 'const saved = process.env.HOME;', filename: FILE },
      { code: 'const { HOME } = process.env;', filename: FILE },
      { code: 'const { HOME: h, USERPROFILE: u } = env;', filename: FILE },
      { code: 'const e = isolatedEnv({ home: tmp });', filename: FILE },
      { code: 'obj.home = tmp;', filename: FILE },
      { code: 'const e = { [key]: tmp };', filename: FILE },
    ], []);
  });
});

// ─── the documented boundary ─────────────────────────────────────────────────
// The rule's reference page (its header links it) lists the forms each arm
// recognises and examples of what is out of scope. Each has a row here, so a refactor of isProcessEnv,
// readsEnvPath or the key match that moves the boundary fails a row instead of
// changing documented behaviour silently.

describe('no-adhoc-env-isolation: every documented recognised form is flagged', () => {
  const home = { messageId: 'adhocHomeConstruction' };
  const pathFilter = { messageId: 'inlinePathFilter' };

  test('in-process mutation spelled other than process.env.HOME = x is flagged', () => {
    run([], [
      { code: 'globalThis.process.env.HOME = x;', filename: FILE, errors: [home] },
      { code: 'const env = process.env; env.HOME = x;', filename: FILE, errors: [home] },
      { code: 'Object.assign(process.env, { HOME: x });', filename: FILE, errors: [home] },
    ]);
  });

  test('an env built from a destructured HOME local is flagged', () => {
    run([], [
      { code: 'const { HOME = y } = o; const env = { ...process.env, HOME };', filename: FILE, errors: [home] },
    ]);
  });

  test('a PATH read through either arm of ?:, &&, an optional chain or process[\'env\'] is followed', () => {
    run([], [
      { code: "(cond ? '' : process.env.PATH).split(':');", filename: FILE, errors: [pathFilter] },
      { code: "(process.env.PATH && extra).split(':');", filename: FILE, errors: [pathFilter] },
      { code: "(process.env?.PATH).split(':');", filename: FILE, errors: [pathFilter] },
      { code: "process['env'].PATH.split(':');", filename: FILE, errors: [pathFilter] },
    ]);
  });

  test('process[\'env\'] is the process env, so assigning HOME on it is in-process and not flagged', () => {
    run([
      { code: "process['env'].HOME = x;", filename: FILE },
      // String(...) is followed only with exactly one argument.
      { code: "String(process.env.PATH, extra).split(':');", filename: FILE },
    ], []);
  });

  test('a split of a direct process.env.PATH read is flagged unless only its length is read, and any *.delimiter counts', () => {
    run([], [
      { code: 'const dirs = process.env.PATH.split(path.delimiter);', filename: FILE, errors: [pathFilter] },
      { code: 'const n = process.env.PATH.split(path.delimiter).map(norm).length;', filename: FILE, errors: [pathFilter] },
      { code: 'csv.split(csv.delimiter).filter(Boolean);', filename: FILE, errors: [pathFilter] },
    ]);
  });

  test('an object with a HOME key is flagged unless its value cannot be a sandbox', () => {
    run([], [
      { code: 'const fixture = { HOME: someone };', filename: FILE, errors: [home] },
      { code: 'const fixture = { HOME: `/home/${name}` };', filename: FILE, errors: [home] },
      { code: 'const fixture = { HOME: process.env.USERPROFILE };', filename: FILE, errors: [home] },
      { code: 'const fixture = { USERPROFILE: process.env.HOME };', filename: FILE, errors: [home] },
      { code: 'const fixture = { HOME: "/h", USERPROFILE: dir };', filename: FILE, errors: [{ messageId: 'adhocHomeConstruction', data: { key: 'USERPROFILE' } }] },
    ]);
  });

  test('an assignment to HOME is flagged unless its value cannot be a sandbox', () => {
    run([], [
      { code: 'env.HOME = process.env.USERPROFILE;', filename: FILE, errors: [home] },
      { code: 'env.HOME = `/home/${name}`;', filename: FILE, errors: [home] },
    ]);
  });

  test('each spelling of a process PATH read, a delimiter and a HOME key the page names is flagged', () => {
    run([], [
      { code: "(process.env.PATH || '').split(':');", filename: FILE, errors: [pathFilter] },
      { code: "(x || process.env.PATH).split(':');", filename: FILE, errors: [pathFilter] },
      { code: "(process.env.PATH ?? '').split(':');", filename: FILE, errors: [pathFilter] },
      { code: "(x ?? process.env.PATH).split(':');", filename: FILE, errors: [pathFilter] },
      { code: "(x && process.env.PATH).split(':');", filename: FILE, errors: [pathFilter] },
      { code: "(c ? process.env.PATH : '').split(':');", filename: FILE, errors: [pathFilter] },
      { code: "process.env?.PATH.split(':');", filename: FILE, errors: [pathFilter] },
      { code: "process?.env.PATH.split(':');", filename: FILE, errors: [pathFilter] },
      { code: "process['env']['PATH'].split(':');", filename: FILE, errors: [pathFilter] },
      { code: "process.env.Path.split(':');", filename: FILE, errors: [pathFilter] },
      { code: "String(process.env.PATH).split(':');", filename: FILE, errors: [pathFilter] },
      { code: "const p = process.env.PATH; p.split(':');", filename: FILE, errors: [pathFilter] },
      { code: 'x.split(delimiter).filter(f);', filename: FILE, errors: [pathFilter] },
      { code: 'x.split(path.win32.delimiter).filter(f);', filename: FILE, errors: [pathFilter] },
      { code: 'const e = { HOME };', filename: FILE, errors: [home] },
      { code: "env['USERPROFILE'] ||= x;", filename: FILE, errors: [home] },
      { code: "process.env.PATH['split'](':');", filename: FILE, errors: [pathFilter] },
      { code: "x['split'](path['delimiter'])['filter'](f);", filename: FILE, errors: [pathFilter] },
    ]);
  });

  test('an expression-free template key is read as a string key, and a destructured const alias is followed', () => {
    run([], [
      { code: 'process[`env`].PATH.split(":");', filename: FILE, errors: [pathFilter] },
      { code: 'x[`split`](path.delimiter)[`filter`](f);', filename: FILE, errors: [pathFilter] },
      { code: 'env[`HOME`] = x;', filename: FILE, errors: [home] },
      { code: 'const [p] = process.env.PATH; p.split(":");', filename: FILE, errors: [pathFilter] },
      { code: 'const { a: p } = process.env.PATH; p.split(":");', filename: FILE, errors: [pathFilter] },
    ]);
  });

  test('process[`env`].HOME and process.env[\'HOME\'] are in-process assignments and are not flagged', () => {
    run([
      { code: 'process[`env`].HOME = x;', filename: FILE },
      { code: "process.env['HOME'] = x;", filename: FILE },
    ], []);
  });

  test('a flagged assignment in the X[\'HOME\'] spelling', () => {
    run([], [{ code: "env['HOME'] = x;", filename: FILE, errors: [home] }]);
  });

  test('a delimiter split is flagged with a second argument, and through ?.filter or .filter?.()', () => {
    run([], [
      { code: 'x.split(path.delimiter, 3).filter(f);', filename: FILE, errors: [pathFilter] },
      { code: 'x.split(path.delimiter)?.filter(f);', filename: FILE, errors: [pathFilter] },
      { code: 'x.split(path.delimiter).filter?.(f);', filename: FILE, errors: [pathFilter] },
      { code: 'x?.split(path.delimiter).filter(f);', filename: FILE, errors: [pathFilter] },
    ]);
  });

  test('over a process PATH read every split is flagged, whatever follows it and whatever its delimiter', () => {
    run([], [
      { code: "process.env.PATH.split(':').filter(keep);", filename: FILE, errors: [pathFilter] },
      { code: 'process.env.PATH.split(path.delimiter).map(norm);', filename: FILE, errors: [pathFilter] },
      { code: 'process.env.PATH.split(/[;:]/);', filename: FILE, errors: [pathFilter] },
    ]);
  });

  test('a compound or logical assignment to HOME or USERPROFILE is flagged', () => {
    run([], [
      { code: 'env.HOME += x;', filename: FILE, errors: [home] },
      { code: 'env.HOME ||= x;', filename: FILE, errors: [home] },
      { code: 'env.USERPROFILE ??= x;', filename: FILE, errors: [home] },
    ]);
  });
});

describe('no-adhoc-env-isolation: the documented out-of-scope examples are not flagged', () => {
  test('a PATH read the alias hop does not follow, unfiltered', () => {
    run([
      { code: "const { PATH } = process.env; PATH.split(':');", filename: FILE },
      { code: "const env = process.env; env.PATH.split(':');", filename: FILE },
      { code: "globalThis.process.env.PATH.split(':');", filename: FILE },
      { code: "`${process.env.PATH}`.split(':');", filename: FILE },
      { code: "const { env } = process; env.PATH.split(':');", filename: FILE },
      { code: "require('node:process').env.PATH.split(':');", filename: FILE },
      { code: "require('process').env.PATH.split(':');", filename: FILE },
      { code: "getPath().split(':');", filename: FILE },
      { code: "(process?.env).PATH.split(':');", filename: FILE },
      { code: "process.env['PA' + 'TH'].split(':');", filename: FILE },
      { code: "const p = process.env.PATH; const q = p; q.split(':');", filename: FILE },
      { code: "const env = process.env; env.PATH.split(':').filter(Boolean);", filename: FILE },
      { code: "let p = process.env.PATH; p.split(':');", filename: FILE },
      { code: "var p = process.env.PATH; p.split(':');", filename: FILE },
    ], []);
  });

  test('a PATH taken apart without a direct .split call on it', () => {
    run([
      { code: 'String.prototype.split.call(process.env.PATH, path.delimiter).filter(Boolean);', filename: FILE },
      { code: "Reflect.apply(String.prototype.split, process.env.PATH, [':']);", filename: FILE },
      { code: 'process.env.PATH.split.call(process.env.PATH, path.delimiter);', filename: FILE },
      { code: 'process.env.PATH.match(/[^:]+/g).filter(Boolean);', filename: FILE },
      { code: '[...process.env.PATH.matchAll(/[^:]+/g)].map((m) => m[0]).filter(keep);', filename: FILE },
    ], []);
  });

  test('a PATH filter written as a loop, or over a split held in a variable', () => {
    run([
      { code: 'for (const d of dirs.split(path.delimiter)) { if (keep(d)) out.push(d); }', filename: FILE },
      { code: 'const parts = basePath.split(path.delimiter); parts.filter(keep);', filename: FILE },
    ], []);
  });

  test('a filtered split by a literal or variable delimiter, receiver not a process.env.PATH read', () => {
    run([
      { code: "basePath.split(':').filter(keep);", filename: FILE },
      { code: "const SEP = isWin ? ';' : ':'; parts.split(SEP).filter(keep);", filename: FILE },
    ], []);
  });

  test('a PATH set or assembled without a split', () => {
    run([
      { code: 'const e = { ...process.env, PATH: dir };', filename: FILE },
      { code: 'env.PATH = dir;', filename: FILE },
      { code: 'env.PATH = bin + path.delimiter + process.env.PATH;', filename: FILE },
      { code: 'env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;', filename: FILE },
      { code: 'env.PATH = [bin, process.env.PATH].join(path.delimiter);', filename: FILE },
    ], []);
  });

  test('a split filtered through a spread, a .map, or a regular-expression delimiter', () => {
    run([
      { code: '[...basePath.split(path.delimiter)].filter(keep);', filename: FILE },
      { code: 'basePath.split(path.delimiter).map(norm).filter(Boolean);', filename: FILE },
      { code: 'basePath.split(/[;:]/).filter(keep);', filename: FILE },
      { code: 'basePath.split(path.delimiter).slice(1).filter(Boolean);', filename: FILE },
      { code: 'Array.from(basePath.split(path.delimiter)).filter(keep);', filename: FILE },
      { code: 'basePath.split(path.delimiter).reduce(f, []);', filename: FILE },
      { code: '(basePath?.split(path.delimiter)).filter(Boolean);', filename: FILE },
      { code: 'basePath.split(path?.delimiter).filter(Boolean);', filename: FILE },
    ], []);
  });

  test('HOME set as a destructuring or for-of / for-in target, by an update, or by a class field', () => {
    run([
      { code: 'const env = { ...process.env }; [env.HOME, env.USERPROFILE] = [tmp, tmp];', filename: FILE },
      { code: 'const env = { ...process.env }; ({ home: env.HOME } = o);', filename: FILE },
      { code: 'const env = { ...process.env }; for (env.HOME of [tmp]) {}', filename: FILE },
      { code: 'const env = { ...process.env }; for (env.USERPROFILE in o) {}', filename: FILE },
      { code: 'env.HOME++;', filename: FILE },
      { code: 'class E { HOME = tmp; } const env = { ...process.env, ...new E() };', filename: FILE },
    ], []);
  });

  test('an object pattern with a HOME or USERPROFILE key, with or without a default', () => {
    run([
      { code: 'let HOME; ({ HOME } = o);', filename: FILE },
      { code: 'const { HOME = y } = o;', filename: FILE },
      { code: 'const f = ({ USERPROFILE }) => USERPROFILE;', filename: FILE },
    ], []);
  });

  test("other home and config variables, Windows' HOMEDRIVE / HOMEPATH, and a lowercase process.env.path read", () => {
    run([
      { code: 'const e = { ...process.env, GSD_HOME: x, XDG_CONFIG_HOME: x, CLAUDE_CONFIG_DIR: x };', filename: FILE },
      { code: "const env = { ...process.env, HOMEDRIVE: 'C:', HOMEPATH: tmp };", filename: FILE },
      { code: "process.env.path.split(':');", filename: FILE },
    ], []);
  });

  test('a HOME or USERPROFILE value that cannot be a sandbox: a fixed string, or the ambient value of the same key', () => {
    run([
      { code: "const fixture = { HOME: '/home/someone' };", filename: FILE },
      { code: "const fixture = { USERPROFILE: 'C:/Users/someone' };", filename: FILE },
      { code: 'const fixture = { HOME: `/home/someone` };', filename: FILE },
      { code: 'const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };', filename: FILE },
      { code: "const saved = { HOME: process.env['HOME'] };", filename: FILE },
      { code: 'saved.HOME = process.env.HOME;', filename: FILE },
      { code: "saved.USERPROFILE = '/h';", filename: FILE },
      { code: "env.HOME ||= '/h';", filename: FILE },
    ], []);
  });

  test('a split of a process PATH read whose result is read only for .length', () => {
    run([
      { code: 'const n = process.env.PATH.split(path.delimiter).length;', filename: FILE },
      { code: "const n = String(process.env.PATH || process.env.Path || '').split(path.delimiter).length;", filename: FILE },
      { code: 'const n = process.env.PATH?.split(path.delimiter).length;', filename: FILE },
      { code: 'const n = process.env.PATH.split(path.delimiter).length + 1;', filename: FILE },
    ], []);
  });

  test('removing HOME or USERPROFILE from a spread env', () => {
    run([
      { code: 'const env = { ...process.env }; delete env.HOME;', filename: FILE },
      { code: 'const env = { ...process.env }; delete env.USERPROFILE;', filename: FILE },
      { code: "const env = { ...process.env }; Reflect.deleteProperty(env, 'HOME');", filename: FILE },
    ], []);
  });

  test('HOME built without a static key', () => {
    run([
      { code: 'env[key] = x;', filename: FILE },
      { code: 'const e = { [k]: x };', filename: FILE },
      { code: "const e = { ['HO' + 'ME']: x };", filename: FILE },
      { code: "const e = Object.fromEntries([['HOME', x]]);", filename: FILE },
      { code: "Object.defineProperty(env, 'HOME', { value: x });", filename: FILE },
      { code: "Reflect.defineProperty(env, 'HOME', { value: x });", filename: FILE },
      { code: 'Object.assign(env, JSON.parse(\'{"HOME":"/tmp/x"}\'));', filename: FILE },
      { code: "const e = Object.fromEntries(Object.entries(process.env).map(([k, v]) => [k, k === 'HOME' ? tmp : v]));", filename: FILE },
      { code: "Reflect.set(env, 'HOME', x);", filename: FILE },
      { code: "const entries = ['HOME=' + x];", filename: FILE },
      { code: 'execSync(`export HOME=${x}; run`);', filename: FILE },
    ], []);
  });

  test('a spread of the process env with no HOME key, and keys that differ in case', () => {
    run([
      { code: 'const e = { ...process.env };', filename: FILE },
      { code: 'const e = { ...process.env, Home: x };', filename: FILE },
      { code: 'const e = { ...process.env, userprofile: x };', filename: FILE },
    ], []);
  });
});

// ─── red demonstration through the repository's own config ──────────────────

describe('no-adhoc-env-isolation: wired into eslint.config.mjs', () => {
  const COPIES = [
    "'use strict';",
    "const path = require('node:path');",
    "const dirs = (process.env.PATH ?? '').split(path.delimiter).filter((d) => d !== 'x');",
    'module.exports = { env: { ...process.env, HOME: dirs[0], USERPROFILE: dirs[0] } };',
    '',
  ].join('\n');
  const CLEAN = "'use strict';\nmodule.exports = {};\n";

  let eslint;
  async function ruleMessages(text, rel) {
    eslint ??= new ESLint({ cwd: REPO_ROOT });
    const [result] = await eslint.lintText(text, { filePath: path.join(REPO_ROOT, rel) });
    return result.messages.filter((m) => m.ruleId === RULE_ID).map((m) => m.messageId);
  }

  test('red demonstration: both copies fail lint in any new test file', async () => {
    const ids = await ruleMessages(COPIES, 'tests/adhoc-env-isolation-reintroduced.test.cjs');
    assert.deepStrictEqual(ids.sort(), ['adhocHomeConstruction', 'inlinePathFilter']);
  });

  test('the same copies are exempt only in the isolation helper itself', async () => {
    assert.deepStrictEqual(await ruleMessages(COPIES, EXEMPT_FILE), []);
    assert.deepStrictEqual(await ruleMessages(COPIES, 'tests/helpers/other-helper.cjs'), [
      'inlinePathFilter',
      'adhocHomeConstruction',
    ]);
  });

  test('the rule takes no options: an allowlist cannot be wired back in through config', async () => {
    const filePath = path.join(REPO_ROOT, 'tests/adhoc-env-isolation-option-6040.test.cjs');
    const withRule = (options) => new ESLint({
      cwd: REPO_ROOT,
      overrideConfig: { files: ['tests/**/*.cjs'], rules: { [RULE_ID]: ['error', ...options] } },
    });
    // Control: the same config without the option lints, so the rejection below is the option's.
    await withRule([]).lintText(CLEAN, { filePath });
    await assert.rejects(() => withRule([{ allowlist: ['tests/legacy.test.cjs'] }]).lintText(CLEAN, { filePath }));
  });

  test('eslint.config.mjs wires the rule at error severity with no options', async () => {
    eslint ??= new ESLint({ cwd: REPO_ROOT });
    const config = await eslint.calculateConfigForFile(path.join(REPO_ROOT, 'tests/adhoc-env-isolation-config-6040.test.cjs'));
    assert.deepStrictEqual(config.rules[RULE_ID], [2]);
    // An unused `eslint-disable` for this rule is an error, so a rule-specific disable has no form
    // that passes: a used one is counted below with inline config off, an unused one fails lint.
    assert.strictEqual(config.linterOptions.reportUnusedDisableDirectives, 2);
  });
});

// ─── no exemption surface, and zero sites under tests/ ───────────────────────

describe('no-adhoc-env-isolation: no allowlist', () => {
  test('the allowlist file does not exist', () => {
    assert.strictEqual(fs.existsSync(ALLOWLIST_PATH), false, `${ALLOWLIST_PATH} exists: the rule has no allowlist`);
  });
});

function toRel(file) {
  return path.relative(REPO_ROOT, file).split(path.sep).join('/');
}

/**
 * The ESLint that counts sites: the rule runs with no options and with inline config off, so an
 * `eslint-disable` comment cannot hide a site from the count. The exempt helper stays out, as it
 * does in eslint.config.mjs. `extraConfig` adds config objects after the repository's (a row's
 * synthetic global ignore); such a row also turns off the unmatched-pattern error.
 */
function siteCountEslint(extraConfig = []) {
  return new ESLint({
    cwd: REPO_ROOT,
    allowInlineConfig: false,
    errorOnUnmatchedPattern: extraConfig.length === 0,
    overrideConfig: [
      {
        files: ['tests/**/*.cjs'],
        ignores: [EXEMPT_FILE],
        rules: { [RULE_ID]: 'error' },
      },
      ...extraConfig,
    ],
    ruleFilter: ({ ruleId }) => ruleId === RULE_ID,
  });
}

/** Every `.cjs` file on disk under `root` (repository-relative), sorted. */
function cjsFilesOnDisk(root) {
  const files = [];
  (function walk(rel) {
    for (const entry of fs.readdirSync(path.join(REPO_ROOT, rel), { withFileTypes: true })) {
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile() && entry.name.endsWith('.cjs')) files.push(child);
    }
  })(root);
  return files.sort();
}

/**
 * The files on disk that the lint run did not visit. ESLint lints only what no
 * ignore covers, so a global `ignores` entry over a tests/ subtree drops its
 * copies from the rule and from the count together; this is how the count
 * sees that. A file deleted between the walk and the lint is not reported.
 */
function findUnvisited(onDisk, results) {
  const visited = new Set(results.map((r) => toRel(r.filePath)));
  return onDisk.filter((f) => !visited.has(f) && fs.existsSync(path.join(REPO_ROOT, f)));
}

/** Per-file site counts from lint results, plus the files ESLint could not parse. */
function countSites(results) {
  const unparsed = results.filter((r) => r.fatalErrorCount > 0).map((r) => toRel(r.filePath));
  const counts = {};
  for (const r of results) {
    const n = r.messages.filter((m) => m.ruleId === RULE_ID).length;
    if (n > 0) counts[toRel(r.filePath)] = n;
  }
  return { counts, unparsed };
}

const LINT_TREE_ATTEMPTS = 3;

/**
 * `eslint.lintFiles(patterns)`, retried when a file the glob listed is gone before ESLint reads it (#6570).
 * Another test file writes and removes probe files in the real tests/ tree
 * (tests/no-unbounded-spawn-allowlist.test.cjs, #3148), and ESLint expands the glob and then reads each file, so
 * a removal in between rejects the whole run with ENOENT. A file that is gone is not a test file: the retry lints
 * the tree as it now is. Any other error, and an ENOENT that outlasts the attempts, still fails.
 */
async function lintTree(eslint, patterns) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await eslint.lintFiles(patterns);
    } catch (err) {
      if (err?.code !== 'ENOENT' || attempt >= LINT_TREE_ATTEMPTS) throw err;
    }
  }
}

/** The site count of every file under tests/. */
async function measureSiteCounts() {
  const onDisk = cjsFilesOnDisk('tests');
  const results = await lintTree(siteCountEslint(), ['tests/**/*.cjs']);
  return { ...countSites(results), unvisited: findUnvisited(onDisk, results) };
}

describe('no-adhoc-env-isolation: zero sites under tests/', () => {
  test('an eslint-disable comment for the rule does not hide a copy from the count', async () => {
    const rel = 'tests/adhoc-env-isolation-disabled-6035.test.cjs';
    const text = [
      '/* eslint-disable local/no-adhoc-env-isolation */',
      "'use strict';",
      "const dirs = (process.env.PATH ?? '').split(':');",
      'module.exports = { env: { ...process.env, HOME: dirs[0] } };',
      '',
    ].join('\n');
    const filePath = path.join(REPO_ROOT, rel);
    // Control: through the repository's config the comment does suppress the rule.
    const [linted] = await new ESLint({ cwd: REPO_ROOT }).lintText(text, { filePath });
    assert.deepStrictEqual(linted.messages.filter((m) => m.ruleId === RULE_ID), []);
    const { counts } = countSites(await siteCountEslint().lintText(text, { filePath }));
    assert.deepStrictEqual(counts, { [rel]: 2 });
  });

  // #6570: tests/no-unbounded-spawn-allowlist.test.cjs writes tests/helpers/__probe_recursion_detect_3148.cjs into
  // the real tree and removes it. ESLint expands the glob and then reads each file, so a probe removed in between
  // makes lintFiles reject with ENOENT. The stand-ins below fail the way ESLint does.
  const vanishedFile = () => Object.assign(new Error("ENOENT: no such file or directory, open '/work/tests/helpers/probe.cjs'"), { code: 'ENOENT' });

  test('a file removed while the tree is linted is retried over the tree as it now is, not a failure (#6570)', async () => {
    let calls = 0;
    const eslint = { lintFiles: async () => { calls++; if (calls === 1) throw vanishedFile(); return ['linted']; } };
    assert.deepStrictEqual(await lintTree(eslint, ['tests/**/*.cjs']), ['linted']);
    assert.strictEqual(calls, 2);
  });

  test('a file that keeps vanishing fails after a bounded number of attempts (#6570)', async () => {
    let calls = 0;
    const eslint = { lintFiles: async () => { calls++; throw vanishedFile(); } };
    await assert.rejects(() => lintTree(eslint, ['tests/**/*.cjs']), { code: 'ENOENT' });
    assert.strictEqual(calls, 3);
  });

  test('an error other than ENOENT is not retried (#6570)', async () => {
    let calls = 0;
    const eslint = { lintFiles: async () => { calls++; throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }); } };
    await assert.rejects(() => lintTree(eslint, ['tests/**/*.cjs']), { code: 'EACCES' });
    assert.strictEqual(calls, 1);
  });

  test('a global ignore over a tests/ subtree shows its files as unvisited', async () => {
    const onDisk = cjsFilesOnDisk('tests/helpers');
    assert.ok(onDisk.length > 0, 'the row needs .cjs files under tests/helpers');
    const pattern = ['tests/helpers/**/*.cjs'];
    // Control: with no extra ignore, every file under the subtree is visited.
    assert.deepStrictEqual(findUnvisited(onDisk, await lintTree(siteCountEslint(), pattern)), []);
    const ignored = await lintTree(siteCountEslint([{ ignores: ['tests/helpers/**'] }]), pattern);
    // findUnvisited skips a file that no longer exists, so a probe removed since the walk (#6570) is not in its
    // answer. Every file the walk saw that is STILL on disk must be unvisited: the ignore hid all of them.
    const unvisited = findUnvisited(onDisk, ignored);
    const visitedDespiteIgnore = onDisk.filter((f) => !unvisited.includes(f) && fs.existsSync(path.join(REPO_ROOT, f)));
    assert.deepStrictEqual(visitedDespiteIgnore, []);
    assert.ok(unvisited.length > 0, 'the ignore must leave files unvisited, or the row proves nothing');
  });

  test('no file under tests/ carries a hand-written env-isolation copy, hidden or not', async () => {
    const { counts, unparsed, unvisited } = await measureSiteCounts();
    assert.deepStrictEqual(unparsed, [], 'a file ESLint cannot parse has no measured count');
    assert.deepStrictEqual(
      unvisited,
      [],
      'The count reads the files ESLint lints, and these .cjs files under tests/ were not linted, so their copies ' +
        'would go uncounted. Find the ignore that covers them (an ignores entry in eslint.config.mjs, or an ESLint ' +
        'default such as **/node_modules/) and lift it for these files.',
    );
    assert.deepStrictEqual(
      counts,
      {},
      'There is no allowlist: tests/helpers/isolated-env.cjs is the only route. Build the env with isolatedEnv() or ' +
        'homePair(), or the PATH with isolatedPath(). An eslint-disable naming the rule does not exempt a file: inline ' +
        'config is off for this count.',
    );
  });
});
