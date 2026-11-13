'use strict';

/**
 * no-adhoc-env-isolation.rule.test.cjs
 *
 * #6035 (epic #4635 Phase 3): tests for the local/no-adhoc-env-isolation
 * ESLint rule and its allowlist.
 *
 * - Arm 1: an inline PATH split or filter.
 * - Arm 2: a hand-built HOME / USERPROFILE env.
 * - The allowlist ratchet (a listed file with no copy left reports itself stale).
 * - A red demonstration through the repository's own eslint.config.mjs: a
 *   reintroduced copy in a file the allowlist does not name fails `npm run lint`.
 * - Structural guards on eslint-rules/no-adhoc-env-isolation.allowlist.json, each
 *   driven against a synthetic violation so the guard itself is shown able to fail.
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

// The allowlist only ratchets DOWN: this is its length when the rule landed
// (119 files after Phase 2). Each drain wave lowers it; it must never grow.
const BASELINE = 119;

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

// ─── module shape ─────────────────────────────────────────────────────────────

describe('no-adhoc-env-isolation rule module', () => {
  test('exports meta and create with the three messages', () => {
    assert.strictEqual(typeof rule.meta, 'object');
    assert.strictEqual(typeof rule.create, 'function');
    assert.strictEqual(rule.meta.type, 'problem');
    for (const id of ['inlinePathFilter', 'adhocHomeConstruction', 'staleAllowlistEntry']) {
      assert.ok(rule.meta.messages[id], `${id} message must exist`);
    }
  });
});

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

  test('every spelling of a direct process.env PATH read is a split of PATH', () => {
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

// ─── allowlist ratchet ───────────────────────────────────────────────────────

describe('no-adhoc-env-isolation: allowlist', () => {
  const allowlisted = 'tests/legacy.test.cjs';

  test('valid: an allowlisted file with copies reports nothing', () => {
    run([
      {
        code: 'spawnSync(cmd, [], { env: { ...process.env, HOME: tmp } }); process.env.PATH.split(":");',
        filename: allowlisted,
        options: [{ allowlist: [allowlisted] }],
      },
    ], []);
  });

  test('invalid: an allowlisted file with no copy left reports its own entry stale', () => {
    run([], [
      {
        code: 'const e = isolatedEnv({ home: tmp });',
        filename: allowlisted,
        options: [{ allowlist: [allowlisted] }],
        errors: [{ messageId: 'staleAllowlistEntry', data: { file: allowlisted } }],
      },
    ]);
  });

  test('invalid: a site in a file the allowlist does not name is reported', () => {
    run([], [
      {
        code: 'const e = { HOME: tmp };',
        filename: 'tests/not-listed.test.cjs',
        options: [{ allowlist: [allowlisted] }],
        errors: [{ messageId: 'adhocHomeConstruction' }],
      },
    ]);
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

  test('red demonstration: both copies fail lint in a file the allowlist does not name', async () => {
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

  test('a listed file is silent while it carries a copy and reports stale once it does not', async () => {
    const listed = JSON.parse(fs.readFileSync(ALLOWLIST_PATH, 'utf8'))[0];
    assert.deepStrictEqual(await ruleMessages(COPIES, listed), []);
    assert.deepStrictEqual(await ruleMessages(CLEAN, listed), ['staleAllowlistEntry']);
  });
});

// ─── allowlist structure ─────────────────────────────────────────────────────

function readAllowlist() {
  return JSON.parse(fs.readFileSync(ALLOWLIST_PATH, 'utf8'));
}

function findDeadEntries(list, root) {
  return list.filter((entry) => !fs.existsSync(path.join(root, entry)));
}

function findMisplacedEntries(list) {
  return list.filter((entry) => entry.includes('\\') || !entry.startsWith('tests/') || !entry.endsWith('.cjs'));
}

function isSorted(list) {
  return JSON.stringify(list) === JSON.stringify([...list].sort());
}

function findDuplicates(list) {
  const seen = new Set();
  const dupes = [];
  for (const entry of list) {
    if (seen.has(entry)) dupes.push(entry);
    seen.add(entry);
  }
  return dupes;
}

describe('no-adhoc-env-isolation allowlist: structure', () => {
  test('is a sorted, duplicate-free array of tests/**/*.cjs paths with / separators', () => {
    const list = readAllowlist();
    assert.ok(Array.isArray(list), 'the allowlist must parse to an array');
    assert.ok(isSorted(list), 'entries must be sorted: the drain waves take them in order');
    assert.deepStrictEqual(findDuplicates(list), []);
    assert.deepStrictEqual(findMisplacedEntries(list), []);
  });

  test('every entry names a file that exists', () => {
    assert.deepStrictEqual(findDeadEntries(readAllowlist(), REPO_ROOT), []);
  });

  test('never lists the exempt helper, and never grows past its baseline', () => {
    const list = readAllowlist();
    assert.ok(!list.includes(EXEMPT_FILE), `${EXEMPT_FILE} is exempt in eslint.config.mjs, not allowlisted`);
    assert.ok(
      list.length <= BASELINE,
      `the allowlist grew to ${list.length} entries, past its baseline of ${BASELINE}. ` +
        'It only ratchets down: migrate the new copy onto tests/helpers/isolated-env.cjs instead.',
    );
  });

  test('each structural check flags a synthetic violation', () => {
    assert.strictEqual(isSorted(['tests/b.test.cjs', 'tests/a.test.cjs']), false);
    assert.deepStrictEqual(findDuplicates(['tests/a.cjs', 'tests/b.cjs', 'tests/a.cjs']), ['tests/a.cjs']);
    assert.deepStrictEqual(
      findMisplacedEntries(['tests\\a.test.cjs', 'src/a.cts', 'tests/a.md', 'tests/ok.test.cjs']),
      ['tests\\a.test.cjs', 'src/a.cts', 'tests/a.md'],
    );
    assert.deepStrictEqual(
      findDeadEntries(['tests/does-not-exist-6035.test.cjs', 'tests/no-adhoc-env-isolation.rule.test.cjs'], REPO_ROOT),
      ['tests/does-not-exist-6035.test.cjs'],
    );
  });
});
