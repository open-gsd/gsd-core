'use strict';

/**
 * hooks/lib/secret-read-exemptions.js — unit tests (#4432)
 *
 * Seam: the module the secret-read guard consults before denying a path the
 * project listed under `hooks.secret_read_exempt` in `.planning/config.json`.
 *
 * Matrix rows covered (.gsd/phase/feat-4432-secret-read-exempt/50-test-matrix.md):
 *   L  17 18 19 20 21 22 23 24 25 26 27 28 29 30 31 36 37 41 43
 *   P  26 27 28 42 (hook-lib normalizer vs config-set normalizer)
 * Rows 1-16, 32-35, 38 are suite H (tests/gsd-secret-read-guard.test.cjs);
 * rows 39-40 are suite C (tests/config.test.cjs).
 *
 * Probes (`isCommittedBlob`, `isRegularFile`) are injected except in the
 * real-git rows (17, 18, 19, 21), which build a temp repo with git itself.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const fc = require('fast-check');
const { createTempGitProject, cleanup } = require('./helpers.cjs');
const { GIT_FIXTURE_TIMEOUT_MS: GIT_TEST_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const childProcess = require('node:child_process');

const exemptions = require('../hooks/lib/secret-read-exemptions.js');
const configLib = require('../gsd-core/bin/lib/config.cjs');

const {
  normalizeExemptEntry,
  readExemptEntries,
  createExemptionChecker,
  isCommittedBlob,
  isRegularFile,
} = exemptions;

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
};

function git(cwd, args) {
  const r = spawnSync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd,
    timeout: GIT_TEST_TIMEOUT_MS,
    env: GIT_ENV,
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

function commitAll(cwd, message) {
  git(cwd, ['add', '-f', '-A']);
  git(cwd, ['commit', '-m', message, '--allow-empty']);
}

/** A temp git repo with at least one commit; removed by the test's t.after. */
function makeRepo(t) {
  const dir = fs.realpathSync(createTempGitProject('gsd-4432-'));
  t.after(() => cleanup(dir));
  return dir;
}

function makeEmptyDir(t, prefix) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => cleanup(dir));
  return dir;
}

/** Create a symlink or skip the test (Windows lanes without the privilege). */
function symlinkOrSkip(t, target, linkPath) {
  try {
    fs.symlinkSync(target, linkPath);
    return true;
  } catch (err) {
    t.skip(`symlinks unavailable: ${err.code}`);
    return false;
  }
}

/** Probes that record their calls; `committed`/`regular` are the answers. */
function countingProbes({ committed = true, regular = true } = {}) {
  const calls = { committed: [], regular: [] };
  return {
    calls,
    isCommittedBlob: (root, entry) => { calls.committed.push([root, entry]); return committed; },
    isRegularFile: (abs) => { calls.regular.push(abs); return regular; },
  };
}

const ROOT = path.resolve(os.tmpdir(), 'gsd-4432-virtual-root');

// ─── normalizeExemptEntry ───────────────────────────────────────────────────

describe('normalizeExemptEntry (#4432 rows 26 27 28 29 41)', () => {
  // Row 26: every entry that is not a repo-relative file path is rejected.
  const REJECTED = [
    ['an absolute path', '/etc/x/.env'],
    ['a parent traversal', '../.env'],
    ['an embedded parent traversal', 'a/../.env'],
    ['a Windows drive path', 'C:\\x\\.env'],
    ['a drive-relative path', 'c:x'],
    ['a UNC path', '\\\\h\\s\\.env'],
    ['a forward-slash UNC path', '//h'],
    ['the empty string', ''],
    ['dot-slash alone', './'],
    ['a directory', 'a/'],
    ['a lone dot', '.'],
    ['a NUL byte', 'a\u0000b'],
    ['a backslash parent traversal', 'a\\..\\.env'],
  ];
  for (const [label, entry] of REJECTED) {
    test(`rejects ${label}`, () => {
      assert.equal(normalizeExemptEntry(entry), null);
    });
  }

  test('rejects every non-string entry', () => {
    for (const entry of [1, 0, null, undefined, {}, [], true, ['.env']]) {
      assert.equal(normalizeExemptEntry(entry), null);
    }
  });

  // Row 27.
  test('backslashes normalize to forward slashes unconditionally', () => {
    assert.equal(normalizeExemptEntry('.\\.env.production'), '.env.production');
    assert.equal(normalizeExemptEntry('apps\\api\\.env.production'), 'apps/api/.env.production');
  });

  // Row 28.
  test('a leading ./ run is stripped', () => {
    assert.equal(normalizeExemptEntry('./.env.production'), '.env.production');
    assert.equal(normalizeExemptEntry('././x'), 'x');
    assert.equal(normalizeExemptEntry('./apps/api/.env'), 'apps/api/.env');
  });

  test('a plain relative path is returned unchanged', () => {
    assert.equal(normalizeExemptEntry('.env.production'), '.env.production');
    assert.equal(normalizeExemptEntry('apps/api/.env.production'), 'apps/api/.env.production');
  });

  test('whitespace is part of a name and is not trimmed', () => {
    assert.equal(normalizeExemptEntry(' .env'), ' .env');
    assert.equal(normalizeExemptEntry('.env '), '.env ');
  });

  // Row 41.
  test('property: output is null or a relative, slash-only, traversal-free, idempotent path', () => {
    const piece = fc.constantFrom('..', '.', '', 'a', '.env', '.env.production', 'C:', ' ', '\\', '/', '\u0000', 'x y');
    const entry = fc.oneof(
      fc.string({ maxLength: 24 }),
      fc.array(piece, { maxLength: 6 }).chain((parts) =>
        fc.constantFrom('/', '\\').map((sep) => parts.join(sep))),
    );
    fc.assert(
      fc.property(entry, (e) => {
        const out = normalizeExemptEntry(e);
        if (out === null) return true;
        assert.equal(typeof out, 'string');
        assert.ok(out.length > 0, 'non-empty');
        assert.ok(!out.includes('\\'), 'no backslash');
        assert.ok(!out.startsWith('/'), 'not absolute');
        assert.ok(!out.endsWith('/'), 'not a directory');
        assert.ok(!/^[A-Za-z]:/.test(out), 'no drive prefix');
        assert.ok(!out.includes('\u0000'), 'no NUL');
        assert.ok(!out.split('/').includes('..'), 'no parent segment');
        assert.equal(normalizeExemptEntry(out), out, 'idempotent');
        return true;
      }),
      { seed: 4432, numRuns: 500 },
    );
  });
});

// ─── readExemptEntries ──────────────────────────────────────────────────────

describe('readExemptEntries (#4432 rows 29 30 31 37)', () => {
  const configOf = (value) => JSON.stringify({ hooks: { secret_read_exempt: value } });

  test('reads <root>/.planning/config.json as utf8', () => {
    const seen = [];
    const out = readExemptEntries(ROOT, {
      readFile: (p, enc) => { seen.push([p, enc]); return configOf(['.env.production']); },
    });
    assert.deepEqual(out, ['.env.production']);
    assert.deepEqual(seen, [[path.join(ROOT, '.planning', 'config.json'), 'utf8']]);
  });

  // Row 29.
  test('keeps only valid string entries from a mixed list', () => {
    const out = readExemptEntries(ROOT, {
      readFile: () => configOf([1, null, {}, '.env.production', '../x', './.secrets', true, []]),
    });
    assert.deepEqual(out, ['.env.production', '.secrets']);
  });

  // Row 37.
  test('duplicate entries collapse, order is preserved', () => {
    const out = readExemptEntries(ROOT, {
      readFile: () => configOf(['.secrets', '.env.production', './.secrets', '.env.production', '.\\.secrets']),
    });
    assert.deepEqual(out, ['.secrets', '.env.production']);
  });

  // Row 30.
  const NON_OBJECT_CONFIGS = [
    ['0', '0'],
    ['a string', '"s"'],
    ['an empty array', '[]'],
    ['null', 'null'],
    ['true', 'true'],
    ['hooks is null', '{"hooks":null}'],
    ['hooks is an array', '{"hooks":[]}'],
    ['the key is a string', '{"hooks":{"secret_read_exempt":"x"}}'],
    ['the key is an object', '{"hooks":{"secret_read_exempt":{"a":1}}}'],
    ['the key is a number', '{"hooks":{"secret_read_exempt":7}}'],
    ['the key is missing', '{"hooks":{}}'],
  ];
  for (const [label, text] of NON_OBJECT_CONFIGS) {
    test(`yields no entries when ${label}`, () => {
      assert.deepEqual(readExemptEntries(ROOT, { readFile: () => text }), []);
    });
  }

  // Row 31.
  test('yields no entries when the config is unparseable', () => {
    assert.deepEqual(readExemptEntries(ROOT, { readFile: () => '{not json' }), []);
  });

  test('yields no entries when the config is empty', () => {
    assert.deepEqual(readExemptEntries(ROOT, { readFile: () => '' }), []);
  });

  test('yields no entries when readFile throws', () => {
    const readFile = () => { throw Object.assign(new Error('boom'), { code: 'EIO' }); };
    assert.deepEqual(readExemptEntries(ROOT, { readFile }), []);
  });

  test('yields no entries when the config does not exist (default reader)', (t) => {
    const dir = makeEmptyDir(t, 'gsd-4432-noplan-');
    assert.deepEqual(readExemptEntries(dir), []);
  });

  test('reads a real config.json with the default reader', (t) => {
    const dir = makeEmptyDir(t, 'gsd-4432-plan-');
    fs.mkdirSync(path.join(dir, '.planning'));
    fs.writeFileSync(path.join(dir, '.planning', 'config.json'), configOf(['.env.production']));
    assert.deepEqual(readExemptEntries(dir), ['.env.production']);
  });
});

// ─── createExemptionChecker (injected probes) ──────────────────────────────

describe('createExemptionChecker (#4432 rows 20 22 23 24 25 36 43)', () => {
  const abs = (rel) => path.join(ROOT, rel);

  test('an absolute token naming a listed, committed, regular file is exempt', () => {
    const p = countingProbes();
    const check = createExemptionChecker({ root: ROOT, entries: ['.env.production'], allowRelative: false, ...p });
    assert.equal(check(abs('.env.production')), true);
  });

  // Row 24.
  test('a listed nested path is exempt for that absolute path', () => {
    const p = countingProbes();
    const check = createExemptionChecker({ root: ROOT, entries: ['apps/api/.env.production'], allowRelative: false, ...p });
    assert.equal(check(abs('apps/api/.env.production')), true);
  });

  // Row 23.
  test('a listed root file does not exempt a nested file of the same name', () => {
    const p = countingProbes();
    const check = createExemptionChecker({ root: ROOT, entries: ['.env.production'], allowRelative: true, ...p });
    assert.equal(check('apps/api/.env.production'), false);
    assert.equal(check(abs('apps/api/.env.production')), false);
  });

  test('a relative token is exempt only when allowRelative is set', () => {
    const p = countingProbes();
    const strict = createExemptionChecker({ root: ROOT, entries: ['.env.production'], allowRelative: false, ...p });
    const loose = createExemptionChecker({ root: ROOT, entries: ['.env.production'], allowRelative: true, ...p });
    assert.equal(strict('.env.production'), false);
    assert.equal(loose('.env.production'), true);
    assert.equal(loose('./.env.production'), true);
  });

  test('colon-joined tokens never match (ref:path, host:path, volume mounts)', () => {
    const p = countingProbes();
    const check = createExemptionChecker({ root: ROOT, entries: ['.env.production'], allowRelative: true, ...p });
    for (const tok of ['HEAD:.env.production', `host:${abs('.env.production')}`, `${abs('.env.production')}:/x`]) {
      assert.equal(check(tok), false, tok);
    }
  });

  test('non-string tokens are never exempt', () => {
    const p = countingProbes();
    const check = createExemptionChecker({ root: ROOT, entries: ['.env.production'], allowRelative: true, ...p });
    for (const tok of [undefined, null, 5, {}, [], '']) {
      assert.equal(check(tok), false);
    }
  });

  test('no entries means nothing is exempt', () => {
    const p = countingProbes();
    const check = createExemptionChecker({ root: ROOT, entries: [], allowRelative: true, ...p });
    assert.equal(check(abs('.env.production')), false);
  });

  // Row 20.
  test('a listed file missing from the working tree is not exempt', () => {
    const p = countingProbes({ committed: true, regular: false });
    const check = createExemptionChecker({ root: ROOT, entries: ['.env.production'], allowRelative: false, ...p });
    assert.equal(check(abs('.env.production')), false);
  });

  test('a listed file absent from HEAD is not exempt', () => {
    const p = countingProbes({ committed: false, regular: true });
    const check = createExemptionChecker({ root: ROOT, entries: ['.env.production'], allowRelative: false, ...p });
    assert.equal(check(abs('.env.production')), false);
  });

  // Row 22.
  test('a throwing git probe is fail-closed and does not throw', () => {
    const check = createExemptionChecker({
      root: ROOT,
      entries: ['.env.production'],
      allowRelative: false,
      isCommittedBlob: () => { throw Object.assign(new Error('git timed out'), { code: 'ETIMEDOUT' }); },
      isRegularFile: () => true,
    });
    assert.equal(check(abs('.env.production')), false);
  });

  test('a throwing file probe is fail-closed and does not throw', () => {
    const check = createExemptionChecker({
      root: ROOT,
      entries: ['.env.production'],
      allowRelative: false,
      isCommittedBlob: () => true,
      isRegularFile: () => { throw new Error('lstat failed'); },
    });
    assert.equal(check(abs('.env.production')), false);
  });

  // Row 25.
  test('case folding applies on win32 only', () => {
    const upper = abs('.ENV.PRODUCTION');
    for (const platform of ['linux', 'darwin']) {
      const p = countingProbes();
      const check = createExemptionChecker({ root: ROOT, entries: ['.env.production'], allowRelative: false, platform, ...p });
      assert.equal(check(upper), false, platform);
      assert.equal(check(abs('.env.production')), true, `${platform} exact case`);
    }
    const p = countingProbes();
    const win = createExemptionChecker({ root: ROOT, entries: ['.env.production'], allowRelative: false, platform: 'win32', ...p });
    assert.equal(win(upper), true);
  });

  // Row 36.
  test('probes run once per entry however many tokens name it', () => {
    const p = countingProbes();
    const check = createExemptionChecker({ root: ROOT, entries: ['.env.production', '.secrets'], allowRelative: true, ...p });
    assert.equal(check(abs('.env.production')), true);
    assert.equal(check('.env.production'), true);
    assert.equal(check('./.env.production'), true);
    assert.equal(check(abs('.env.production')), true);
    assert.equal(p.calls.committed.length, 1, 'git probe memoized');
    assert.equal(p.calls.regular.length, 1, 'file probe memoized');
    assert.deepEqual(p.calls.committed[0], [ROOT, '.env.production']);
    assert.equal(p.calls.regular[0], path.resolve(ROOT, '.env.production'));
  });

  test('a token that matches no entry runs no probe', () => {
    const p = countingProbes();
    const check = createExemptionChecker({ root: ROOT, entries: ['.env.production'], allowRelative: true, ...p });
    assert.equal(check(abs('.env')), false);
    assert.equal(check('.env.local'), false);
    assert.equal(p.calls.committed.length, 0);
    assert.equal(p.calls.regular.length, 0);
  });

  test('a failing probe result is memoized too', () => {
    const p = countingProbes({ committed: false });
    const check = createExemptionChecker({ root: ROOT, entries: ['.env.production'], allowRelative: true, ...p });
    assert.equal(check(abs('.env.production')), false);
    assert.equal(check('.env.production'), false);
    assert.equal(p.calls.committed.length, 1);
  });

  // Row 43.
  test('property: an unlisted secret token is never exempt, whatever else is listed', () => {
    const NAMES = ['.env', '.env.local', '.env.production', '.secrets', 'a/.env', 'b/c/.env.local', 'apps/api/.env.production'];
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.constantFrom(...NAMES), { maxLength: NAMES.length }),
        fc.constantFrom(...NAMES),
        fc.boolean(),
        (entries, name, relative) => {
          fc.pre(!entries.includes(name));
          const p = countingProbes();
          const check = createExemptionChecker({ root: ROOT, entries, allowRelative: true, ...p });
          return check(relative ? name : path.join(ROOT, name)) === false;
        },
      ),
      { seed: 4432, numRuns: 200 },
    );
  });
});

// ─── probes against real git ────────────────────────────────────────────────

describe('default probes against a real git repo (#4432 rows 17 18 19 21)', () => {
  // Row 54: no timer constant is exported, and no child process is ever spawned.
  test('the module exports no timeout constant', () => {
    for (const key of Object.keys(exemptions)) {
      assert.ok(!/TIMEOUT/i.test(key), `unexpected export ${key}`);
    }
  });

  test('the checks spawn no subprocess', (t) => {
    const repo = makeRepo(t);
    fs.writeFileSync(path.join(repo, '.env.production'), 'KEY=CHANGE_ME\n');
    fs.writeFileSync(path.join(repo, '.env'), 'KEY=real\n');
    commitAll(repo, 'add template');
    fs.writeFileSync(path.join(repo, '.secrets'), 'untracked\n');

    const names = ['spawnSync', 'execFileSync', 'execSync', 'spawn', 'exec', 'execFile'];
    const originals = {};
    const attempted = [];
    for (const name of names) {
      originals[name] = childProcess[name];
      childProcess[name] = () => { attempted.push(name); throw new Error(`child_process.${name} must not be called`); };
    }
    let committed;
    let untracked;
    let checkedIn;
    let checkedOut;
    try {
      committed = isCommittedBlob(repo, '.env.production');
      untracked = isCommittedBlob(repo, '.secrets');
      const check = createExemptionChecker({ root: repo, entries: ['.env.production', '.secrets'], allowRelative: false });
      checkedIn = check(path.join(repo, '.env.production'));
      checkedOut = check(path.join(repo, '.secrets'));
    } finally {
      for (const name of names) childProcess[name] = originals[name];
    }
    assert.deepEqual(attempted, []);
    assert.equal(committed, true);
    assert.equal(untracked, false);
    assert.equal(checkedIn, true);
    assert.equal(checkedOut, false);
  });

  test('positive control: a committed regular file is exempt through the default probes', (t) => {
    const repo = makeRepo(t);
    fs.writeFileSync(path.join(repo, '.env.production'), 'KEY=CHANGE_ME\n');
    commitAll(repo, 'add template');
    assert.equal(isCommittedBlob(repo, '.env.production'), true);
    assert.equal(isRegularFile(path.join(repo, '.env.production')), true);
    const check = createExemptionChecker({ root: repo, entries: ['.env.production'], allowRelative: false });
    assert.equal(check(path.join(repo, '.env.production')), true);
  });

  test('an executable committed file counts as a regular blob', (t) => {
    const repo = makeRepo(t);
    const file = path.join(repo, '.secrets');
    fs.writeFileSync(file, 'x\n');
    try { fs.chmodSync(file, 0o755); } catch { /* mode bits unavailable here; 100644 is covered above */ }
    commitAll(repo, 'add');
    assert.equal(isCommittedBlob(repo, '.secrets'), true);
  });

  // Row 17.
  test('a staged-but-uncommitted file is not committed', (t) => {
    const repo = makeRepo(t);
    fs.writeFileSync(path.join(repo, '.env.production'), 'KEY=real\n');
    git(repo, ['add', '-f', '.env.production']);
    assert.equal(isCommittedBlob(repo, '.env.production'), false);
    const check = createExemptionChecker({ root: repo, entries: ['.env.production'], allowRelative: false });
    assert.equal(check(path.join(repo, '.env.production')), false);
  });

  test('an untracked file is not committed', (t) => {
    const repo = makeRepo(t);
    fs.writeFileSync(path.join(repo, '.env'), 'KEY=real\n');
    assert.equal(isCommittedBlob(repo, '.env'), false);
  });

  // Row 18.
  test('a file committed as a symlink is never exempt', (t) => {
    const repo = makeRepo(t);
    fs.writeFileSync(path.join(repo, 'real.txt'), 'x\n');
    if (!symlinkOrSkip(t, 'real.txt', path.join(repo, '.env.production'))) return;
    commitAll(repo, 'symlink');
    assert.equal(isCommittedBlob(repo, '.env.production'), false);
    const check = createExemptionChecker({ root: repo, entries: ['.env.production'], allowRelative: false });
    assert.equal(check(path.join(repo, '.env.production')), false);
  });

  // Row 19.
  test('a committed file replaced by a symlink in the working tree is never exempt', (t) => {
    const repo = makeRepo(t);
    const file = path.join(repo, '.env.production');
    fs.writeFileSync(file, 'KEY=CHANGE_ME\n');
    fs.writeFileSync(path.join(repo, 'elsewhere.txt'), 'secret\n');
    commitAll(repo, 'add');
    assert.equal(isCommittedBlob(repo, '.env.production'), true, 'HEAD still holds a regular blob');
    fs.unlinkSync(file);
    if (!symlinkOrSkip(t, 'elsewhere.txt', file)) return;
    assert.equal(isRegularFile(file), false);
    const check = createExemptionChecker({ root: repo, entries: ['.env.production'], allowRelative: false });
    assert.equal(check(file), false);
  });

  test('a directory entry is not a committed blob', (t) => {
    const repo = makeRepo(t);
    fs.mkdirSync(path.join(repo, 'apps'));
    fs.writeFileSync(path.join(repo, 'apps', '.env'), 'x\n');
    commitAll(repo, 'dir');
    assert.equal(isCommittedBlob(repo, 'apps'), false);
    assert.equal(isRegularFile(path.join(repo, 'apps')), false);
  });

  test('a path git does not know is not a committed blob', (t) => {
    const repo = makeRepo(t);
    assert.equal(isCommittedBlob(repo, 'no/such/.env'), false);
  });

  // Row 21.
  test('a directory that is not a git repo has no exemption', (t) => {
    const dir = makeEmptyDir(t, 'gsd-4432-nogit-');
    fs.writeFileSync(path.join(dir, '.env.production'), 'x\n');
    assert.equal(isCommittedBlob(dir, '.env.production'), false);
    const check = createExemptionChecker({ root: dir, entries: ['.env.production'], allowRelative: false });
    assert.equal(check(path.join(dir, '.env.production')), false);
  });

  test('a repo with no commits has no exemption', (t) => {
    const dir = makeEmptyDir(t, 'gsd-4432-nohead-');
    git(dir, ['init', '-q']);
    fs.writeFileSync(path.join(dir, '.env.production'), 'x\n');
    git(dir, ['add', '-f', '.env.production']);
    assert.equal(isCommittedBlob(dir, '.env.production'), false);
    const check = createExemptionChecker({ root: dir, entries: ['.env.production'], allowRelative: false });
    assert.equal(check(path.join(dir, '.env.production')), false);
  });

  test('isRegularFile: missing path and directory are false, file is true', (t) => {
    const dir = makeEmptyDir(t, 'gsd-4432-reg-');
    fs.writeFileSync(path.join(dir, 'f'), 'x');
    assert.equal(isRegularFile(path.join(dir, 'f')), true);
    assert.equal(isRegularFile(path.join(dir, 'missing')), false);
    assert.equal(isRegularFile(dir), false);
  });
});

// ─── symlink and dot-segment gaps ───────────────────────────────────────────

describe('exemption tokens are read through no symlink and no dot-dot (#4432)', () => {
  /** A repo whose committed `tpl.txt` is exempt, plus an outside dir holding a different `tpl.txt`. */
  function fixture(t) {
    const repo = makeRepo(t);
    fs.writeFileSync(path.join(repo, 'tpl.txt'), 'KEY=CHANGE_ME\n');
    commitAll(repo, 'add template');
    const outer = makeEmptyDir(t, 'gsd-4432-outer-');
    fs.mkdirSync(path.join(outer, 'inner'));
    fs.writeFileSync(path.join(outer, 'tpl.txt'), 'KEY=real-secret\n');
    return { repo, outer };
  }

  test('positive control: the committed entry is exempt by absolute and relative token', (t) => {
    const { repo } = fixture(t);
    const check = createExemptionChecker({ root: repo, entries: ['tpl.txt'], allowRelative: true });
    assert.equal(check(path.join(repo, 'tpl.txt')), true);
    assert.equal(check('tpl.txt'), true);
  });

  test('<symlinked dir>/../<entry> is not exempt (absolute and relative)', (t) => {
    const { repo, outer } = fixture(t);
    if (!symlinkOrSkip(t, path.join(outer, 'inner'), path.join(repo, 'lnk'))) return;
    const check = createExemptionChecker({ root: repo, entries: ['tpl.txt'], allowRelative: true });
    assert.equal(check(`${repo}/lnk/../tpl.txt`), false, 'absolute');
    assert.equal(check('lnk/../tpl.txt'), false, 'relative');
  });

  test('a token with a .. segment is never exempt, even when it stays inside the root', (t) => {
    const { repo } = fixture(t);
    fs.mkdirSync(path.join(repo, 'sub'));
    const check = createExemptionChecker({ root: repo, entries: ['tpl.txt'], allowRelative: true });
    for (const tok of [`${repo}/sub/../tpl.txt`, 'sub/../tpl.txt', '../tpl.txt', 'sub\\..\\tpl.txt']) {
      assert.equal(check(tok), false, tok);
    }
  });

  test('a token with a . segment resolves to the same file and stays exempt', (t) => {
    const { repo } = fixture(t);
    const check = createExemptionChecker({ root: repo, entries: ['tpl.txt'], allowRelative: true });
    assert.equal(check('./tpl.txt'), true);
    assert.equal(check(`${repo}/./tpl.txt`), true);
  });

  test('an entry whose parent directory was swapped for a symlink is not exempt', (t) => {
    const { repo, outer } = fixture(t);
    fs.mkdirSync(path.join(repo, 'cfg'));
    fs.writeFileSync(path.join(repo, 'cfg', 'tpl.txt'), 'KEY=CHANGE_ME\n');
    commitAll(repo, 'add cfg template');
    const check = () => createExemptionChecker({ root: repo, entries: ['cfg/tpl.txt'], allowRelative: false });
    assert.equal(check()(path.join(repo, 'cfg', 'tpl.txt')), true, 'before the swap');
    fs.mkdirSync(path.join(outer, 'cfgdir'));
    fs.writeFileSync(path.join(outer, 'cfgdir', 'tpl.txt'), 'KEY=real-secret\n');
    cleanup(path.join(repo, 'cfg'));
    if (!symlinkOrSkip(t, path.join(outer, 'cfgdir'), path.join(repo, 'cfg'))) return;
    assert.equal(isRegularFile(path.join(repo, 'cfg', 'tpl.txt'), repo, 'cfg/tpl.txt'), false);
    assert.equal(check()(path.join(repo, 'cfg', 'tpl.txt')), false, 'after the swap');
  });

  test('isRegularFile with no root and entry keeps the lstat-only contract', (t) => {
    const { repo } = fixture(t);
    assert.equal(isRegularFile(path.join(repo, 'tpl.txt')), true);
  });
});

// ─── parity with config-set (suite P) ──────────────────────────────────────

describe('hook-lib normalizer and config-set normalizer agree (#4432 rows 26 27 28 42)', () => {
  test('config.cjs exports normalizeSecretReadExemptEntry', () => {
    assert.equal(typeof configLib.normalizeSecretReadExemptEntry, 'function');
  });

  const CORPUS = [
    '/etc/x/.env', '../.env', 'a/../.env', 'C:\\x\\.env', 'c:x', '\\\\h\\s\\.env', '//h', '', './', 'a/', '.', 'a\u0000b',
    '.\\.env.production', './.env.production', '././x', '.env.production', 'apps/api/.env.production', ' .env', 'a\\b',
    1, null, undefined, {}, [], true,
  ];
  for (const entry of CORPUS) {
    test(`same verdict for ${JSON.stringify(entry)}`, () => {
      assert.equal(configLib.normalizeSecretReadExemptEntry(entry), normalizeExemptEntry(entry));
    });
  }

  // Row 42.
  test('property: identical output for arbitrary values', () => {
    const piece = fc.constantFrom('..', '.', '', 'a', '.env', 'C:', 'c:', ' ', '\\', '/', '\u0000', '\\\\', '//');
    const entry = fc.oneof(
      fc.string({ maxLength: 24 }),
      fc.array(piece, { maxLength: 6 }).chain((parts) =>
        fc.constantFrom('/', '\\', '').map((sep) => parts.join(sep))),
      fc.anything(),
    );
    fc.assert(
      fc.property(entry, (e) => {
        assert.deepEqual(configLib.normalizeSecretReadExemptEntry(e), normalizeExemptEntry(e));
        return true;
      }),
      { seed: 4432, numRuns: 500 },
    );
  });
});
