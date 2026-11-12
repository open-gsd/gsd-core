'use strict';

// #5894 — pin the release ancestry check (main must be an ancestor of next).

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { ANCESTRY_VERDICT, GIT_TIMEOUT_MS, checkAncestry, parseArgs, main } = require('../scripts/release-ancestry.cjs');
const { cleanup } = require('./helpers.cjs');

function sink() {
  return { buf: '', write(s) { this.buf += s; } };
}

describe('#5894: checkAncestry verdicts', () => {
  test('maps git statuses to verdicts', () => {
    const verdict = (status) => checkAncestry({ ancestor: 'a', descendant: 'b', git: () => ({ status }) });
    assert.equal(verdict(0), ANCESTRY_VERDICT.ANCESTOR);
    assert.equal(verdict(1), ANCESTRY_VERDICT.DIVERGED);
    assert.equal(verdict(128), ANCESTRY_VERDICT.UNKNOWN);
    assert.equal(verdict(null), ANCESTRY_VERDICT.UNKNOWN);
  });

  test('status boundary: -1 and 2 are UNKNOWN, 0 and 1 are verdicts', () => {
    const verdict = (status) => checkAncestry({ ancestor: 'a', descendant: 'b', git: () => ({ status }) });
    assert.equal(verdict(-1), ANCESTRY_VERDICT.UNKNOWN);
    assert.equal(verdict(0), ANCESTRY_VERDICT.ANCESTOR);
    assert.equal(verdict(1), ANCESTRY_VERDICT.DIVERGED);
    assert.equal(verdict(2), ANCESTRY_VERDICT.UNKNOWN);
  });
});

describe('#5894: release-ancestry main()', () => {
  function runMainWith(status) {
    const calls = [];
    const stdout = sink();
    const stderr = sink();
    const code = main([], { git: (args) => { calls.push(args); return { status }; }, stdout, stderr });
    return { code, calls, stdout, stderr };
  }

  test('asks git whether origin/main is an ancestor of origin/next', () => {
    const { calls } = runMainWith(0);
    assert.deepEqual(calls[0], ['merge-base', '--is-ancestor', 'origin/main', 'origin/next']);
  });

  test('ancestor exits 0', () => {
    assert.equal(runMainWith(0).code, 0);
  });

  test('diverged exits 1 and names the sanctioned fix', () => {
    const { code, stderr } = runMainWith(1);
    assert.equal(code, 1);
    assert.ok(stderr.buf.includes('merge-commit-pr.cjs'));
    assert.ok(stderr.buf.includes('#5894'));
  });

  test('unknown exits 1', () => {
    assert.equal(runMainWith(128).code, 1);
  });
});

describe('#5894: release-ancestry parseArgs', () => {
  test('defaults', () => {
    assert.deepEqual(parseArgs([]), { ancestor: 'origin/main', descendant: 'origin/next' });
  });

  test('explicit refs', () => {
    assert.deepEqual(parseArgs(['--ancestor', 'v1.20.0', '--descendant', 'origin/main']), { ancestor: 'v1.20.0', descendant: 'origin/main' });
  });

  test('rejects malformed input', () => {
    for (const argv of [['--ancestor'], ['--x', 'y'], ['--ancestor', '-bad'], ['--ancestor', 'a b']]) {
      assert.ok(parseArgs(argv).error, `expected an error for ${JSON.stringify(argv)}`);
    }
  });
});

describe('#5894: checkAncestry against real git', () => {
  function makeRepo(t) {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-5894-'));
    t.after(() => cleanup(cwd));
    const git = (args) => execFileSync('git', args, { cwd, stdio: 'pipe', timeout: GIT_TIMEOUT_MS });
    const commit = (message) => git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-q', '-m', message]);
    const runner = (args) => {
      try {
        git(args);
        return { status: 0 };
      } catch (err) {
        return { status: typeof err.status === 'number' ? err.status : null };
      }
    };
    git(['init', '-q', '-b', 'main']);
    return { git, commit, runner };
  }

  test('a merge commit of main into next restores the ancestry; a plain commit does not', (t) => {
    const { git, commit, runner } = makeRepo(t);
    commit('A');
    git(['branch', 'next']);
    git(['checkout', '-q', 'next']);
    commit('B');
    git(['checkout', '-q', 'main']);
    assert.equal(checkAncestry({ ancestor: 'main', descendant: 'next', git: runner }), ANCESTRY_VERDICT.ANCESTOR);

    commit('C');
    assert.equal(checkAncestry({ ancestor: 'main', descendant: 'next', git: runner }), ANCESTRY_VERDICT.DIVERGED);

    git(['checkout', '-q', 'next']);
    git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'merge', '-q', '-s', 'ours', '--no-ff', '-m', 'm', 'main']);
    assert.equal(checkAncestry({ ancestor: 'main', descendant: 'next', git: runner }), ANCESTRY_VERDICT.ANCESTOR);
  });

  test('a squash-shaped repair (plain commit, no merge parent) stays DIVERGED', (t) => {
    const { git, commit, runner } = makeRepo(t);
    commit('A');
    git(['branch', 'next']);
    commit('C');
    git(['checkout', '-q', 'next']);
    commit('squashed back-merge');
    assert.equal(checkAncestry({ ancestor: 'main', descendant: 'next', git: runner }), ANCESTRY_VERDICT.DIVERGED);
  });
});
