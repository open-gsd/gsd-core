'use strict';

/**
 * `commit_docs` tier resolution in the Config Loader Module (#3587, #5505): the pure
 * `resolveCommitDocsTiers` both `cmdCommit` and the state-contract publisher call, and the
 * `isGitIgnored` probe its ignore tier reads.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fc = require('fast-check');

const { createTempGitProject, cleanup } = require('./helpers.cjs');
const { stubEnv } = require('./helpers/env-guard.cjs');
const { gitOrThrow } = require('./helpers/git-fixture.cjs');
const { isGitIgnored, resolveCommitDocsTiers } = require('../gsd-core/bin/lib/config-loader.cjs');

const git = (cwd, ...args) => gitOrThrow(args, { cwd });
const excludeOf = (cwd) => path.resolve(cwd, git(cwd, 'rev-parse', '--git-path', 'info/exclude').trim());

describe('resolveCommitDocsTiers (#5505)', () => {
  test('resolveCommitDocsTiersProperty', () => {
    fc.assert(fc.property(
      fc.constantFrom(undefined, true, false),
      fc.constantFrom(undefined, true, false, 0, 'x', null),
      fc.boolean(),
      (override, commitDocs, ignored) => {
        let calls = 0;
        const r = resolveCommitDocsTiers(override, commitDocs, () => { calls += 1; return ignored; });
        if (override !== undefined) {
          assert.deepStrictEqual(r, { resolved: override, source: 'phase' });
          assert.strictEqual(calls, 0);
        } else if (!commitDocs) {
          assert.deepStrictEqual(r, { resolved: false, source: 'config' });
          assert.strictEqual(calls, 0);
        } else {
          assert.deepStrictEqual(r, ignored ? { resolved: false, source: 'gitignore' } : { resolved: true, source: 'default' });
          assert.strictEqual(calls, 1);
        }
      },
    ), { seed: 5505 });
  });
});

describe('isGitIgnored (#5505)', () => {
  // #5505: the cwd repo, not an inherited GIT_DIR, decides what is ignored (git hooks export GIT_DIR).
  for (const [name, cwdIgnores, expected] of [['otherRepoIgnoresOnly', false, false], ['cwdRepoIgnoresOnly', true, true]]) {
    test(`isGitIgnoredIgnoresInheritedGitDir:${name}`, (t) => {
      const tmpDir = createTempGitProject();
      const other = createTempGitProject();
      t.after(() => { cleanup(tmpDir); cleanup(other); });
      fs.appendFileSync(excludeOf(cwdIgnores ? tmpDir : other), '.planning\n');
      stubEnv(t, 'GIT_DIR', path.join(other, '.git'));
      assert.strictEqual(isGitIgnored(tmpDir, '.planning'), expected);
    });
  }

  test('aTimedOutCheckIgnoreIsNotCached', (t) => {
    const childProcess = require('node:child_process');
    const tmpDir = createTempGitProject();
    t.after(() => cleanup(tmpDir));
    fs.appendFileSync(excludeOf(tmpDir), '.planning\n');
    const real = childProcess.spawnSync;
    let timeouts = 0;
    t.mock.method(childProcess, 'spawnSync', function (cmd, args, ...rest) {
      if (timeouts === 0 && path.basename(String(cmd)).replace(/\.exe$/, '') === 'git' && args.includes('check-ignore')) {
        timeouts += 1;
        return { status: null, signal: 'SIGTERM', stdout: '', stderr: '', output: null, pid: 0, error: Object.assign(new Error('spawnSync git ETIMEDOUT'), { code: 'ETIMEDOUT' }) };
      }
      return real.call(this, cmd, args, ...rest);
    });
    assert.strictEqual(isGitIgnored(tmpDir, '.planning'), false); // fail open
    assert.strictEqual(timeouts, 1);
    assert.strictEqual(isGitIgnored(tmpDir, '.planning'), true); // the real answer is read, not a cached guess
  });
});
