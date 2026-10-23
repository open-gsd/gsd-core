'use strict';

/**
 * #4885: run from a SUBDIRECTORY of a linked worktree, the effective project root resolved to the main
 * checkout, so `commit` (and every planning write) landed in the wrong repository. The cwd has no
 * `.planning/` of its own, so resolveWorktreeContext skipped the local-planning shortcut and
 * remapped to dirname(git-common-dir). The worktree's OWN top-level holds the `.planning/` the
 * caller means, so it must win before the remap. Real git repositories, no mocks.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { createTempDir, cleanup } = require('./helpers.cjs');
const { GIT_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { resolveWorktreeContext } = require('../gsd-core/bin/lib/worktree-safety.cjs');

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: GIT_TIMEOUT_MS });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

describe('#4885 effective root from a subdirectory of a linked worktree', () => {
  let tmp;
  let main;
  let wt;

  beforeEach(() => {
    tmp = fs.realpathSync.native(createTempDir('gsd-4885-'));
    main = path.join(tmp, 'main');
    wt = path.join(tmp, 'wt');
    fs.mkdirSync(main);
    git(main, ['init', '-q', '-b', 'main']);
    git(main, ['config', 'user.email', 't@example.com']);
    git(main, ['config', 'user.name', 't']);
    fs.mkdirSync(path.join(main, '.planning'));
    fs.writeFileSync(path.join(main, '.planning', 'STATE.md'), '# State\n');
    git(main, ['add', '.']);
    git(main, ['commit', '-q', '-m', 'init']);
    git(main, ['worktree', 'add', '-q', '-b', 'feature', wt]);
  });
  afterEach(() => cleanup(tmp));

  test('a subdirectory of a linked worktree that carries .planning at its root resolves to the worktree root', () => {
    const sub = path.join(wt, 'src', 'deep');
    fs.mkdirSync(sub, { recursive: true });
    const r = resolveWorktreeContext(sub);
    assert.equal(fs.realpathSync.native(r.effectiveRoot), fs.realpathSync.native(wt), `resolved ${r.effectiveRoot} (${r.reason})`);
    assert.notEqual(fs.realpathSync.native(r.effectiveRoot), fs.realpathSync.native(main), 'must not remap to the main checkout');
  });

  test('the worktree root itself still resolves to itself', () => {
    const r = resolveWorktreeContext(wt);
    assert.equal(fs.realpathSync.native(r.effectiveRoot), fs.realpathSync.native(wt));
  });

  test('a linked worktree with NO .planning anywhere still remaps to the main checkout (the intended design)', () => {
    cleanup(path.join(wt, '.planning'));
    const sub = path.join(wt, 'src');
    fs.mkdirSync(sub, { recursive: true });
    const r = resolveWorktreeContext(sub);
    assert.equal(fs.realpathSync.native(r.effectiveRoot), fs.realpathSync.native(main));
    assert.equal(r.reason, 'linked_worktree');
  });

  test('a subdirectory of the main checkout is unchanged', () => {
    const sub = path.join(main, 'pkg');
    fs.mkdirSync(sub);
    const r = resolveWorktreeContext(sub);
    assert.equal(r.reason, 'main_worktree');
  });

  test('gsd-tools commit run from the subdirectory lands in the worktree, not the main checkout', () => {
    const sub = path.join(wt, 'src', 'deep');
    fs.mkdirSync(sub, { recursive: true });
    fs.appendFileSync(path.join(wt, '.planning', 'STATE.md'), 'more\n');
    const mainBefore = git(main, ['rev-parse', 'HEAD']);
    const tools = path.join(__dirname, '..', 'gsd-core', 'bin', 'gsd-tools.cjs');
    const r = spawnSync(process.execPath, [tools, 'commit', 'docs: state', '--files', '.planning/STATE.md'], { cwd: sub, encoding: 'utf8', timeout: GIT_TIMEOUT_MS });
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.equal(git(main, ['rev-parse', 'HEAD']), mainBefore, 'the main checkout must not receive the commit');
    assert.equal(git(wt, ['log', '-1', '--format=%s']), 'docs: state', 'the worktree receives the commit');
  });
});
