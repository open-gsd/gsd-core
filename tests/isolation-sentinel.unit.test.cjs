'use strict';

/**
 * In-process unit rows for hooks/lib/isolation-sentinel.js (#4885 review: the
 * hook half is held to the mutation-matrix floor).
 *
 * The guard suites mostly drive the hooks as subprocesses, and Stryker counts a
 * mutant as covered only when the test process itself runs the mutated line,
 * so the sentinel's validation, staleness bounds, dispatch matching and
 * repository probe each need a row here. Each row says what a wrong answer
 * would cost: a malformed or future-dated sentinel trusted as fresh would let
 * a dispatch bypass the recorded isolation decision.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { cleanup } = require('./helpers.cjs');
const { GIT_FIXTURE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const {
  readSentinel,
  sentinelPath,
  sentinelAppliesToDispatch,
  buildSentinelDiscard,
  resolveGuardProject,
  resolveSentinelRoot,
  SENTINEL_STALE_MS,
} = require('../hooks/lib/isolation-sentinel.js');

const WRITTEN_AT = 1_700_000_000_000;
const clockAt = (ms) => ({ now: () => ms });

/** A directory holding `.planning/`, so readSentinel resolves it as its own root without git or a build. */
function projectDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-sentinel-unit-'));
  t.after(() => cleanup(dir));
  fs.mkdirSync(path.join(dir, '.planning'));
  return dir;
}

function writeRaw(dir, text) {
  fs.mkdirSync(path.dirname(sentinelPath(dir)), { recursive: true });
  fs.writeFileSync(sentinelPath(dir), text);
}

const MALFORMED = { present: true, stale: true, malformed: true };

describe('readSentinel: what is trusted, and what is malformed', () => {
  test('no sentinel file is absent', (t) => {
    assert.deepEqual(readSentinel(projectDir(t)), { present: false });
  });

  test('a well-formed fresh sentinel is returned field for field', (t) => {
    const dir = projectDir(t);
    writeRaw(dir, JSON.stringify({ isolation: 'harness-worktree', harness_flag: 'isolation="worktree"', phase: '12', plan: '12-03', written_at: WRITTEN_AT }));
    assert.deepEqual(readSentinel(dir, { clock: clockAt(WRITTEN_AT + 1000) }), {
      present: true,
      stale: false,
      malformed: false,
      isolation: 'harness-worktree',
      harnessFlag: 'isolation="worktree"',
      phase: '12',
      plan: '12-03',
      writtenAt: WRITTEN_AT,
    });
  });

  // Each of these, read as well-formed, would hand the guard an isolation
  // decision nobody recorded.
  for (const [label, text] of [
    ['unparseable JSON', '{ not json'],
    ['JSON null', 'null'],
    ['a JSON string', '"harness-worktree"'],
    ['a JSON number', '42'],
    ['an unknown isolation mode', JSON.stringify({ isolation: 'worktree', written_at: WRITTEN_AT })],
    ['no isolation at all', JSON.stringify({ written_at: WRITTEN_AT })],
    ['a string written_at', JSON.stringify({ isolation: 'none', written_at: String(WRITTEN_AT) })],
    ['an infinite written_at', '{"isolation":"none","written_at":1e400}'],
    ['no written_at', JSON.stringify({ isolation: 'none' })],
  ]) {
    test(`${label} is malformed (stale), never trusted`, (t) => {
      const dir = projectDir(t);
      writeRaw(dir, text);
      assert.deepEqual(readSentinel(dir, { clock: clockAt(WRITTEN_AT) }), MALFORMED);
    });
  }

  test('empty or non-string harness_flag, phase and plan read as null; non-empty strings are kept', (t) => {
    const dir = projectDir(t);
    writeRaw(dir, JSON.stringify({ isolation: 'none', harness_flag: '', phase: '', plan: '', written_at: WRITTEN_AT }));
    const empty = readSentinel(dir, { clock: clockAt(WRITTEN_AT) });
    assert.deepEqual([empty.harnessFlag, empty.phase, empty.plan], [null, null, null]);
    writeRaw(dir, JSON.stringify({ isolation: 'none', harness_flag: 7, phase: 12, plan: ['p'], written_at: WRITTEN_AT }));
    const typed = readSentinel(dir, { clock: clockAt(WRITTEN_AT) });
    assert.deepEqual([typed.harnessFlag, typed.phase, typed.plan], [null, null, null]);
    writeRaw(dir, JSON.stringify({ isolation: 'none', harness_flag: 'f', phase: '1', plan: '1-01', written_at: WRITTEN_AT }));
    const kept = readSentinel(dir, { clock: clockAt(WRITTEN_AT) });
    assert.deepEqual([kept.harnessFlag, kept.phase, kept.plan], ['f', '1', '1-01']);
  });

  // A sentinel past its window belongs to an earlier dispatch; one dated more
  // than 5 s in the future was not written by this clock. Both bounds are exact.
  for (const [label, age, stale] of [
    ['one ms inside the stale window', SENTINEL_STALE_MS - 1, false],
    ['exactly at the stale window', SENTINEL_STALE_MS, true],
    ['5 s in the future (clock skew tolerance)', -5000, false],
    ['5 s and one ms in the future', -5001, true],
  ]) {
    test(`a sentinel ${label} is ${stale ? 'stale' : 'fresh'}`, (t) => {
      const dir = projectDir(t);
      writeRaw(dir, JSON.stringify({ isolation: 'none', written_at: WRITTEN_AT }));
      const s = readSentinel(dir, { clock: clockAt(WRITTEN_AT + age) });
      assert.deepEqual([s.present, s.malformed, s.stale], [true, false, stale]);
    });
  }
});

describe('sentinelAppliesToDispatch / buildSentinelDiscard: only a real disagreement is a mismatch', () => {
  const sentinel = (phase, plan) => ({ present: true, stale: false, malformed: false, isolation: 'none', phase, plan });

  for (const [label, s, ids, applies] of [
    ['no sentinel', null, { phase: '1', plan: '1-01' }, true],
    ['no dispatch identity', sentinel('1', '1-01'), null, true],
    ['same phase and plan', sentinel('1', '1-01'), { phase: '1', plan: '1-01' }, true],
    ['a different phase', sentinel('1', null), { phase: '2', plan: null }, false],
    ['a different plan', sentinel(null, '1-01'), { phase: null, plan: '1-02' }, false],
    ['a phase only one side names', sentinel('1', null), { phase: null, plan: null }, true],
    ['a plan only one side names', sentinel(null, null), { phase: null, plan: '1-02' }, true],
  ]) {
    test(`${label} -> ${applies ? 'applies' : 'does not apply'}`, () => {
      assert.equal(sentinelAppliesToDispatch(s, ids), applies);
    });
  }

  test('a fresh sentinel that does not apply is described, both sides, with absent values as null', () => {
    assert.deepEqual(buildSentinelDiscard(sentinel('1', undefined), { phase: '2' }), {
      sentinel: { phase: '1', plan: null },
      dispatch: { phase: '2', plan: null },
    });
    assert.deepEqual(buildSentinelDiscard(sentinel(undefined, '1-01'), { plan: '1-02' }), {
      sentinel: { phase: null, plan: '1-01' },
      dispatch: { phase: null, plan: '1-02' },
    });
  });

  test('nothing is described when there is nothing discarded: absent, stale, or applicable', () => {
    assert.equal(buildSentinelDiscard(null, { phase: '2' }), null);
    assert.equal(buildSentinelDiscard({ present: false }, { phase: '2' }), null);
    assert.equal(buildSentinelDiscard({ ...sentinel('1', null), stale: true }, { phase: '2' }), null);
    assert.equal(buildSentinelDiscard(sentinel('1', null), { phase: '1' }), null);
  });
});

describe('resolveGuardProject: the verdict edges the guard suites do not reach in-process', () => {
  test('a cwd that does not exist is not a project (its canonical path cannot be read)', () => {
    const missing = path.join(os.tmpdir(), `gsd-sentinel-unit-missing-${process.pid}-${Date.now()}`);
    assert.deepEqual(resolveGuardProject(missing), { project: false });
  });

  test('a cwd whose lexical and canonical paths both hold no project is not a project', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-sentinel-unit-none-'));
    t.after(() => cleanup(dir));
    assert.deepEqual(resolveGuardProject(dir), { project: false });
  });

  // #3050: when git cannot run, which repository a subdirectory belongs to is
  // unknown, so the guard denies instead of guessing "not this project".
  test('a project subdirectory where git cannot run is unresolved, naming the cause', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-sentinel-unit-nogit-'));
    t.after(() => cleanup(root));
    fs.mkdirSync(path.join(root, '.planning'));
    fs.writeFileSync(path.join(root, '.planning', 'config.json'), '{}');
    const sub = path.join(root, 'src');
    fs.mkdirSync(sub);
    const savedPath = process.env.PATH;
    t.after(() => { process.env.PATH = savedPath; });
    process.env.PATH = path.join(root, 'no-binaries-here');
    const verdict = resolveGuardProject(sub);
    process.env.PATH = savedPath;
    assert.deepEqual([verdict.project, verdict.root], [true, null]);
    assert.match(verdict.error.message, /git could not say which repository .* belongs to \(spawn failed \(ENOENT\)\)/);
  });

  test('resolveSentinelRoot returns a cwd holding .planning/ as is', (t) => {
    const dir = projectDir(t);
    assert.equal(resolveSentinelRoot(dir), dir);
  });
});

// #4815 / #2843 together: the repository-boundary check compares against the
// project's repository outside `.planning`, and against the store's own
// repository inside it. A `.planning` symlinked to an external store that is a
// repository of its own (#4815) separates the two answers, so each row below
// fails if the comparison picks the wrong side.
describe('resolveGuardProject: a .planning symlinked to a store with its own repository', () => {
  const git = (args, cwd) => execFileSync('git', args, { cwd, stdio: 'ignore', timeout: GIT_FIXTURE_TIMEOUT_MS });
  function storeProject(t) {
    const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-sentinel-unit-store-')));
    t.after(() => cleanup(base));
    const root = path.join(base, 'project');
    const store = path.join(base, 'store');
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.mkdirSync(store);
    git(['init', '-q'], root);
    git(['init', '-q'], store);
    fs.writeFileSync(path.join(store, 'config.json'), '{}');
    fs.symlinkSync(store, path.join(root, '.planning'), 'junction');
    return { root, store };
  }

  test('a project subdirectory, in the project\'s repository, is the project', (t) => {
    const { root } = storeProject(t);
    const v = resolveGuardProject(path.join(root, 'src'));
    assert.deepEqual([v.project, v.root && fs.realpathSync.native(v.root)], [true, root]);
  });

  for (const name of ['phases', '..foo']) {
    test(`a directory inside the store (.planning/${name}), in the store's repository, is the project`, (t) => {
      const { root, store } = storeProject(t);
      fs.mkdirSync(path.join(store, name));
      const v = resolveGuardProject(path.join(root, '.planning', name));
      assert.deepEqual([v.project, v.root && fs.realpathSync.native(v.root)], [true, root]);
    });
  }

  test('a repository nested inside the store is not the project', (t) => {
    const { root, store } = storeProject(t);
    fs.mkdirSync(path.join(store, 'vendor'));
    git(['init', '-q'], path.join(store, 'vendor'));
    assert.deepEqual(resolveGuardProject(path.join(root, '.planning', 'vendor')), { project: false });
  });
});

// #4885 review (Major): through an alias only the canonical path leads to a
// project, so the configuration is the canonical project's while the sentinel
// is read where gsd-tools, given the same cwd, writes it: under the alias.
test('an alias into a non-git project: config root canonical, sentinel root the alias', (t) => {
  const project = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-sentinel-unit-alias-')));
  t.after(() => cleanup(project));
  fs.mkdirSync(path.join(project, '.planning'));
  fs.writeFileSync(path.join(project, '.planning', 'config.json'), '{}');
  const deep = path.join(project, 'src', 'deep');
  fs.mkdirSync(deep, { recursive: true });
  const linkParent = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-sentinel-unit-link-'));
  t.after(() => cleanup(linkParent));
  const alias = path.join(linkParent, 'alias');
  fs.symlinkSync(deep, alias, 'junction');
  const v = resolveGuardProject(alias);
  assert.equal(v.project, true, JSON.stringify(v));
  assert.equal(fs.realpathSync.native(v.root), project);
  assert.equal(v.sentinelRoot, resolveSentinelRoot(alias));
  assert.equal(v.sentinelRoot, alias, 'non-git: the writer roots the alias at itself');
});

