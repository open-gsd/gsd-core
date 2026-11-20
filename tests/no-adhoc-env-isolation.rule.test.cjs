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
 * - The per-file site counts: every file under tests/ is linted with the
 *   allowlist emptied, and its count must equal the one
 *   eslint-rules/no-adhoc-env-isolation.allowlist.json records (scripts/lib/
 *   allowlist-ratchet.cjs `assertFileBaseline`, #597).
 * - Structural guards on the allowlist, each driven against a synthetic
 *   violation so the guard itself is shown able to fail.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { RuleTester, ESLint } = require('eslint');
const { assertFileBaseline } = require('../scripts/lib/allowlist-ratchet.cjs');

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

// ─── the header's documented boundary ────────────────────────────────────────
// eslint-rules/no-adhoc-env-isolation.cjs lists what each arm flags and its
// "Known gaps". Each claim has a row here, so a refactor of isProcessEnv,
// readsEnvPath or the key match that moves the boundary fails a row instead of
// changing documented behaviour silently.

describe('no-adhoc-env-isolation: the header\'s flagged claims', () => {
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

  test('a split of a direct process.env.PATH read is flagged whatever it is for, and any *.delimiter counts', () => {
    run([], [
      { code: 'const n = process.env.PATH.split(path.delimiter).length;', filename: FILE, errors: [pathFilter] },
      { code: 'csv.split(csv.delimiter).filter(Boolean);', filename: FILE, errors: [pathFilter] },
    ]);
  });

  test('any object with a HOME key is flagged, whatever it is for', () => {
    run([], [{ code: 'const fixture = { HOME: "/home/someone" };', filename: FILE, errors: [home] }]);
  });
});

describe('no-adhoc-env-isolation: the header\'s known gaps are not flagged', () => {
  test('a PATH read the alias hop does not follow, unfiltered', () => {
    run([
      { code: "const { PATH } = process.env; PATH.split(':');", filename: FILE },
      { code: "const env = process.env; env.PATH.split(':');", filename: FILE },
      { code: "globalThis.process.env.PATH.split(':');", filename: FILE },
      { code: "`${process.env.PATH}`.split(':');", filename: FILE },
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
    ], []);
  });

  test('HOME set by a destructuring assignment or a class field', () => {
    run([
      { code: 'const env = { ...process.env }; [env.HOME, env.USERPROFILE] = [tmp, tmp];', filename: FILE },
      { code: 'const env = { ...process.env }; ({ home: env.HOME } = o);', filename: FILE },
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

  test("Windows' HOMEDRIVE / HOMEPATH keys, and a lowercase process.env.path read", () => {
    run([
      { code: "const env = { ...process.env, HOMEDRIVE: 'C:', HOMEPATH: tmp };", filename: FILE },
      { code: "process.env.path.split(':');", filename: FILE },
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
      { code: "const e = Object.fromEntries([['HOME', x]]);", filename: FILE },
      { code: "Object.defineProperty(env, 'HOME', { value: x });", filename: FILE },
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
    // A synthetic entry, so the row holds once the drain waves empty the real list.
    const listed = 'tests/adhoc-env-isolation-listed-6035.test.cjs';
    const listedEslint = new ESLint({
      cwd: REPO_ROOT,
      overrideConfig: { files: ['tests/**/*.cjs'], rules: { [RULE_ID]: ['error', { allowlist: [listed] }] } },
    });
    async function listedMessages(text) {
      const [result] = await listedEslint.lintText(text, { filePath: path.join(REPO_ROOT, listed) });
      return result.messages.filter((m) => m.ruleId === RULE_ID).map((m) => m.messageId);
    }
    assert.deepStrictEqual(await listedMessages(COPIES), []);
    assert.deepStrictEqual(await listedMessages(CLEAN), ['staleAllowlistEntry']);
  });
});

// ─── allowlist structure and per-file site counts ────────────────────────────

function readAllowlistText() {
  return fs.readFileSync(ALLOWLIST_PATH, 'utf8');
}

function readAllowlist() {
  return JSON.parse(readAllowlistText());
}

/** The allowlist's one accepted spelling: a key-sorted map, two-space indent, trailing newline. */
function canonicalText(map) {
  const sorted = Object.fromEntries(Object.keys(map).sort().map((k) => [k, map[k]]));
  return JSON.stringify(sorted, null, 2) + '\n';
}

function findDeadEntries(files, root) {
  return files.filter((entry) => !fs.existsSync(path.join(root, entry)));
}

function findMisplacedEntries(files) {
  return files.filter((entry) => entry.includes('\\') || !entry.startsWith('tests/') || !entry.endsWith('.cjs'));
}

function findBadCounts(map) {
  return Object.keys(map).filter((k) => !Number.isInteger(map[k]) || map[k] < 1);
}

function toRel(file) {
  return path.relative(REPO_ROOT, file).split(path.sep).join('/');
}

/**
 * The ESLint that counts sites: the rule runs with an empty allowlist, so it
 * reports every site rather than counting listed files silently, and with
 * inline config off, so an `eslint-disable` comment cannot hide a site from
 * the count. The exempt helper stays out, as it does in eslint.config.mjs.
 */
function siteCountEslint() {
  return new ESLint({
    cwd: REPO_ROOT,
    allowInlineConfig: false,
    overrideConfig: {
      files: ['tests/**/*.cjs'],
      ignores: [EXEMPT_FILE],
      rules: { [RULE_ID]: ['error', { allowlist: [] }] },
    },
    ruleFilter: ({ ruleId }) => ruleId === RULE_ID,
  });
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

/** The site count of every file under tests/. */
async function measureSiteCounts() {
  return countSites(await siteCountEslint().lintFiles(['tests/**/*.cjs']));
}

/** The four ways measured counts can differ from the recorded ones (#597's per-file form). */
function ratchetDiff(current, baseline) {
  const { grown, shrunk, added, removed } = assertFileBaseline({
    label: 'no-adhoc-env-isolation',
    current,
    baseline,
    fail: () => {},
  });
  return { grown, shrunk, added, removed };
}

const CLEAN_DIFF = { grown: [], shrunk: [], added: [], removed: [] };

describe('no-adhoc-env-isolation allowlist: structure', () => {
  test('is a key-sorted, duplicate-free map of tests/**/*.cjs paths to positive site counts', () => {
    const text = readAllowlistText();
    const map = JSON.parse(text);
    assert.ok(map && typeof map === 'object' && !Array.isArray(map), 'the allowlist must parse to an object');
    assert.strictEqual(text, canonicalText(map), 'keys must be sorted and unique, in canonical JSON: the drain waves take them in order');
    assert.deepStrictEqual(findMisplacedEntries(Object.keys(map)), []);
    assert.deepStrictEqual(findBadCounts(map), []);
  });

  test('every entry names a file that exists, and never the exempt helper', () => {
    const files = Object.keys(readAllowlist());
    assert.deepStrictEqual(findDeadEntries(files, REPO_ROOT), []);
    assert.ok(!files.includes(EXEMPT_FILE), `${EXEMPT_FILE} is exempt in eslint.config.mjs, not allowlisted`);
  });

  test('each structural check flags a synthetic violation', () => {
    assert.notStrictEqual(canonicalText({ 'tests/b.test.cjs': 1, 'tests/a.test.cjs': 1 }), '{\n  "tests/b.test.cjs": 1,\n  "tests/a.test.cjs": 1\n}\n');
    const duplicated = '{\n  "tests/a.test.cjs": 1,\n  "tests/a.test.cjs": 2\n}\n';
    assert.notStrictEqual(canonicalText(JSON.parse(duplicated)), duplicated);
    assert.deepStrictEqual(
      findMisplacedEntries(['tests\\a.test.cjs', 'src/a.cts', 'tests/a.md', 'tests/ok.test.cjs']),
      ['tests\\a.test.cjs', 'src/a.cts', 'tests/a.md'],
    );
    assert.deepStrictEqual(
      findDeadEntries(['tests/does-not-exist-6035.test.cjs', 'tests/no-adhoc-env-isolation.rule.test.cjs'], REPO_ROOT),
      ['tests/does-not-exist-6035.test.cjs'],
    );
    assert.deepStrictEqual(findBadCounts({ 'tests/a.cjs': 0, 'tests/b.cjs': 1.5, 'tests/c.cjs': '2', 'tests/d.cjs': 2 }), [
      'tests/a.cjs',
      'tests/b.cjs',
      'tests/c.cjs',
    ]);
  });

  test('the count comparison flags each boundary: count-1, count, count+1, an added file and a removed file', () => {
    const baseline = { 'tests/listed.test.cjs': 3 };
    assert.deepStrictEqual(ratchetDiff({ 'tests/listed.test.cjs': 2 }, baseline), {
      ...CLEAN_DIFF,
      shrunk: [{ name: 'tests/listed.test.cjs', from: 3, to: 2, delta: 1 }],
    });
    assert.deepStrictEqual(ratchetDiff({ 'tests/listed.test.cjs': 3 }, baseline), CLEAN_DIFF);
    assert.deepStrictEqual(ratchetDiff({ 'tests/listed.test.cjs': 4 }, baseline), {
      ...CLEAN_DIFF,
      grown: [{ name: 'tests/listed.test.cjs', from: 3, to: 4, delta: 1 }],
    });
    assert.deepStrictEqual(ratchetDiff({ 'tests/listed.test.cjs': 3, 'tests/new.test.cjs': 1 }, baseline), {
      ...CLEAN_DIFF,
      added: ['tests/new.test.cjs'],
    });
    assert.deepStrictEqual(ratchetDiff({}, baseline), { ...CLEAN_DIFF, removed: ['tests/listed.test.cjs'] });
  });
});

describe('no-adhoc-env-isolation allowlist: per-file site counts', () => {
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
    const recorded = readAllowlist();
    assert.deepStrictEqual(ratchetDiff({ ...recorded, ...counts }, recorded), { ...CLEAN_DIFF, added: [rel] });
  });

  test('every file under tests/ carries exactly the sites the allowlist records', async () => {
    const { counts, unparsed } = await measureSiteCounts();
    assert.deepStrictEqual(unparsed, [], 'a file ESLint cannot parse has no measured count');
    const diff = ratchetDiff(counts, readAllowlist());
    assert.deepStrictEqual(
      diff,
      CLEAN_DIFF,
      'The allowlist records each file\'s count of hand-written env-isolation copies, and a count may only fall. ' +
        'grown/added: migrate the new copy onto tests/helpers/isolated-env.cjs instead. ' +
        'shrunk/removed: lower the count in eslint-rules/no-adhoc-env-isolation.allowlist.json, or delete the entry at zero.',
    );
  });
});
