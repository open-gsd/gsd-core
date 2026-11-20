'use strict';

/**
 * `gate-tdd-review-seal` (#5354): the seal I/O and SUMMARY heuristic split out of the
 * `tdd-review-checkpoint` gate. The seal and `NotEvaluable` behaviour is tested through the gate in
 * gate-tdd-review-checkpoint-hardening.test.cjs; this file tests the module's own helpers.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTempGitProject, createTempDir, cleanup } = require('./helpers.cjs');
const { gitOrThrow } = require('./helpers/git-fixture.cjs');

const { commitReachability, commitIsGone } = require('../gsd-core/bin/lib/gate-tdd-review-seal.cjs');
const { commitHistoryComplete } = require('../gsd-core/bin/lib/gate-evaluation-scope.cjs');

const git = (dir, ...args) => gitOrThrow(['-c', 'user.name=gate-test', '-c', 'user.email=gate-test@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: dir });

describe('commitReachability', () => {
  test('tells a reachable, an unreachable and a missing commit apart', (t) => {
    const dir = createTempGitProject('gate-5354-reach-');
    t.after(() => cleanup(dir));
    const base = git(dir, 'rev-parse', 'HEAD').trim();
    git(dir, 'checkout', '-q', '-b', 'side');
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'side');
    const side = git(dir, 'rev-parse', 'HEAD').trim();
    git(dir, 'checkout', '-q', '-');
    assert.equal(commitReachability(dir, base, 'HEAD'), 'reachable');
    assert.equal(commitReachability(dir, side, 'HEAD'), 'unreachable');
    assert.equal(commitReachability(dir, 'f'.repeat(40), 'HEAD'), 'missing');
    assert.equal(commitReachability(dir, '--all', 'HEAD'), null);
  });
});

/** A `planning.sub_repos` workspace keeps its history in the sub-repos, so completeness and existence are asked of the repos `commitIsAncestor` walks. */
describe('planning.sub_repos workspaces', () => {
  function configure(root, subRepos) {
    fs.mkdirSync(path.join(root, '.planning'), { recursive: true });
    fs.writeFileSync(path.join(root, '.planning', 'config.json'), JSON.stringify({ planning: { sub_repos: subRepos } }));
  }
  const sha = (dir, ref = 'HEAD') => git(dir, 'rev-parse', ref).trim();
  function track(t, dir) {
    t.after(() => cleanup(dir));
    return dir;
  }

  /** `app`: a shallow clone (depth 1, file:// so git honours it) of a two-commit origin; `old` is the commit it cut off. */
  function shallowApp(t, root) {
    const origin = track(t, createTempGitProject('gate-5354-origin-'));
    git(origin, 'commit', '-q', '--allow-empty', '-m', 'old, unlike any commit of the root');
    const old = sha(origin);
    git(origin, 'commit', '-q', '--allow-empty', '-m', 'second');
    git(root, 'clone', '-q', '--depth', '1', `file://${origin}`, 'app');
    assert.equal(git(path.join(root, 'app'), 'rev-parse', '--is-shallow-repository').trim(), 'true', 'positive control: app is shallow');
    return old;
  }

  test('a shallow sub-repo under a complete root: history is not complete and a commit it cut off is never gone', (t) => {
    const root = track(t, createTempGitProject('gate-5354-subrepo-'));
    configure(root, ['app']);
    const old = shallowApp(t, root);
    assert.equal(git(root, 'rev-parse', '--is-shallow-repository').trim(), 'false', 'positive control: root is complete');
    assert.equal(commitReachability(root, old, 'HEAD'), 'missing');
    assert.equal(commitHistoryComplete(root), false);
    assert.equal(commitIsGone(commitReachability(root, old, 'HEAD'), () => commitHistoryComplete(root)), false);
  });

  test('the seal case: a root that is no repo, with complete sub-repos, reads a vanished commit as gone', (t) => {
    const root = track(t, createTempDir('gate-5354-norepo-'));
    configure(root, ['app']);
    fs.mkdirSync(path.join(root, 'app'));
    git(path.join(root, 'app'), 'init', '-q');
    git(path.join(root, 'app'), 'commit', '-q', '--allow-empty', '-m', 'first');
    assert.equal(commitHistoryComplete(root), true);
    assert.equal(commitIsGone(commitReachability(root, 'f'.repeat(40), 'HEAD'), () => commitHistoryComplete(root)), true);
  });

  test('a commit only a sub-repo holds is not missing', (t) => {
    const root = track(t, createTempGitProject('gate-5354-known-'));
    configure(root, ['app']);
    fs.mkdirSync(path.join(root, 'app'));
    git(path.join(root, 'app'), 'init', '-q');
    git(path.join(root, 'app'), 'commit', '-q', '--allow-empty', '-m', 'only in app');
    // No repo holds both commits, so the ancestry answer is null; the sub-repo still knows its own commit.
    assert.equal(commitReachability(root, sha(path.join(root, 'app')), sha(root)), null);
  });
});

describe('commitIsGone', () => {
  test('reads a reachability answer as squashed only when the commit is gone', () => {
    assert.equal(commitIsGone('reachable', () => true), false);
    assert.equal(commitIsGone('unreachable', () => true), true);
    assert.equal(commitIsGone('unreachable', () => false), false);
    assert.equal(commitIsGone('missing', () => true), true);
    assert.equal(commitIsGone('missing', () => false), false);
    assert.equal(commitIsGone(null, () => true), false);
  });
});
