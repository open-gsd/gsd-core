'use strict';

/**
 * #6335 — the run-wide store of installed trees and the private copy of one
 * (tests/helpers/shared-install-fixture.cjs).
 *
 * Nothing here runs the installer: `install` is a stand-in that writes a few
 * files. tests/shared-install-fixture.install.test.cjs holds a copy against a
 * real install for every runtime family.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const fc = require('fast-check');

const { createTempDir, cleanup } = require('./helpers.cjs');
const {
  SHARED_FIXTURE_PREFIX,
  RUN_TEMP_ROOT_PREFIX,
  SharedFixtureModifiedError,
  runStoreDir,
  fixtureKey,
  listTree,
  treeDigest,
  createSharedFixtureStore,
  copyInstalledTree,
} = require('./helpers/shared-install-fixture.cjs');
const { settleRuntimeFixtures, installFixtureTree } = require('./helpers/install-shared.cjs');
const runTests = require('../scripts/run-tests.cjs');

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

/** A time well before any test runs, so a later change to an entry always moves its mtime. */
const BUILT_AT = new Date('2001-01-01T00:00:00Z');

/** Stamp a whole tree, root included, as last modified at BUILT_AT. */
function backdate(root) {
  for (const [relPath, stat] of listTree(root)) {
    if (!stat.isSymbolicLink()) fs.utimesSync(path.join(root, relPath), BUILT_AT, BUILT_AT);
  }
  fs.utimesSync(root, BUILT_AT, BUILT_AT);
}

/** A stand-in installer: writes a small tree into `root` and reports like runMinimalInstall. */
function fakeInstaller() {
  const calls = [];
  const install = (opts) => {
    calls.push(opts);
    const configDir = path.join(opts.root, 'cfg');
    fs.mkdirSync(path.join(configDir, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(configDir, 'a.md'), `installed for ${opts.runtime}\n`);
    fs.writeFileSync(path.join(configDir, 'sub', 'b.md'), `root is ${opts.root}\n`);
    backdate(opts.root);
    return { manifest: { files: { 'a.md': 'h' } }, configDir, root: opts.root, stdout: `into ${opts.root}`, stderr: '' };
  };
  return { install, calls };
}

let dir;
beforeEach(() => {
  dir = createTempDir('gsd-fxstore-');
});
afterEach(() => cleanup(dir));

const claude = { runtime: 'claude', scope: 'global' };
const entries = () => fs.readdirSync(dir).sort();

describe('runStoreDir', () => {
  // The store directory is the resolved path: on Windows that adds the drive
  // of the current directory to a path that names none.
  test('a temp directory named as a run root is the store directory', () => {
    const root = path.join(path.sep, 'tmp', `${RUN_TEMP_ROOT_PREFIX}Ab12Cd`);
    assert.equal(runStoreDir(root), path.resolve(root));
  });

  test('an absolute temp directory is returned as it is', () => {
    const root = path.resolve(path.sep, 'tmp', `${RUN_TEMP_ROOT_PREFIX}Ab12Cd`);
    assert.equal(runStoreDir(root), root);
  });

  test('a doubled or trailing separator in the temp directory names the same store', () => {
    const root = path.resolve(path.sep, 'tmp', `${RUN_TEMP_ROOT_PREFIX}Ab12Cd`);
    assert.equal(runStoreDir(`${path.dirname(root)}${path.sep}${path.sep}${path.basename(root)}${path.sep}`), root);
  });

  test('any other temp directory gives no store', () => {
    assert.equal(runStoreDir(path.join(path.sep, 'tmp')), null);
    assert.equal(runStoreDir(path.join(path.sep, 'tmp', 'gsd-test-ru')), null);
    assert.equal(runStoreDir(path.join(path.sep, 'tmp', `x${RUN_TEMP_ROOT_PREFIX}1`)), null);
    // The prefix on a parent does not count: only the temp directory itself.
    assert.equal(runStoreDir(path.join(path.sep, 'tmp', `${RUN_TEMP_ROOT_PREFIX}1`, 'child')), null);
  });

  test('the two prefixes are the runner\'s own', () => {
    assert.equal(RUN_TEMP_ROOT_PREFIX, runTests.RUN_TEMP_ROOT_PREFIX);
    assert.ok(
      runTests.RESERVED_TEMP_PREFIXES.includes(SHARED_FIXTURE_PREFIX),
      'the runner sweeps the store between chunks unless it spares this prefix',
    );
  });

  test('the runner\'s sweep spares a store entry and removes its neighbour', () => {
    fs.mkdirSync(path.join(dir, `${SHARED_FIXTURE_PREFIX}0123-abcd`));
    fs.writeFileSync(path.join(dir, `${SHARED_FIXTURE_PREFIX}0123.json`), '{}');
    fs.mkdirSync(path.join(dir, 'gsd-fxc-0123'));
    runTests.sweepRunTempRoot(dir);
    assert.deepEqual(entries(), [`${SHARED_FIXTURE_PREFIX}0123-abcd`, `${SHARED_FIXTURE_PREFIX}0123.json`]);
  });
});

describe('fixtureKey', () => {
  const env = fc.dictionary(fc.constantFrom('A', 'B', 'C', 'D'), fc.string({ maxLength: 4 }));

  test('property: the order of extraEnv keys does not change the key', () => {
    fc.assert(fc.property(env, (extraEnv) => {
      const reversed = Object.fromEntries(Object.entries(extraEnv).reverse());
      assert.equal(fixtureKey({ ...claude, extraEnv }), fixtureKey({ ...claude, extraEnv: reversed }));
    }));
  });

  test('property: two option sets share a key exactly when runtime, scope, args in order and env agree', () => {
    const opts = fc.record({
      runtime: fc.constantFrom('claude', 'codex'),
      scope: fc.constantFrom('global', 'local'),
      extraArgs: fc.array(fc.constantFrom('--x', '--y'), { maxLength: 2 }),
      extraEnv: env,
    });
    fc.assert(fc.property(opts, opts, (a, b) => {
      const same = a.runtime === b.runtime && a.scope === b.scope
        && a.extraArgs.length === b.extraArgs.length && a.extraArgs.every((x, i) => x === b.extraArgs[i])
        && Object.keys(a.extraEnv).length === Object.keys(b.extraEnv).length
        && Object.keys(a.extraEnv).every((k) => Object.hasOwn(b.extraEnv, k) && a.extraEnv[k] === b.extraEnv[k]);
      assert.equal(fixtureKey(a) === fixtureKey(b), same);
    }));
  });

  test('absent extraArgs and extraEnv are the empty ones', () => {
    assert.equal(fixtureKey(claude), fixtureKey({ ...claude, extraArgs: [], extraEnv: {} }));
  });
});

describe('createSharedFixtureStore', () => {
  test('the first get installs into a root under the store directory and publishes a record', () => {
    const { install, calls } = fakeInstaller();
    const store = createSharedFixtureStore({ dir, install, token: () => 'tok1' });
    const result = store.get(claude);

    assert.equal(calls.length, 1);
    assert.deepEqual(
      { runtime: calls[0].runtime, scope: calls[0].scope, extraArgs: calls[0].extraArgs, extraEnv: calls[0].extraEnv },
      { runtime: 'claude', scope: 'global', extraArgs: [], extraEnv: {} },
    );
    assert.equal(path.dirname(result.root), dir);
    assert.ok(path.basename(result.root).startsWith(SHARED_FIXTURE_PREFIX));
    assert.ok(path.basename(result.root).endsWith('-tok1'));
    assert.equal(fs.statSync(path.join(result.configDir, 'a.md')).isFile(), true);
    // The tree, its record, and nothing left over from publishing.
    assert.equal(entries().length, 2);
    assert.ok(entries().every((name) => name.startsWith(SHARED_FIXTURE_PREFIX)));
  });

  test('a store given its directory with a doubled separator shares with one given it plainly', () => {
    const a = fakeInstaller();
    const b = fakeInstaller();
    const doubled = `${path.dirname(dir)}${path.sep}${path.sep}${path.basename(dir)}`;
    const first = createSharedFixtureStore({ dir: doubled, install: a.install }).get(claude);
    const second = createSharedFixtureStore({ dir, install: b.install }).get(claude);
    assert.equal(b.calls.length, 0);
    assert.deepEqual(second, first);
    // And the process that lost a race reads the winner's record through either spelling.
    assert.deepEqual(createSharedFixtureStore({ dir: doubled, install: b.install }).get(claude), first);
  });

  test('a second get in the same process does not install again and returns the same result', () => {
    const { install, calls } = fakeInstaller();
    const store = createSharedFixtureStore({ dir, install });
    const first = store.get(claude);
    assert.equal(store.get({ ...claude, extraArgs: [], extraEnv: {} }), first);
    assert.equal(calls.length, 1);
  });

  test('another process (a second store on the same directory) reads the tree and installs nothing', () => {
    const a = fakeInstaller();
    const b = fakeInstaller();
    const first = createSharedFixtureStore({ dir, install: a.install }).get(claude);
    const second = createSharedFixtureStore({ dir, install: b.install }).get(claude);
    assert.equal(b.calls.length, 0);
    assert.deepEqual(second, first);
  });

  test('each distinct key gets its own tree', () => {
    const { install, calls } = fakeInstaller();
    const store = createSharedFixtureStore({ dir, install });
    const roots = new Set([
      store.get(claude).root,
      store.get({ ...claude, scope: 'local' }).root,
      store.get({ ...claude, extraArgs: ['--minimal'] }).root,
      store.get({ ...claude, extraEnv: { X: '1' } }).root,
      store.get({ runtime: 'codex', scope: 'global' }).root,
    ]);
    assert.equal(roots.size, 5);
    assert.equal(calls.length, 5);
  });

  test('no record exists while the install is still running', () => {
    let seenDuringInstall;
    const inner = fakeInstaller();
    const install = (opts) => {
      const result = inner.install(opts);
      seenDuringInstall = fs.readdirSync(dir).filter((name) => name.endsWith('.json'));
      return result;
    };
    createSharedFixtureStore({ dir, install }).get(claude);
    assert.deepEqual(seenDuringInstall, []);
    assert.equal(entries().filter((name) => name.endsWith('.json')).length, 1);
  });

  test('a failed install throws, publishes nothing and leaves no tree behind', () => {
    const failure = new Error('installer exited with status 1');
    const failing = (opts) => {
      fs.writeFileSync(path.join(opts.root, 'partial'), 'x');
      throw failure;
    };
    const store = createSharedFixtureStore({ dir, install: failing });
    assert.throws(() => store.get(claude), (err) => err === failure);
    assert.deepEqual(entries(), []);

    // The key is not poisoned: the next get installs.
    const { install, calls } = fakeInstaller();
    createSharedFixtureStore({ dir, install }).get(claude);
    assert.equal(calls.length, 1);
  });

  test('when another process publishes first, this one drops its own tree and uses the winner\'s', () => {
    const winner = fakeInstaller();
    const loser = fakeInstaller();
    let winnerResult;
    // The other process finishes its build while this one is still installing.
    const racing = (opts) => {
      winnerResult = createSharedFixtureStore({ dir, install: winner.install, token: () => 'winner' }).get(claude);
      return loser.install(opts);
    };
    const result = createSharedFixtureStore({ dir, install: racing, token: () => 'loser' }).get(claude);

    assert.deepEqual(result, winnerResult);
    assert.ok(result.root.endsWith('-winner'));
    assert.equal(loser.calls.length, 1);
    assert.equal(fs.existsSync(loser.calls[0].root), false);
    assert.equal(entries().length, 2);
  });

  test('a tree and a pending record left by a builder that died are not a record: the next get builds', () => {
    const id = crypto.createHash('sha256').update(fixtureKey(claude)).digest('hex').slice(0, 10);
    const dead = path.join(dir, `${SHARED_FIXTURE_PREFIX}${id}-dead`);
    fs.mkdirSync(dead);
    fs.writeFileSync(path.join(dead, 'half-written'), 'x');
    fs.writeFileSync(`${dead}.pending`, '{"result":');

    const { install, calls } = fakeInstaller();
    const result = createSharedFixtureStore({ dir, install, token: () => 'live' }).get(claude);
    assert.equal(calls.length, 1);
    assert.ok(result.root.endsWith('-live'));
    assert.equal(fs.statSync(path.join(result.configDir, 'a.md')).isFile(), true);
  });

  test('where the filesystem has no hard links, each process keeps a tree of its own and publishes nothing', () => {
    const noLinks = () => {
      throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
    };
    const a = fakeInstaller();
    const b = fakeInstaller();
    const storeA = createSharedFixtureStore({ dir, install: a.install, link: noLinks });
    const first = storeA.get(claude);
    assert.equal(fs.statSync(path.join(first.configDir, 'a.md')).isFile(), true);
    assert.equal(storeA.get(claude), first);
    assert.deepEqual(storeA.changed(), []);
    assert.deepEqual(entries().filter((name) => !fs.statSync(path.join(dir, name)).isDirectory()), []);

    const second = createSharedFixtureStore({ dir, install: b.install, link: noLinks }).get(claude);
    assert.equal(b.calls.length, 1);
    assert.notEqual(second.root, first.root);
  });

  test('a link failure that is not "no hard links here" is thrown, and the tree it built is removed', () => {
    const fault = Object.assign(new Error('too many open files'), { code: 'EMFILE' });
    const { install, calls } = fakeInstaller();
    const store = createSharedFixtureStore({ dir, install, link: () => { throw fault; } });
    assert.throws(() => store.get(claude), (err) => err === fault);
    assert.equal(calls.length, 1);
    assert.deepEqual(entries(), []);
  });

  test('stores installing from different sources do not share a tree', () => {
    const a = fakeInstaller();
    const b = fakeInstaller();
    const first = createSharedFixtureStore({ dir, install: a.install, source: '/checkout-a/bin/install.js' }).get(claude);
    const second = createSharedFixtureStore({ dir, install: b.install, source: '/checkout-b/bin/install.js' }).get(claude);
    assert.equal(b.calls.length, 1);
    assert.notEqual(second.root, first.root);
    const again = fakeInstaller();
    assert.deepEqual(
      createSharedFixtureStore({ dir, install: again.install, source: '/checkout-a/bin/install.js' }).get(claude),
      first,
    );
    assert.equal(again.calls.length, 0);
  });

  test('the loser of a race refuses a winning tree that was already changed', () => {
    const winner = fakeInstaller();
    const racing = (opts) => {
      const won = createSharedFixtureStore({ dir, install: winner.install, token: () => 'winner' }).get(claude);
      fs.writeFileSync(path.join(won.configDir, 'written-meanwhile.txt'), 'x');
      return fakeInstaller().install(opts);
    };
    assert.throws(
      () => createSharedFixtureStore({ dir, install: racing, token: () => 'loser' }).get(claude),
      (err) => err.code === 'SHARED_FIXTURE_MODIFIED',
    );
  });

  test('a record that names a tree outside the store is refused', () => {
    const { install } = fakeInstaller();
    createSharedFixtureStore({ dir, install }).get(claude);
    const recordFile = path.join(dir, entries().find((name) => name.endsWith('.json')));
    const outside = createTempDir('gsd-fx-outside-');
    const good = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
    const refused = (text) => {
      fs.writeFileSync(recordFile, text);
      assert.throws(
        () => createSharedFixtureStore({ dir, install }).get(claude),
        (err) => err.code === 'SHARED_FIXTURE_BAD_RECORD',
        text.slice(0, 80),
      );
    };
    try {
      for (const root of [outside, path.join(dir, 'not-a-store-name'), path.join(dir, `${SHARED_FIXTURE_PREFIX}0000000000-x`)]) {
        refused(JSON.stringify({ ...good, result: { ...good.result, root } }));
      }
      refused(JSON.stringify({ digest: good.digest }));
      refused(JSON.stringify({ result: good.result }));
      refused(JSON.stringify({ digest: good.digest, result: { root: good.result.root } }));
      refused('{"result":');
      refused('null');
      // The unchanged record is still accepted: the cases above failed for what they changed.
      fs.writeFileSync(recordFile, JSON.stringify(good));
      assert.deepEqual(createSharedFixtureStore({ dir, install }).get(claude), good.result);
    } finally {
      cleanup(outside);
    }
  });

  test('a process that finds a tree already changed fails at once, with the reason in the error code', () => {
    const { install } = fakeInstaller();
    const result = createSharedFixtureStore({ dir, install }).get(claude);
    fs.writeFileSync(path.join(result.configDir, 'written-by-an-earlier-file.txt'), 'x');

    const later = fakeInstaller();
    const store = createSharedFixtureStore({ dir, install: later.install });
    assert.throws(
      () => store.get(claude),
      (err) => err instanceof SharedFixtureModifiedError && err.code === 'SHARED_FIXTURE_MODIFIED' && err.key === fixtureKey(claude),
    );
    assert.equal(later.calls.length, 0);
    // It never used the tree, so it has nothing to report at exit.
    assert.deepEqual(store.changed(), []);
  });

  test('a process that finds the tree gone fails the same way', () => {
    const { install } = fakeInstaller();
    const result = createSharedFixtureStore({ dir, install }).get(claude);
    cleanup(result.root);
    assert.throws(
      () => createSharedFixtureStore({ dir, install }).get(claude),
      (err) => err.code === 'SHARED_FIXTURE_MODIFIED',
    );
  });

  describe('changed', () => {
    let store;
    let result;
    beforeEach(() => {
      store = createSharedFixtureStore({ dir, install: fakeInstaller().install });
      result = store.get(claude);
    });

    test('an untouched tree is not reported, however often it is read', () => {
      fs.readFileSync(path.join(result.configDir, 'a.md'), 'utf8');
      fs.readdirSync(result.configDir);
      assert.deepEqual(store.changed(), []);
    });

    test('a store that used nothing reports nothing', () => {
      assert.deepEqual(createSharedFixtureStore({ dir, install: fakeInstaller().install }).changed(), []);
    });

    for (const [what, change] of [
      ['a file added', (r) => fs.writeFileSync(path.join(r.configDir, 'new.txt'), 'x')],
      ['a file removed', (r) => fs.unlinkSync(path.join(r.configDir, 'a.md'))],
      ['a file given other content of another length', (r) => fs.writeFileSync(path.join(r.configDir, 'a.md'), 'changed')],
      ['a directory added', (r) => fs.mkdirSync(path.join(r.configDir, 'extra'))],
      ['a file added and removed again', (r) => {
        fs.writeFileSync(path.join(r.configDir, 'scratch.txt'), 'x');
        fs.unlinkSync(path.join(r.configDir, 'scratch.txt'));
      }],
      ['a file added and removed again at the top of the tree', (r) => {
        fs.writeFileSync(path.join(r.root, 'scratch.txt'), 'x');
        fs.unlinkSync(path.join(r.root, 'scratch.txt'));
      }],
      ['the whole tree removed', (r) => fs.rmSync(r.root, { recursive: true, force: true })], // eslint-disable-line local/no-raw-rmsync-in-tests -- the removal is the subject
    ]) {
      test(`${what} is reported under the tree's key`, () => {
        change(result);
        assert.deepEqual(store.changed(), [fixtureKey(claude)]);
      });
    }

    test('a file rewritten with the same length is reported', () => {
      const file = path.join(result.configDir, 'a.md');
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('installed', 'INSTALLED'));
      assert.deepEqual(store.changed(), [fixtureKey(claude)]);
    });

    test('a file rewritten with the same length and then given its old time back is not seen', () => {
      // The digest does not read contents. This is its stated limit, pinned so a
      // change to it is a decision.
      const file = path.join(result.configDir, 'a.md');
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('installed', 'INSTALLED'));
      fs.utimesSync(file, BUILT_AT, BUILT_AT);
      assert.deepEqual(store.changed(), []);
    });

    test('a file made executable is reported where the platform has the bit', { skip: process.platform === 'win32' }, () => {
      fs.chmodSync(path.join(result.configDir, 'a.md'), 0o755);
      fs.utimesSync(path.join(result.configDir, 'a.md'), BUILT_AT, BUILT_AT);
      assert.deepEqual(store.changed(), [fixtureKey(claude)]);
    });

    test('only the changed key is reported', () => {
      const other = store.get({ runtime: 'codex', scope: 'global' });
      fs.writeFileSync(path.join(other.configDir, 'new.txt'), 'x');
      assert.deepEqual(store.changed(), [fixtureKey({ runtime: 'codex', scope: 'global' })]);
    });

    test('a process that only read a tree another process built still detects a change to it', () => {
      const reader = createSharedFixtureStore({ dir, install: fakeInstaller().install });
      reader.get(claude);
      fs.writeFileSync(path.join(result.configDir, 'new.txt'), 'x');
      assert.deepEqual(reader.changed(), [fixtureKey(claude)]);
    });
  });
});

describe('settleRuntimeFixtures', () => {
  const fakeProc = () => {
    const proc = {
      exitCode: undefined,
      argv: ['node', '/repo/tests/some.test.cjs'],
      written: [],
      stderr: { write: (text) => proc.written.push(text) },
    };
    return proc;
  };
  const cache = () => {
    const c = { released: 0, release: () => { c.released += 1; } };
    return c;
  };

  test('with unchanged shared trees it releases the cache and leaves the exit code alone', () => {
    const proc = fakeProc();
    const c = cache();
    assert.deepEqual(settleRuntimeFixtures({ store: { changed: () => [] }, cache: c, proc }), []);
    assert.equal(c.released, 1);
    assert.equal(proc.exitCode, undefined);
    assert.deepEqual(proc.written, []);
  });

  test('with a changed shared tree it fails the process and names the key on stderr', () => {
    const proc = fakeProc();
    const key = fixtureKey(claude);
    assert.deepEqual(settleRuntimeFixtures({ store: { changed: () => [key] }, cache: cache(), proc }), [key]);
    assert.equal(proc.exitCode, 1);
    assert.equal(proc.written.length, 1);
  });

  test('outside a run (no store) it only releases the cache', () => {
    const proc = fakeProc();
    const c = cache();
    assert.deepEqual(settleRuntimeFixtures({ store: null, cache: c, proc }), []);
    assert.equal(c.released, 1);
    assert.equal(proc.exitCode, undefined);
  });
});

describe('installFixtureTree', () => {
  test('the hooks build is made complete before the install runs, and the install gets the options', () => {
    const order = [];
    const result = installFixtureTree(
      { runtime: 'claude', scope: 'global' },
      { ensureHooks: () => order.push('hooks'), install: (opts) => { order.push('install'); return { opts }; } },
    );
    assert.deepEqual(order, ['hooks', 'install']);
    assert.deepEqual(result.opts, { runtime: 'claude', scope: 'global' });
  });

  test('a failed hooks build throws, so no fixture is installed without its hooks', () => {
    const failure = new Error('node scripts/build-hooks.js failed');
    let installed = 0;
    assert.throws(
      () => installFixtureTree(claude, { ensureHooks: () => { throw failure; }, install: () => { installed += 1; } }),
      (err) => err === failure,
    );
    assert.equal(installed, 0);
  });
});

describe('treeDigest', () => {
  test('one tree read twice agrees, and a later modification time on one file changes the digest', () => {
    const root = path.join(dir, 'tree');
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'f'), 'x');
    const first = treeDigest(root);
    assert.equal(treeDigest(root), first);
    const stat = fs.statSync(path.join(root, 'f'));
    fs.utimesSync(path.join(root, 'f'), stat.atime, new Date(stat.mtimeMs + 5000));
    assert.notEqual(treeDigest(root), first);
  });

  test('an empty tree has a digest, and adding an empty directory changes it', () => {
    const root = path.join(dir, 'tree');
    fs.mkdirSync(root);
    const empty = treeDigest(root);
    fs.mkdirSync(path.join(root, 'd'));
    assert.notEqual(treeDigest(root), empty);
  });
});

describe('copyInstalledTree', () => {
  const FROM = 'gsd-fxs-aaaa-1111';
  const TO = 'gsd-fxc-2222';
  let from;
  let to;
  beforeEach(() => {
    from = path.join(dir, FROM);
    to = path.join(dir, TO);
    fs.mkdirSync(path.join(from, 'cfg', 'deep'), { recursive: true });
  });
  const read = (...parts) => fs.readFileSync(path.join(to, ...parts));

  test('a file that does not name the root is copied byte for byte', () => {
    const bytes = Buffer.from([0, 255, 10, 13, 200, 65, 0, 128]);
    fs.writeFileSync(path.join(from, 'cfg', 'bin.dat'), bytes);
    copyInstalledTree(from, to);
    assert.deepEqual(read('cfg', 'bin.dat'), bytes);
  });

  test('every spelling of the root path in a file names the copy afterwards', () => {
    const spellings = [
      from,
      from.split(path.sep).join('/'),
      from.split(path.sep).join('\\'),
      JSON.stringify(from.split(path.sep).join('\\')),
      `/private${from}`,
      `C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\${FROM}\\cfg`,
    ];
    fs.writeFileSync(path.join(from, 'cfg', 'paths.txt'), spellings.join('\n'));
    copyInstalledTree(from, to);
    const text = read('cfg', 'paths.txt').toString('utf8');
    assert.equal(text, spellings.map((s) => s.split(FROM).join(TO)).join('\n'));
  });

  test('bytes around the root name survive when the file is not valid UTF-8', () => {
    const bytes = Buffer.concat([Buffer.from([255, 254, 0]), Buffer.from(`é${FROM}é`, 'utf8'), Buffer.from([128, 0])]);
    fs.writeFileSync(path.join(from, 'cfg', 'mixed.dat'), bytes);
    copyInstalledTree(from, to);
    assert.deepEqual(
      read('cfg', 'mixed.dat'),
      Buffer.concat([Buffer.from([255, 254, 0]), Buffer.from(`é${TO}é`, 'utf8'), Buffer.from([128, 0])]),
    );
  });

  test('property: any bytes that do not hold the root name are copied unchanged', () => {
    fc.assert(fc.property(fc.uint8Array({ maxLength: 200 }), (data) => {
      const bytes = Buffer.from(data);
      fc.pre(!bytes.includes(Buffer.from(FROM)));
      const target = path.join(dir, `gsd-fxc-${crypto.randomBytes(4).toString('hex')}`);
      fs.writeFileSync(path.join(from, 'cfg', 'p.dat'), bytes);
      copyInstalledTree(from, target);
      assert.deepEqual(fs.readFileSync(path.join(target, 'cfg', 'p.dat')), bytes);
    }), { numRuns: 40 });
  });

  test('property: the root name between any bytes is replaced, and those bytes are kept', () => {
    const chunk = fc.uint8Array({ maxLength: 40 }).map((data) => Buffer.from(data));
    fc.assert(fc.property(fc.array(chunk, { minLength: 2, maxLength: 5 }), (chunks) => {
      // A chunk must not itself complete or start a root name at a join.
      fc.pre(chunks.every((c) => !c.includes(Buffer.from('gsd-fx'))));
      const name = `gsd-fxc-${crypto.randomBytes(4).toString('hex')}`;
      const join = (sep) => Buffer.concat(chunks.flatMap((c, i) => (i === 0 ? [c] : [Buffer.from(sep), c])));
      fs.writeFileSync(path.join(from, 'cfg', 'p.dat'), join(FROM));
      copyInstalledTree(from, path.join(dir, name));
      assert.deepEqual(fs.readFileSync(path.join(dir, name, 'cfg', 'p.dat')), join(name));
    }), { numRuns: 40 });
  });

  test('directories, empty ones included, and nested files all arrive', () => {
    fs.mkdirSync(path.join(from, 'cfg', 'empty'));
    fs.writeFileSync(path.join(from, 'cfg', 'deep', 'x.md'), 'x');
    copyInstalledTree(from, to);
    assert.equal(fs.statSync(path.join(to, 'cfg', 'empty')).isDirectory(), true);
    assert.equal(read('cfg', 'deep', 'x.md').toString(), 'x');
  });

  test('the returned function applies the same replacement to a caller\'s string', () => {
    const rewrite = copyInstalledTree(from, to);
    assert.equal(rewrite(path.join(from, 'cfg')), path.join(to, 'cfg'));
    assert.equal(rewrite('no root here'), 'no root here');
  });

  test('a symlink is recreated, pointing into the copy when it pointed into the source', { skip: process.platform === 'win32' }, () => {
    fs.writeFileSync(path.join(from, 'cfg', 'real.md'), 'x');
    fs.symlinkSync(path.join(from, 'cfg', 'real.md'), path.join(from, 'cfg', 'abs-link'));
    fs.symlinkSync('real.md', path.join(from, 'cfg', 'rel-link'));
    copyInstalledTree(from, to);
    assert.equal(fs.readlinkSync(path.join(to, 'cfg', 'abs-link')), path.join(to, 'cfg', 'real.md'));
    assert.equal(fs.readlinkSync(path.join(to, 'cfg', 'rel-link')), 'real.md');
  });

  test('a rewritten script arrives with its content, and executable where the platform has the bit', () => {
    fs.writeFileSync(path.join(from, 'cfg', 'hook.sh'), `#!/bin/sh\necho ${from}\n`, { mode: 0o755 });
    copyInstalledTree(from, to);
    assert.equal(read('cfg', 'hook.sh').toString(), `#!/bin/sh\necho ${to}\n`);
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(path.join(to, 'cfg', 'hook.sh')).mode & 0o111, 0o111);
    }
  });

  test('a file arrives under a restrictive umask, with its permission bits where the platform has them', () => {
    fs.writeFileSync(path.join(from, 'cfg', 'hook.sh'), '#!/bin/sh\n');
    fs.chmodSync(path.join(from, 'cfg', 'hook.sh'), 0o755);
    const previous = process.umask(0o077);
    try {
      copyInstalledTree(from, to);
    } finally {
      process.umask(previous);
    }
    assert.equal(read('cfg', 'hook.sh').toString(), '#!/bin/sh\n');
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(path.join(to, 'cfg', 'hook.sh')).mode & 0o777, 0o755);
    }
  });

  test('a directory keeps its permission bits where the platform has them', () => {
    fs.mkdirSync(path.join(from, 'cfg', 'private'));
    fs.chmodSync(path.join(from, 'cfg', 'private'), 0o700);
    copyInstalledTree(from, to);
    assert.equal(fs.statSync(path.join(to, 'cfg', 'private')).isDirectory(), true);
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(path.join(to, 'cfg', 'private')).mode & 0o777, 0o700);
    }
  });

  test('a copy that fails part way leaves no target behind', { skip: process.platform === 'win32' || process.getuid() === 0 }, () => {
    fs.writeFileSync(path.join(from, 'cfg', 'a-readable.md'), 'x');
    fs.writeFileSync(path.join(from, 'cfg', 'b-unreadable.md'), 'x');
    fs.chmodSync(path.join(from, 'cfg', 'b-unreadable.md'), 0o000);
    try {
      assert.throws(() => copyInstalledTree(from, to), { code: 'EACCES' });
    } finally {
      fs.chmodSync(path.join(from, 'cfg', 'b-unreadable.md'), 0o644);
    }
    assert.equal(fs.existsSync(to), false);
  });

  describe('manifest hashes', () => {
    const manifestOf = (root) => JSON.parse(fs.readFileSync(path.join(root, 'cfg', 'gsd-file-manifest.json'), 'utf8'));
    beforeEach(() => {
      const withRoot = `include ${from}/cfg/x\n`;
      const without = 'plain\n';
      fs.writeFileSync(path.join(from, 'cfg', 'with-root.md'), withRoot);
      fs.writeFileSync(path.join(from, 'cfg', 'plain.md'), without);
      fs.writeFileSync(
        path.join(from, 'cfg', 'gsd-file-manifest.json'),
        JSON.stringify({ files: { 'with-root.md': sha256(withRoot), 'plain.md': sha256(without) } }, null, 2),
      );
    });

    test('a rewritten file\'s recorded hash becomes the hash of what was written', () => {
      copyInstalledTree(from, to);
      const manifest = manifestOf(to);
      assert.equal(manifest.files['with-root.md'], sha256(read('cfg', 'with-root.md')));
      assert.notEqual(manifest.files['with-root.md'], manifestOf(from).files['with-root.md']);
    });

    test('an unchanged file keeps its recorded hash, which still matches the file', () => {
      copyInstalledTree(from, to);
      assert.equal(manifestOf(to).files['plain.md'], manifestOf(from).files['plain.md']);
      assert.equal(manifestOf(to).files['plain.md'], sha256(read('cfg', 'plain.md')));
    });

    test('the source tree and its manifest are not touched', () => {
      const before = treeDigest(from);
      copyInstalledTree(from, to);
      assert.equal(treeDigest(from), before);
    });

    test('a manifest under another name is found when the name is given', () => {
      fs.renameSync(path.join(from, 'cfg', 'gsd-file-manifest.json'), path.join(from, 'cfg', 'other.json'));
      copyInstalledTree(from, to, { manifestName: 'other.json' });
      const manifest = JSON.parse(read('cfg', 'other.json').toString());
      assert.equal(manifest.files['with-root.md'], sha256(read('cfg', 'with-root.md')));
    });
  });

  describe('refuses', () => {
    test('a target that is not a sibling of the source', () => {
      fs.mkdirSync(path.join(dir, 'elsewhere'));
      assert.throws(() => copyInstalledTree(from, path.join(dir, 'elsewhere', TO)), TypeError);
    });

    test('a target whose name is, contains or is contained in the source\'s', () => {
      assert.throws(() => copyInstalledTree(from, from), TypeError);
      assert.throws(() => copyInstalledTree(from, `${from}-2`), TypeError);
      assert.throws(() => copyInstalledTree(`${from}-2`, from), TypeError);
    });

    test('a root name that is not ASCII', () => {
      assert.throws(() => copyInstalledTree(from, path.join(dir, 'gsd-fxc-é')), TypeError);
    });

    test('a target that already exists, leaving it as it was', () => {
      fs.mkdirSync(to);
      fs.writeFileSync(path.join(to, 'keep'), 'x');
      assert.throws(() => copyInstalledTree(from, to), { code: 'EEXIST' });
      assert.equal(fs.readFileSync(path.join(to, 'keep'), 'utf8'), 'x');
    });
  });
});
