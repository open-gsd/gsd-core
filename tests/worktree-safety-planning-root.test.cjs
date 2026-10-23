'use strict';

/**
 * `ownWorktreePlanningRoot` / `resolvePlanningWorktreeRoot` — in-process rows (#4885).
 *
 * Seam: gsd-core/bin/lib/worktree-safety.cjs
 * Interface: ownWorktreePlanningRoot, resolvePlanningWorktreeRoot
 *
 * WHY A SEPARATE FILE
 * These rows lived in tests/commands.test.cjs beside the end-to-end `commit` /
 * `config-set` rows. That file is outside the worktree-safety mutation shard
 * (scripts/mutation-matrix.cjs derives a module's tests from files named after
 * it), so Stryker saw the resolver as uncovered. The rows that drive only this
 * module moved here; the rows that also go through gsd-tools'
 * resolveMainWorktreeCwd or the CLI stay in commands.test.cjs.
 */

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createTempGitProject, createTempDir, cleanup } = require('./helpers.cjs');
const { gitOrThrow } = require('./helpers/git-fixture.cjs');
const fc = require('./helpers/fast-check-setup.cjs');
const {
  ownWorktreePlanningRoot,
  resolvePlanningWorktreeRoot,
} = require('../gsd-core/bin/lib/worktree-safety.cjs');

describe('#4885: a linked worktree that carries its own .planning/ owns planning', () => {
  const dirs = [];
  after(() => { for (const d of dirs) cleanup(d); });

  // Main checkout + a linked worktree OUTSIDE it (or nested under main's
  // .claude/worktrees/). `trackPlanning: false` gitignores `.planning/`, so the
  // worktree is created without one.
  function mainWithWorktree({ trackPlanning, nested = false }) {
    const main = createTempGitProject('gsd-4885-main-');
    dirs.push(main);
    fs.writeFileSync(path.join(main, '.planning', 'STATE.md'), '# State\n');
    if (!trackPlanning) {
      fs.writeFileSync(path.join(main, '.gitignore'), '.planning/\n');
      gitOrThrow(['rm', '-r', '-q', '--cached', '.planning'], { cwd: main });
    }
    gitOrThrow(['add', '-A'], { cwd: main });
    gitOrThrow(['commit', '-m', 'seed'], { cwd: main });
    let wt;
    if (nested) {
      wt = path.join(main, '.claude', 'worktrees', 'agent-1');
    } else {
      const parent = createTempDir('gsd-4885-wt-');
      dirs.push(parent);
      wt = path.join(parent, 'wt');
    }
    gitOrThrow(['worktree', 'add', '-b', 'wt-branch', wt], { cwd: main });
    const sub = path.join(wt, 'src', 'deeper');
    fs.mkdirSync(sub, { recursive: true });
    return { main, wt, sub };
  }

  // #4885 review (M1): every null-answering row below would also pass for a
  // probe run in the wrong directory (git answering for the test runner's own
  // checkout), so this row pins that the probe runs at `cwd`.
  test('from a subdirectory of a worktree with its own .planning/, the worktree is the root', () => {
    const { wt, sub } = mainWithWorktree({ trackPlanning: true });
    // Three levels below the worktree top, so the `../` count git reports for
    // cwd cannot coincide with the one for whatever directory the runner is in.
    const deep = path.join(sub, 'third');
    fs.mkdirSync(deep);
    const own = ownWorktreePlanningRoot(deep);
    assert.equal(fs.realpathSync(own.root), fs.realpathSync(wt));
    assert.equal(own.timedOut, false);
  });

  test('a worktree with no .planning/ of its own answers null', () => {
    const { sub } = mainWithWorktree({ trackPlanning: false });
    assert.deepEqual(ownWorktreePlanningRoot(sub), { root: null, timedOut: false });
  });

  test('the walk stops at the worktree top: a worktree nested in main never adopts main\'s .planning/', () => {
    const { main, wt, sub } = mainWithWorktree({ trackPlanning: false, nested: true });
    assert.ok(!fs.existsSync(path.join(wt, '.planning')), 'fixture premise: nested worktree has no .planning/');
    assert.ok(fs.existsSync(path.join(main, '.planning')), 'fixture premise: main (an ancestor of sub) does');
    assert.deepEqual(ownWorktreePlanningRoot(sub), { root: null, timedOut: false });
  });

  // trek-e review 2026-10-10, Minor 2: `.planning` must be a directory, as
  // findProjectRoot requires — a regular file of that name is walked past.
  test('a regular file named .planning inside the worktree is walked past: the worktree\'s own project is the root', () => {
    const { wt } = mainWithWorktree({ trackPlanning: true });
    const planted = path.join(wt, 'pkg');
    fs.mkdirSync(planted);
    fs.writeFileSync(path.join(planted, '.planning'), 'x\n');
    const below = path.join(planted, 'src');
    fs.mkdirSync(below);
    assert.equal(fs.realpathSync(ownWorktreePlanningRoot(below).root), fs.realpathSync(wt));
  });

  test('a regular file as the worktree\'s only .planning answers null', () => {
    const { wt, sub } = mainWithWorktree({ trackPlanning: false });
    fs.writeFileSync(path.join(wt, '.planning'), 'x\n');
    assert.equal(ownWorktreePlanningRoot(sub).root, null);
  });

  // #4885 review, Minor 3: the root comes back in the caller's spelling when
  // that spelling names the same directory, and canonical when it does not.
  test('reached through a link to the worktree itself, the root keeps the caller\'s spelling', () => {
    const { wt } = mainWithWorktree({ trackPlanning: true });
    const linkParent = createTempDir('gsd-4885-link-');
    dirs.push(linkParent);
    const alias = path.join(linkParent, 'alias');
    fs.symlinkSync(wt, alias, 'junction');
    const below = path.join(alias, 'src', 'deeper');
    assert.equal(ownWorktreePlanningRoot(below).root, path.resolve(alias));
  });

  test('reached through a link to a directory BELOW the root, the root is canonical', () => {
    const { wt, sub } = mainWithWorktree({ trackPlanning: true });
    const linkParent = createTempDir('gsd-4885-link-');
    dirs.push(linkParent);
    const alias = path.join(linkParent, 'alias');
    fs.symlinkSync(sub, alias, 'junction');
    // Walking up from `alias` lexically leaves the worktree (linkParent is not
    // its parent), so the only true answer is the canonical worktree path.
    const own = ownWorktreePlanningRoot(alias);
    assert.equal(own.root, fs.realpathSync.native(wt));
    assert.notEqual(own.root, path.resolve(linkParent));
  });

  test('a cwd that cannot be canonicalized answers null', () => {
    const cdup = { exitCode: 0, stdout: '../\n', stderr: '', timedOut: false };
    assert.deepEqual(ownWorktreePlanningRoot('/no/such/dir-4885', { execGit: () => cdup }),
      { root: null, timedOut: false }, 'realpath failure');
  });

  test('a git failure answers root null; a git timeout also reports timedOut', () => {
    const failed = { exitCode: 128, stdout: '', stderr: 'fatal', timedOut: false };
    const timedOut = { exitCode: null, stdout: '', stderr: '', timedOut: true };
    assert.deepEqual(ownWorktreePlanningRoot('/repo/wt/sub', { execGit: () => failed }), { root: null, timedOut: false });
    assert.deepEqual(ownWorktreePlanningRoot('/repo/wt/sub', { execGit: () => timedOut }), { root: null, timedOut: true });
  });

  test('the probe asks git for the steps to the worktree top, at cwd', () => {
    const calls = [];
    const failed = { exitCode: 128, stdout: '', stderr: 'fatal', timedOut: false };
    ownWorktreePlanningRoot('/repo/wt/sub', { execGit: (args, opts) => { calls.push({ args, opts }); return failed; } });
    assert.deepEqual(calls, [{ args: ['rev-parse', '--show-cdup'], opts: { cwd: '/repo/wt/sub' } }]);
  });
});

// Nit 3: resolvePlanningWorktreeRoot's whole mapping, as a property: only a
// linked worktree consults the own-worktree probe; its root wins when found,
// a probe timeout reports git_timed_out at the main root, and every other
// input passes resolveWorktreeRoot's answer through unchanged.
describe('#4885: resolvePlanningWorktreeRoot', () => {
  test('property: maps (reason, own root, timeout) as specified', () => {
    const REASONS = ['has_local_planning', 'linked_worktree', 'main_worktree', 'not_git_repo', 'git_timed_out'];
    fc.assert(fc.property(fc.constantFrom(...REASONS), fc.option(fc.constant('/repo/wt/pkg')), fc.boolean(),
      (reason, ownRoot, timedOut) => {
        const probed = [];
        const out = resolvePlanningWorktreeRoot('/repo/wt/pkg/src', {
          resolveWorktreeRoot: () => ({ root: '/repo', reason }),
          ownWorktreePlanningRoot: (cwd) => { probed.push(cwd); return { root: ownRoot, timedOut: ownRoot ? false : timedOut }; },
        });
        if (reason !== 'linked_worktree') {
          assert.deepEqual(probed, []);
          assert.deepEqual(out, { root: '/repo', reason });
        } else if (ownRoot) {
          assert.deepEqual(probed, ['/repo/wt/pkg/src']);
          assert.deepEqual(out, { root: ownRoot, reason: 'linked_worktree' });
        } else if (timedOut) {
          assert.deepEqual(out, { root: '/repo', reason: 'git_timed_out' });
        } else {
          assert.deepEqual(out, { root: '/repo', reason: 'linked_worktree' });
        }
      }));
  });
});
