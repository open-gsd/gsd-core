'use strict';

/**
 * `gate-tdd-review-seal` (#5354): the seal I/O and SUMMARY heuristic split out of the
 * `tdd-review-checkpoint` gate. The seal and `NotEvaluable` behaviour is tested through the gate in
 * gate-tdd-review-checkpoint-hardening.test.cjs; this file tests the module's own helpers.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createTempGitProject, cleanup } = require('./helpers.cjs');
const { GIT_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

const { commitReachability, commitIsGone } = require('../gsd-core/bin/lib/gate-tdd-review-seal.cjs');

function git(dir, ...args) {
  return execFileSync(
    'git',
    ['-c', 'user.name=gate-test', '-c', 'user.email=gate-test@example.invalid', '-c', 'commit.gpgsign=false', ...args],
    { cwd: dir, encoding: 'utf-8', stdio: 'pipe', timeout: GIT_TIMEOUT_MS, windowsHide: true },
  );
}

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

describe('commitIsGone', () => {
  test('reads a reachability answer as squashed only when the commit is gone', () => {
    assert.equal(commitIsGone('reachable', () => true), false);
    assert.equal(commitIsGone('unreachable', () => false), true);
    assert.equal(commitIsGone('missing', () => true), true);
    assert.equal(commitIsGone('missing', () => false), false);
    assert.equal(commitIsGone(null, () => true), false);
  });
});
