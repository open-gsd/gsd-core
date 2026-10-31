'use strict';

/**
 * hooks/lib/git-head-tree.js — unit tests (#4432)
 *
 * Seam: `headTreeEntry(startDir, relPath, limits?)` answers "what does the
 * commit HEAD names hold at this path?" by reading `.git` directly, with no
 * subprocess and no timer. Matrix rows 44-53
 * (.gsd/phase/feat-4432-secret-read-exempt/50-test-matrix.md).
 *
 * Fixture repositories are built here with git itself (spawnSync). The product
 * module under test never spawns; git appears only on the fixture/oracle side.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');
const fc = require('fast-check');
const { GIT_FIXTURE_TIMEOUT_MS: GIT_TEST_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { cleanup } = require('./helpers.cjs');

const { headTreeEntry, LIMITS } = require('../hooks/lib/git-head-tree.js');

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
};

function gitRaw(cwd, args) {
  return spawnSync('git', ['-c', 'commit.gpgsign=false', '-c', 'gc.auto=0', ...args], {
    cwd,
    timeout: GIT_TEST_TIMEOUT_MS,
    env: GIT_ENV,
    encoding: 'utf8',
  });
}

function git(cwd, args) {
  const r = gitRaw(cwd, args);
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

function commitAll(cwd, message) {
  git(cwd, ['add', '-f', '-A']);
  git(cwd, ['commit', '-q', '-m', message, '--allow-empty']);
}

function mkTemp(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

/** An initialised repo (no commits) removed by the test's t.after. */
function initRepo(t, prefix = 'gsd-4432-ht-') {
  const dir = mkTemp(prefix);
  t.after(() => cleanup(dir));
  git(dir, ['init', '-q', '-b', 'main']);
  return dir;
}

function writeFile(repo, rel, content = 'x\n') {
  const abs = path.join(repo, ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

const REGULAR = new Set(['100644', '100755']);
const isRegular = (entry) => entry !== null && REGULAR.has(entry.mode);

/** The blob oid git itself computes for HEAD:<rel>. */
function oracleOid(repo, rel) {
  return git(repo, ['rev-parse', `HEAD:${rel}`]).trim();
}

function symlinkOrSkip(t, target, linkPath) {
  try {
    fs.symlinkSync(target, linkPath);
    return true;
  } catch (err) {
    t.skip(`symlinks unavailable: ${err.code}`);
    return false;
  }
}

// ─── LIMITS ─────────────────────────────────────────────────────────────────

describe('LIMITS (#4432)', () => {
  test('is frozen and carries the documented bounds', () => {
    assert.ok(Object.isFrozen(LIMITS));
    assert.equal(LIMITS.maxRefHops, 8);
    assert.equal(LIMITS.maxParentDirs, 64);
    assert.equal(LIMITS.maxObjectBytes, 1024 * 1024);
    assert.equal(LIMITS.maxDeltaDepth, 50);
  });
});

// ─── Row 44: loose objects ──────────────────────────────────────────────────

describe('headTreeEntry reads loose objects (#4432 row 44)', () => {
  test('returns the mode and blob oid of a root file and a nested file', (t) => {
    const repo = initRepo(t);
    writeFile(repo, '.env.production', 'KEY=CHANGE_ME\n');
    writeFile(repo, 'apps/api/.env.production', 'KEY=nested\n');
    commitAll(repo, 'add');
    const root = headTreeEntry(repo, '.env.production');
    assert.deepEqual(root, { mode: '100644', oid: oracleOid(repo, '.env.production') });
    const nested = headTreeEntry(repo, 'apps/api/.env.production');
    assert.deepEqual(nested, { mode: '100644', oid: oracleOid(repo, 'apps/api/.env.production') });
  });

  test('a start directory below the repo top resolves relPath against that directory', (t) => {
    const repo = initRepo(t);
    writeFile(repo, 'apps/api/.env.production', 'KEY=nested\n');
    commitAll(repo, 'add');
    const fromTop = headTreeEntry(repo, 'apps/api/.env.production');
    const fromSub = headTreeEntry(path.join(repo, 'apps'), 'api/.env.production');
    assert.ok(fromTop);
    assert.deepEqual(fromSub, fromTop);
  });

  test('an executable file reports mode 100755', (t) => {
    const repo = initRepo(t);
    writeFile(repo, 'run.sh', '#!/bin/sh\n');
    git(repo, ['add', 'run.sh']);
    git(repo, ['update-index', '--chmod=+x', 'run.sh']);
    git(repo, ['commit', '-q', '-m', 'x']);
    const entry = headTreeEntry(repo, 'run.sh');
    assert.equal(entry && entry.mode, '100755');
  });

  test('answers from HEAD, not the working tree or the index', (t) => {
    const repo = initRepo(t);
    writeFile(repo, 'a.txt', 'one\n');
    commitAll(repo, 'one');
    const before = headTreeEntry(repo, 'a.txt');
    writeFile(repo, 'a.txt', 'two\n');
    git(repo, ['add', 'a.txt']);
    assert.deepEqual(headTreeEntry(repo, 'a.txt'), before);
  });
});

// ─── Row 45: packed and deltified ───────────────────────────────────────────

describe('headTreeEntry reads packed and deltified objects (#4432 row 45)', () => {
  test('gives the same answer before and after an aggressive gc', (t) => {
    const repo = initRepo(t);
    for (let i = 0; i < 30; i++) {
      writeFile(repo, `f${i % 7}.txt`, `content ${i}\n`.repeat(20));
      writeFile(repo, 'apps/api/.env.production', `KEY=${i}\n`);
      commitAll(repo, `c${i}`);
    }
    const before = headTreeEntry(repo, 'apps/api/.env.production');
    assert.ok(before);
    git(repo, ['gc', '--aggressive', '--prune=now', '-q']);
    assert.equal(fs.existsSync(path.join(repo, '.git', 'objects', 'pack')), true);
    const after = headTreeEntry(repo, 'apps/api/.env.production');
    assert.deepEqual(after, before);
    assert.deepEqual(after, { mode: '100644', oid: oracleOid(repo, 'apps/api/.env.production') });
  });
});

// ─── Row 46: linked worktree ────────────────────────────────────────────────

describe('headTreeEntry follows a .git file (#4432 row 46)', () => {
  test('resolves a linked worktree through gitdir and commondir', (t) => {
    const repo = initRepo(t);
    writeFile(repo, '.env.production', 'KEY=CHANGE_ME\n');
    commitAll(repo, 'add');
    const wt = path.join(mkTemp('gsd-4432-wt-'), 'linked');
    t.after(() => cleanup(path.dirname(wt)));
    const r = gitRaw(repo, ['worktree', 'add', '-q', '-b', 'other', wt]);
    if (r.status !== 0) {
      t.skip(`git worktree unavailable: ${r.stderr}`);
      return;
    }
    assert.ok(fs.statSync(path.join(wt, '.git')).isFile(), 'linked worktree has a .git file');
    assert.deepEqual(headTreeEntry(wt, '.env.production'), { mode: '100644', oid: oracleOid(repo, '.env.production') });
  });
});

// ─── Row 47: packed-refs and detached HEAD ──────────────────────────────────

describe('headTreeEntry resolves packed-refs and a detached HEAD (#4432 row 47)', () => {
  test('resolves HEAD through packed-refs after pack-refs --all', (t) => {
    const repo = initRepo(t);
    writeFile(repo, '.secrets', 'x\n');
    commitAll(repo, 'add');
    const before = headTreeEntry(repo, '.secrets');
    git(repo, ['pack-refs', '--all']);
    assert.equal(fs.existsSync(path.join(repo, '.git', 'refs', 'heads', 'main')), false, 'loose ref removed');
    assert.ok(fs.existsSync(path.join(repo, '.git', 'packed-refs')));
    assert.deepEqual(headTreeEntry(repo, '.secrets'), before);
    assert.ok(before);
  });

  test('resolves a detached HEAD holding a bare oid', (t) => {
    const repo = initRepo(t);
    writeFile(repo, '.secrets', 'x\n');
    commitAll(repo, 'add');
    const before = headTreeEntry(repo, '.secrets');
    git(repo, ['checkout', '-q', '--detach']);
    assert.match(fs.readFileSync(path.join(repo, '.git', 'HEAD'), 'utf8'), /^[0-9a-f]{40}\s*$/);
    assert.deepEqual(headTreeEntry(repo, '.secrets'), before);
    assert.ok(before);
  });

  test('skips packed-refs peel lines', (t) => {
    const repo = initRepo(t);
    writeFile(repo, '.secrets', 'x\n');
    commitAll(repo, 'add');
    git(repo, ['tag', '-a', 'v1', '-m', 'annotated']);
    git(repo, ['pack-refs', '--all']);
    assert.match(fs.readFileSync(path.join(repo, '.git', 'packed-refs'), 'utf8'), /^\^[0-9a-f]{40}$/m);
    assert.ok(isRegular(headTreeEntry(repo, '.secrets')));
  });
});

// ─── Row 48: non-blob entries ───────────────────────────────────────────────

describe('headTreeEntry on entries that are not regular blobs (#4432 row 48)', () => {
  test('a committed symlink is mode 120000', (t) => {
    const repo = initRepo(t);
    writeFile(repo, 'real.txt');
    if (!symlinkOrSkip(t, 'real.txt', path.join(repo, '.env.production'))) return;
    commitAll(repo, 'symlink');
    const entry = headTreeEntry(repo, '.env.production');
    assert.equal(entry && entry.mode, '120000');
    assert.equal(isRegular(entry), false);
  });

  test('a directory is not a regular blob', (t) => {
    const repo = initRepo(t);
    writeFile(repo, 'apps/.env');
    commitAll(repo, 'dir');
    assert.equal(isRegular(headTreeEntry(repo, 'apps')), false);
  });

  test('a path below a file is absent', (t) => {
    const repo = initRepo(t);
    writeFile(repo, 'apps');
    commitAll(repo, 'file named apps');
    assert.equal(headTreeEntry(repo, 'apps/.env'), null);
  });

  test('a submodule entry is mode 160000', (t) => {
    const repo = initRepo(t);
    writeFile(repo, 'a.txt');
    commitAll(repo, 'base');
    const oid = git(repo, ['rev-parse', 'HEAD']).trim();
    git(repo, ['update-index', '--add', '--cacheinfo', `160000,${oid},sub`]);
    git(repo, ['commit', '-q', '-m', 'gitlink']);
    const entry = headTreeEntry(repo, 'sub');
    assert.equal(entry && entry.mode, '160000');
    assert.equal(isRegular(entry), false);
  });

  test('a missing path is null', (t) => {
    const repo = initRepo(t);
    writeFile(repo, 'a.txt');
    commitAll(repo, 'base');
    assert.equal(headTreeEntry(repo, 'no/such/.env'), null);
    assert.equal(headTreeEntry(repo, '.env'), null);
  });

  test('a staged-only file is null', (t) => {
    const repo = initRepo(t);
    writeFile(repo, 'a.txt');
    commitAll(repo, 'base');
    writeFile(repo, '.env.production', 'KEY=real\n');
    git(repo, ['add', '-f', '.env.production']);
    assert.equal(headTreeEntry(repo, '.env.production'), null);
  });

  test('an untracked file is null', (t) => {
    const repo = initRepo(t);
    writeFile(repo, 'a.txt');
    commitAll(repo, 'base');
    writeFile(repo, '.env', 'KEY=real\n');
    assert.equal(headTreeEntry(repo, '.env'), null);
  });
});

// ─── Row 49: sha256 ─────────────────────────────────────────────────────────

describe('headTreeEntry fails closed on a SHA-256 repository (#4432 row 49)', () => {
  test('returns null', (t) => {
    const dir = mkTemp('gsd-4432-sha256-');
    t.after(() => cleanup(dir));
    const init = gitRaw(dir, ['init', '-q', '-b', 'main', '--object-format=sha256']);
    if (init.status !== 0) {
      t.skip(`git lacks --object-format=sha256: ${init.stderr}`);
      return;
    }
    writeFile(dir, '.env.production', 'x\n');
    commitAll(dir, 'add');
    assert.equal(headTreeEntry(dir, '.env.production'), null);
  });
});

// ─── Row 50: corruption ─────────────────────────────────────────────────────

describe('headTreeEntry fails closed on corruption (#4432 row 50)', () => {
  test('a corrupt loose tree object yields null without throwing', (t) => {
    const repo = initRepo(t);
    writeFile(repo, '.env.production', 'x\n');
    commitAll(repo, 'add');
    assert.ok(headTreeEntry(repo, '.env.production'));
    const tree = git(repo, ['rev-parse', 'HEAD^{tree}']).trim();
    const file = path.join(repo, '.git', 'objects', tree.slice(0, 2), tree.slice(2));
    fs.unlinkSync(file);
    fs.writeFileSync(file, Buffer.from('this is not a zlib stream'));
    assert.equal(headTreeEntry(repo, '.env.production'), null);
  });

  test('a loose object whose header lies about its size yields null', (t) => {
    const repo = initRepo(t);
    writeFile(repo, '.env.production', 'x\n');
    commitAll(repo, 'add');
    const tree = git(repo, ['rev-parse', 'HEAD^{tree}']).trim();
    const file = path.join(repo, '.git', 'objects', tree.slice(0, 2), tree.slice(2));
    fs.unlinkSync(file);
    fs.writeFileSync(file, zlib.deflateSync(Buffer.from('tree 9999\0short')));
    assert.equal(headTreeEntry(repo, '.env.production'), null);
  });

  test('a truncated pack index yields null without throwing', (t) => {
    const repo = initRepo(t);
    for (let i = 0; i < 5; i++) {
      writeFile(repo, '.env.production', `KEY=${i}\n`);
      commitAll(repo, `c${i}`);
    }
    git(repo, ['gc', '--prune=now', '-q']);
    assert.ok(headTreeEntry(repo, '.env.production'));
    const packDir = path.join(repo, '.git', 'objects', 'pack');
    const idxs = fs.readdirSync(packDir).filter((n) => n.endsWith('.idx'));
    assert.ok(idxs.length > 0, 'gc produced a pack');
    for (const idx of idxs) {
      const p = path.join(packDir, idx);
      fs.chmodSync(p, 0o644);
      fs.truncateSync(p, 100);
    }
    assert.equal(headTreeEntry(repo, '.env.production'), null);
  });

  test('a pack index with an unknown version yields null', (t) => {
    const repo = initRepo(t);
    writeFile(repo, '.env.production', 'x\n');
    commitAll(repo, 'add');
    git(repo, ['gc', '--prune=now', '-q']);
    const packDir = path.join(repo, '.git', 'objects', 'pack');
    for (const idx of fs.readdirSync(packDir).filter((n) => n.endsWith('.idx'))) {
      const p = path.join(packDir, idx);
      fs.chmodSync(p, 0o644);
      const buf = fs.readFileSync(p);
      buf.writeUInt32BE(3, 4);
      fs.writeFileSync(p, buf);
    }
    assert.equal(headTreeEntry(repo, '.env.production'), null);
  });

  test('a HEAD that names no object yields null', (t) => {
    const repo = initRepo(t);
    writeFile(repo, '.env.production', 'x\n');
    commitAll(repo, 'add');
    fs.writeFileSync(path.join(repo, '.git', 'HEAD'), `${'0'.repeat(40)}\n`);
    assert.equal(headTreeEntry(repo, '.env.production'), null);
    fs.writeFileSync(path.join(repo, '.git', 'HEAD'), 'garbage\n');
    assert.equal(headTreeEntry(repo, '.env.production'), null);
  });

  test('non-string and empty arguments yield null without throwing', (t) => {
    const repo = initRepo(t);
    writeFile(repo, 'a.txt');
    commitAll(repo, 'add');
    for (const rel of [undefined, null, 5, {}, '', '/', '//', '.', '..']) {
      assert.equal(headTreeEntry(repo, rel), null, String(rel));
    }
    assert.equal(headTreeEntry(undefined, 'a.txt'), null);
    assert.equal(headTreeEntry(null, 'a.txt'), null);
  });
});

// ─── Row 51: structural bounds (limit-1, limit, limit+1) ────────────────────

describe('headTreeEntry honors injected limits at limit-1, limit and limit+1 (#4432 row 51)', () => {
  test('maxRefHops counts each ref: line followed', (t) => {
    const repo = initRepo(t);
    writeFile(repo, '.env.production', 'x\n');
    commitAll(repo, 'add');
    const oid = git(repo, ['rev-parse', 'HEAD']).trim();
    const heads = path.join(repo, '.git', 'refs', 'heads');
    // HEAD -> hop1 -> hop2 -> hop3 -> hop4 (oid): four ref: lines are followed.
    fs.writeFileSync(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/hop1\n');
    fs.writeFileSync(path.join(heads, 'hop1'), 'ref: refs/heads/hop2\n');
    fs.writeFileSync(path.join(heads, 'hop2'), 'ref: refs/heads/hop3\n');
    fs.writeFileSync(path.join(heads, 'hop3'), 'ref: refs/heads/hop4\n');
    fs.writeFileSync(path.join(heads, 'hop4'), `${oid}\n`);
    const HOPS = 4;
    assert.ok(headTreeEntry(repo, '.env.production', { maxRefHops: HOPS + 1 }), 'limit+1');
    assert.ok(headTreeEntry(repo, '.env.production', { maxRefHops: HOPS }), 'limit');
    assert.equal(headTreeEntry(repo, '.env.production', { maxRefHops: HOPS - 1 }), null, 'limit-1');
  });

  test('a ref cycle terminates with null', (t) => {
    const repo = initRepo(t);
    writeFile(repo, 'a.txt');
    commitAll(repo, 'add');
    const heads = path.join(repo, '.git', 'refs', 'heads');
    fs.writeFileSync(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/loopa\n');
    fs.writeFileSync(path.join(heads, 'loopa'), 'ref: refs/heads/loopb\n');
    fs.writeFileSync(path.join(heads, 'loopb'), 'ref: refs/heads/loopa\n');
    assert.equal(headTreeEntry(repo, 'a.txt'), null);
  });

  test('maxObjectBytes bounds the inflated size of every object read', (t) => {
    const repo = initRepo(t);
    writeFile(repo, '.env.production', 'x\n');
    writeFile(repo, 'padding-one-with-a-long-name.txt');
    writeFile(repo, 'padding-two-with-a-long-name.txt');
    commitAll(repo, 'add');
    const inflated = (spec) => {
      const oid = git(repo, ['rev-parse', spec]).trim();
      const type = git(repo, ['cat-file', '-t', oid]).trim();
      const size = Number(git(repo, ['cat-file', '-s', oid]).trim());
      return `${type} ${size}\0`.length + size;
    };
    const biggest = Math.max(inflated('HEAD'), inflated('HEAD^{tree}'));
    assert.ok(headTreeEntry(repo, '.env.production', { maxObjectBytes: biggest + 1 }), 'limit+1');
    assert.ok(headTreeEntry(repo, '.env.production', { maxObjectBytes: biggest }), 'limit');
    assert.equal(headTreeEntry(repo, '.env.production', { maxObjectBytes: biggest - 1 }), null, 'limit-1');
  });

  test('maxDeltaDepth bounds a packed delta chain', (t) => {
    const repo = initRepo(t);
    for (let i = 0; i < 40; i++) {
      writeFile(repo, `file${i % 60}.txt`, `v${i}\n`);
      if (i === 0) for (let k = 0; k < 60; k++) writeFile(repo, `file${k}.txt`, `base ${k}\n`);
      commitAll(repo, `c${i}`);
    }
    git(repo, ['repack', '-a', '-d', '-f', '-q', '--depth=50', '--window=100']);
    git(repo, ['checkout', '-q', '--detach', 'HEAD~30']);
    const packDir = path.join(repo, '.git', 'objects', 'pack');
    const idx = fs.readdirSync(packDir).find((n) => n.endsWith('.idx'));
    assert.ok(idx, 'repack produced a pack');
    const depthByOid = new Map();
    for (const line of git(repo, ['verify-pack', '-v', path.join(packDir, idx)]).split('\n')) {
      const cols = line.trim().split(/\s+/);
      if (/^[0-9a-f]{40}$/.test(cols[0]) && cols.length >= 5) {
        depthByOid.set(cols[0], cols.length >= 7 ? Number(cols[5]) : 0);
      }
    }
    const head = git(repo, ['rev-parse', 'HEAD']).trim();
    const tree = git(repo, ['rev-parse', 'HEAD^{tree}']).trim();
    const depth = Math.max(depthByOid.get(head) ?? 0, depthByOid.get(tree) ?? 0);
    if (depth < 1) {
      t.skip('git did not delta-compress the commit or tree HEAD reads');
      return;
    }
    assert.ok(headTreeEntry(repo, 'file0.txt', { maxDeltaDepth: depth + 1 }), 'limit+1');
    assert.ok(headTreeEntry(repo, 'file0.txt', { maxDeltaDepth: depth }), 'limit');
    assert.equal(headTreeEntry(repo, 'file0.txt', { maxDeltaDepth: depth - 1 }), null, 'limit-1');
    assert.deepEqual(headTreeEntry(repo, 'file0.txt'), { mode: '100644', oid: oracleOid(repo, 'file0.txt') });
  });

  test('unknown or invalid limit values fall back to the defaults', (t) => {
    const repo = initRepo(t);
    writeFile(repo, 'a.txt');
    commitAll(repo, 'add');
    const expected = headTreeEntry(repo, 'a.txt');
    assert.ok(expected);
    for (const limits of [undefined, null, {}, { nonsense: 1 }, { maxRefHops: 'x' }, { maxObjectBytes: NaN }]) {
      assert.deepEqual(headTreeEntry(repo, 'a.txt', limits), expected, JSON.stringify(limits));
    }
  });
});

// ─── Row 52: no repository, no commits ──────────────────────────────────────

describe('headTreeEntry with no HEAD (#4432 row 52)', () => {
  test('a directory outside any repository is null', (t) => {
    const dir = mkTemp('gsd-4432-nogit-');
    t.after(() => cleanup(dir));
    writeFile(dir, '.env.production');
    assert.equal(headTreeEntry(dir, '.env.production'), null);
  });

  test('a repository without commits is null', (t) => {
    const repo = initRepo(t);
    writeFile(repo, '.env.production');
    git(repo, ['add', '-f', '.env.production']);
    assert.equal(headTreeEntry(repo, '.env.production'), null);
  });
});

// ─── Row 53: oracle parity ──────────────────────────────────────────────────

describe('headTreeEntry agrees with git ls-tree on random committed path sets (#4432 row 53)', () => {
  test('property: every committed file and absent path matches the oracle', () => {
    const segment = fc.constantFrom('a', 'b', '.env', 'x y', 'dir', 'Z');
    const pathArb = fc.array(segment, { minLength: 1, maxLength: 3 }).map((parts) => parts.join('/'));
    const setArb = fc.uniqueArray(pathArb, { minLength: 1, maxLength: 6 }).filter((paths) => {
      const dirs = new Set();
      for (const p of paths) {
        const parts = p.split('/');
        for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
      }
      return paths.every((p) => !dirs.has(p));
    });
    fc.assert(
      fc.property(setArb, (paths) => {
        const dir = mkTemp('gsd-4432-prop-');
        try {
          git(dir, ['init', '-q', '-b', 'main']);
          for (const p of paths) writeFile(dir, p, `content of ${p}\n`);
          commitAll(dir, 'set');
          const listed = git(dir, ['ls-tree', '-r', 'HEAD']).split('\n').filter(Boolean);
          assert.equal(listed.length, paths.length);
          for (const line of listed) {
            const [meta, name] = line.split('\t');
            const [mode, , oid] = meta.split(' ');
            assert.deepEqual(headTreeEntry(dir, name), { mode, oid }, name);
          }
          for (const p of paths) {
            assert.equal(headTreeEntry(dir, `${p}/below`), null, `${p}/below`);
            assert.equal(headTreeEntry(dir, `${p}-absent`), null, `${p}-absent`);
          }
          return true;
        } finally {
          cleanup(dir);
        }
      }),
      { seed: 4432, numRuns: 12 },
    );
  });
});

// ─── No subprocess ──────────────────────────────────────────────────────────

describe('headTreeEntry spawns no subprocess (#4432 row 54)', () => {
  test('answers correctly while every child_process entry point throws', (t) => {
    const repo = initRepo(t);
    writeFile(repo, '.env.production', 'x\n');
    commitAll(repo, 'add');
    const childProcess = require('node:child_process');
    const names = ['spawnSync', 'execFileSync', 'execSync', 'spawn', 'exec', 'execFile'];
    const originals = {};
    const attempted = [];
    for (const name of names) {
      originals[name] = childProcess[name];
      childProcess[name] = () => { attempted.push(name); throw new Error(`child_process.${name} must not be called`); };
    }
    let entry;
    let missing;
    try {
      entry = headTreeEntry(repo, '.env.production');
      missing = headTreeEntry(repo, '.env');
    } finally {
      for (const name of names) childProcess[name] = originals[name];
    }
    assert.deepEqual(attempted, []);
    assert.deepEqual(entry, { mode: '100644', oid: oracleOid(repo, '.env.production') });
    assert.equal(missing, null);
  });
});
