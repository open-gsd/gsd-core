'use strict';

/**
 * #6031 (C4 of epic #4633): `worktree.baseRef` resolves through the family-B ladder and the
 * base-check verdict carries the layer that produced the value (#4090).
 *
 * The verdicts themselves are #3659 / #4588's and stay as they are: a `head` from any layer is
 * trusted in harness mode. What #4090 lost was the qualifier, so these cells pin that the real
 * CLI reports which settings layer supplied the value, from a hermetic HOME and Claude config dir.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cleanup } = require('./helpers.cjs');
const { isolatedEnv } = require('./helpers/isolated-env.cjs');
const { runGit, runNode } = require('./helpers/process-seam.cjs');

const GSD_TOOLS = path.join(__dirname, '..', 'gsd-core', 'bin', 'gsd-tools.cjs');
const lib = require('../gsd-core/bin/lib/worktree-base-ref.cjs');

function withProject(layers, run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-baseref-layer-'));
  const home = path.join(root, 'home');
  const userDir = path.join(home, '.claude');
  const cwd = path.join(root, 'repo');
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(userDir, { recursive: true });
  const env = isolatedEnv({ home, claudeConfigDir: userDir });
  const git = (...args) => {
    const r = runGit(args, { cwd, env });
    assert.equal(r.exitCode, 0, r.stderr);
  };
  git('init', '-q');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
  const files = {
    'runtime-local': path.join(cwd, '.claude', 'settings.local.json'),
    'runtime-shared': path.join(cwd, '.claude', 'settings.json'),
    'runtime-user': path.join(userDir, 'settings.json'),
  };
  for (const [layer, value] of Object.entries(layers)) {
    fs.mkdirSync(path.dirname(files[layer]), { recursive: true });
    fs.writeFileSync(files[layer], JSON.stringify(value), 'utf8');
  }
  try {
    return run({ cwd, env });
  } finally {
    cleanup(root);
  }
}

function baseCheck({ cwd, env }, ...extra) {
  const r = runNode([GSD_TOOLS, 'worktree', 'base-check', '--mode', 'harness-worktree', ...extra], { cwd, env });
  assert.equal(r.exitCode, 0, r.stderr);
  return JSON.parse(r.stdout);
}

const HEAD = { worktree: { baseRef: 'head' } };

describe('#4090: worktree base-check reports the layer that produced worktree.baseRef (real CLI)', () => {
  for (const layer of ['runtime-local', 'runtime-shared', 'runtime-user']) {
    test(`a head set only in ${layer} is reported with that layer and the verdict is unchanged`, () => {
      withProject({ [layer]: HEAD }, (project) => {
        const result = baseCheck(project);
        assert.equal(result.baseRefLayer, layer);
        assert.equal(result.shouldDegrade, false);
        assert.equal(result.reason, 'baseref-head');
      });
    });
  }

  test('the highest layer wins and is the one reported', () => {
    withProject({ 'runtime-user': HEAD, 'runtime-shared': { worktree: { baseRef: 'fresh' } } }, (project) => {
      const result = baseCheck(project);
      assert.equal(result.baseRefLayer, 'runtime-shared');
      assert.notEqual(result.reason, 'baseref-head');
    });
  });

  test('no baseRef anywhere reports a null layer', () => {
    withProject({}, (project) => {
      assert.equal(baseCheck(project).baseRefLayer, null);
    });
  });

  test('the user-level head is not misread as project-local: an observed mismatch still names baseref-head-ignored-by-harness', () => {
    withProject({ 'runtime-user': HEAD }, (project) => {
      const result = baseCheck(project, '--observed-fork-base', 'a'.repeat(40));
      assert.equal(result.reason, 'baseref-head-ignored-by-harness');
      assert.equal(result.baseRefLayer, 'runtime-user');
    });
  });
});

describe('#6031: evaluateWorktreeBaseDegrade keeps its verdicts for a string baseRef and gains the layer for a resolution', () => {
  const noGit = () => { throw new Error('git must not run'); };

  test('a legacy string effectiveBaseRef yields a result without a baseRefLayer key', () => {
    const result = lib.evaluateWorktreeBaseDegrade({ effectiveBaseRef: 'head', isolationMode: 'orchestrator-worktree', execGit: noGit });
    assert.equal(result.reason, 'baseref-head');
    assert.equal(Object.hasOwn(result, 'baseRefLayer'), false);
  });

  test('a resolution is read for its value and its layer is carried into the result', () => {
    const resolution = { found: true, value: 'head', layer: 'runtime-user', reason: 'resolved' };
    const result = lib.evaluateWorktreeBaseDegrade({ effectiveBaseRef: resolution, isolationMode: 'orchestrator-worktree', execGit: noGit });
    assert.equal(result.reason, 'baseref-head');
    assert.equal(result.shouldDegrade, false);
    assert.equal(result.baseRefLayer, 'runtime-user');
  });

  test('an unfound resolution behaves as an absent baseRef', () => {
    const resolution = { found: false, value: undefined, layer: null, reason: 'not_configured' };
    const ok = (stdout) => ({ exitCode: 0, stdout, stderr: '', signal: null, error: null });
    const result = lib.evaluateWorktreeBaseDegrade({
      effectiveBaseRef: resolution,
      isolationMode: 'harness-worktree',
      execGit: (args) => ok(args[0] === 'rev-parse' && args.includes('origin/HEAD') ? 'b'.repeat(40) : 'a'.repeat(40)),
      probeStateRead: () => null,
      probeStateWrite: () => {},
    });
    assert.equal(result.reason, 'head-diverged-from-fork');
    assert.equal(result.baseRefLayer, null);
  });
});
