'use strict';

/**
 * #6216 (ADR-6216): the executor's worktree guards and its plan commit ledger as single
 * `gsd_run query` commands — `executor.guard` and `executor.ledger record|read` — driven
 * through the real gsd-tools dispatcher from a linked worktree whose `.planning/` is
 * untracked (so the project root is the MAIN checkout) and from the main checkout itself.
 *
 * Failing-first: RED until the verbs exist.
 */

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runGsdTools, cleanup } = require('./helpers.cjs');
const { isolatedEnv } = require('./helpers/isolated-env.cjs');
const { GIT_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { gitOrThrow } = require('./helpers/git-fixture.cjs');

const { evaluateGuard, cmdExecutorGuard, GUARD_EXIT_CODE } = require('../gsd-core/bin/lib/executor-guard.cjs');

const GIT_CFG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-6216-gitcfg-'));
const EMPTY_GITCONFIG = path.join(GIT_CFG_DIR, 'gitconfig');
fs.writeFileSync(EMPTY_GITCONFIG, '');
after(() => cleanup(GIT_CFG_DIR));

const GIT_ENV = {
  GIT_CONFIG_GLOBAL: EMPTY_GITCONFIG,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'gsd-test',
  GIT_AUTHOR_EMAIL: 'gsd-test@example.invalid',
  GIT_COMMITTER_NAME: 'gsd-test',
  GIT_COMMITTER_EMAIL: 'gsd-test@example.invalid',
};

function git(args, cwd) {
  return gitOrThrow(args, { cwd, env: { ...process.env, ...GIT_ENV }, timeoutMs: GIT_TIMEOUT_MS }).trim();
}

function write(file, body = '') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

function commitFile(dir, name) {
  write(path.join(dir, name), `${name}\n`);
  git(['add', name], dir);
  git(['commit', '-q', '-m', name], dir);
}

/**
 * A main checkout on `main` whose `.planning/` is untracked, plus a linked worktree on an
 * `agent-` branch that therefore carries no `.planning/` of its own.
 */
function mkFixture(t, { agentBranch = 'agent-a1b2c3' } = {}) {
  const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-6216-')));
  t.after(() => cleanup(tmp));
  const main = path.join(tmp, 'main');
  fs.mkdirSync(main);
  git(['init', '-q', '-b', 'main'], main);
  write(path.join(main, '.gitignore'), '.planning/\n');
  write(path.join(main, '.planning', 'config.json'), '{}\n');
  commitFile(main, 'README.md');
  git(['add', '.gitignore'], main);
  git(['commit', '-q', '-m', 'ignore planning'], main);
  const wt = path.join(tmp, 'wt');
  git(['worktree', 'add', '-q', '-b', agentBranch, wt], main);
  return { tmp, main, wt: fs.realpathSync.native(wt) };
}

function run(args, cwd, tmp) {
  return runGsdTools(['query', ...args], cwd, isolatedEnv({ home: tmp, override: GIT_ENV }));
}

function json(res) {
  return JSON.parse(res.output);
}

function failed(res) {
  return json(res).checks.filter((c) => !c.ok).map((c) => c.name);
}

describe('executor.guard (#6216): verify-only, fails closed with exit 42', () => {
  test('passes in an agent worktree at the expected base', (t) => {
    const { tmp, wt } = mkFixture(t);
    const base = git(['rev-parse', 'HEAD'], wt);
    const res = run(['executor.guard', '--expected-base', base, '--expected-base-alternate', ''], wt, tmp);
    assert.equal(res.exitCode, 0, res.error);
    const out = json(res);
    assert.equal(out.ok, true);
    assert.equal(out.branch, 'agent-a1b2c3');
    assert.equal(out.worktree_root, wt);
    assert.deepEqual(out.checks.map((c) => c.name), ['head-attached', 'not-protected', 'agent-namespace', 'base']);
  });

  test('accepts the alternate base and refuses any other HEAD', (t) => {
    const { tmp, wt } = mkFixture(t);
    const parent = git(['rev-parse', 'HEAD'], wt);
    commitFile(wt, 'docs-only.md');
    const head = git(['rev-parse', 'HEAD'], wt);
    const other = '0'.repeat(40);

    const viaAlternate = run(['executor.guard', '--expected-base', other, '--expected-base-alternate', head], wt, tmp);
    assert.equal(viaAlternate.exitCode, 0, viaAlternate.error);

    const mismatch = run(['executor.guard', '--expected-base', parent, '--expected-base-alternate', ''], wt, tmp);
    assert.equal(mismatch.exitCode, GUARD_EXIT_CODE);
    assert.deepEqual(failed(mismatch), ['base']);
    assert.match(mismatch.error, /FATAL: executor\.guard base: HEAD is [0-9a-f]{40}, expected/);
  });

  test('refuses a protected branch in the main checkout', (t) => {
    const { tmp, main } = mkFixture(t);
    const res = run(['executor.guard'], main, tmp);
    assert.equal(res.exitCode, GUARD_EXIT_CODE);
    assert.deepEqual(failed(res), ['not-protected']);
  });

  test('refuses a detached HEAD', (t) => {
    const { tmp, wt } = mkFixture(t);
    git(['checkout', '-q', '--detach'], wt);
    const res = run(['executor.guard'], wt, tmp);
    assert.equal(res.exitCode, GUARD_EXIT_CODE);
    assert.ok(failed(res).includes('head-attached'));
  });

  test('requires the agent namespace in a linked worktree unless --sequential', (t) => {
    const { tmp, wt } = mkFixture(t, { agentBranch: 'feature/login' });
    const isolated = run(['executor.guard'], wt, tmp);
    assert.equal(isolated.exitCode, GUARD_EXIT_CODE);
    assert.deepEqual(failed(isolated), ['agent-namespace']);

    const sequential = run(['executor.guard', '--sequential'], wt, tmp);
    assert.equal(sequential.exitCode, 0, sequential.error);
    assert.ok(!json(sequential).checks.some((c) => c.name === 'agent-namespace'));
  });

  test('an expected base requires the agent namespace outside a linked worktree too', (t) => {
    const { tmp, main } = mkFixture(t);
    git(['checkout', '-q', '-b', 'feature/x'], main);
    const base = git(['rev-parse', 'HEAD'], main);
    const res = run(['executor.guard', '--expected-base', base], main, tmp);
    assert.equal(res.exitCode, GUARD_EXIT_CODE);
    assert.deepEqual(failed(res), ['agent-namespace']);
  });

  test('--toplevel refuses a cwd that left the expected worktree root', (t) => {
    const { tmp, main, wt } = mkFixture(t);
    const inside = run(['executor.guard', '--toplevel', wt], path.join(wt), tmp);
    assert.equal(inside.exitCode, 0, inside.error);

    git(['checkout', '-q', '-b', 'agent-elsewhere'], main);
    const drifted = run(['executor.guard', '--toplevel', wt, '--sequential'], main, tmp);
    assert.equal(drifted.exitCode, GUARD_EXIT_CODE);
    assert.deepEqual(failed(drifted), ['toplevel']);
  });

  test('--path accepts a not-yet-created file inside the worktree and refuses one outside it', (t) => {
    const { tmp, main, wt } = mkFixture(t);
    const inside = run(['executor.guard', '--path', path.join(wt, 'src', 'new', 'file.ts')], wt, tmp);
    assert.equal(inside.exitCode, 0, inside.error);

    const relative = run(['executor.guard', '--path', 'src/new/file.ts'], wt, tmp);
    assert.equal(relative.exitCode, 0, relative.error);

    const outside = run(['executor.guard', '--path', path.join(main, 'README.md')], wt, tmp);
    assert.equal(outside.exitCode, GUARD_EXIT_CODE);
    assert.deepEqual(failed(outside), ['path']);

    const sibling = run(['executor.guard', '--path', `${wt}-sibling${path.sep}x`], wt, tmp);
    assert.equal(sibling.exitCode, GUARD_EXIT_CODE);
    assert.deepEqual(failed(sibling), ['path']);
  });

  test('changes nothing: HEAD, branch, refs and the working tree are as before', (t) => {
    const { tmp, wt } = mkFixture(t);
    const before = [git(['rev-parse', 'HEAD'], wt), git(['show-ref'], wt), git(['status', '--porcelain', '--ignored'], wt)];
    run(['executor.guard', '--expected-base', '0'.repeat(40)], wt, tmp);
    run(['executor.guard'], wt, tmp);
    const now = [git(['rev-parse', 'HEAD'], wt), git(['show-ref'], wt), git(['status', '--porcelain', '--ignored'], wt)];
    assert.deepEqual(now, before);
  });

  test('an unverifiable base branch counts as protected (#3057)', () => {
    const execGit = (args) => {
      if (args[0] === 'symbolic-ref') return { exitCode: 0, stdout: 'refs/heads/agent-x\n' };
      if (args[0] === 'rev-parse') return { exitCode: 0, stdout: 'a'.repeat(40) + '\n' };
      return { exitCode: 1, stdout: '' };
    };
    const result = evaluateGuard(
      { projectRoot: '/w' },
      { invokedFrom: '/w' },
      { execGit, protectedStatus: () => ({ isProtected: false, verified: false }) },
    );
    assert.equal(result.ok, false);
    assert.deepEqual(result.checks.filter((c) => !c.ok).map((c) => c.name), ['not-protected']);
  });
});

describe('executor.ledger (#6216): the plan base, recorded once in the worktree', () => {
  test('record stores the base under the worktree\'s own .gsd, outside .git, ignored by git', (t) => {
    const { tmp, main, wt } = mkFixture(t);
    const base = git(['rev-parse', 'HEAD'], wt);
    const res = run(['executor.ledger', 'record', '--phase', '02', '--plan', '04'], wt, tmp);
    assert.equal(res.exitCode, 0, res.error);
    const out = json(res);
    assert.equal(out.recorded, true);
    assert.equal(out.plan_head_before, base);
    assert.equal(out.path, path.join(wt, '.gsd', 'executor-ledger', '02+04.json'));
    assert.equal(JSON.parse(fs.readFileSync(out.path, 'utf8')).branch, 'agent-a1b2c3');

    assert.equal(git(['status', '--porcelain'], wt), '');
    assert.ok(!fs.existsSync(path.join(main, '.gsd')), 'the main checkout is not written');
    const gitDir = git(['rev-parse', '--absolute-git-dir'], wt);
    assert.ok(!fs.readdirSync(gitDir).some((n) => n.startsWith('gsd-plan-head-before')));
  });

  test('a second record keeps the first base; read measures the plan\'s commits', (t) => {
    const { tmp, wt } = mkFixture(t);
    const base = git(['rev-parse', 'HEAD'], wt);
    run(['executor.ledger', 'record', '--phase', '02', '--plan', '04'], wt, tmp);
    commitFile(wt, 'one.txt');
    const again = run(['executor.ledger', 'record', '--phase', '02', '--plan', '04'], wt, tmp);
    assert.equal(json(again).recorded, false);
    assert.equal(json(again).plan_head_before, base);
    commitFile(wt, 'two.txt');

    const read = run(['executor.ledger', 'read', '--phase', '02', '--plan', '04'], wt, tmp);
    assert.equal(read.exitCode, 0, read.error);
    assert.deepEqual(
      { ...json(read), path: undefined },
      { plan_head_before: base, plan_head_after: git(['rev-parse', 'HEAD'], wt), commits: 2, path: undefined },
    );
    const picked = run(['executor.ledger', 'read', '--phase', '02', '--plan', '04', '--pick', 'commits'], wt, tmp);
    assert.equal(picked.output.trim(), '2');
  });

  test('plans are recorded apart', (t) => {
    const { tmp, wt } = mkFixture(t);
    run(['executor.ledger', 'record', '--phase', '02', '--plan', '01'], wt, tmp);
    commitFile(wt, 'plan-01.txt');
    run(['executor.ledger', 'record', '--phase', '02', '--plan', '02'], wt, tmp);
    commitFile(wt, 'plan-02.txt');
    const first = run(['executor.ledger', 'read', '--phase', '02', '--plan', '01', '--pick', 'commits'], wt, tmp);
    const second = run(['executor.ledger', 'read', '--phase', '02', '--plan', '02', '--pick', 'commits'], wt, tmp);
    assert.equal(first.output.trim(), '2');
    assert.equal(second.output.trim(), '1');
  });

  test('read fails when no record exists', (t) => {
    const { tmp, wt } = mkFixture(t);
    const res = run(['executor.ledger', 'read', '--phase', '02', '--plan', '04'], wt, tmp);
    assert.equal(res.exitCode, 1);
    assert.match(res.error, /no ledger record for 02 04/);
  });

  test('read fails when the recorded base is not an ancestor of HEAD', (t) => {
    const { tmp, wt } = mkFixture(t);
    commitFile(wt, 'side.txt');
    run(['executor.ledger', 'record', '--phase', '02', '--plan', '04'], wt, tmp);
    git(['reset', '-q', '--hard', 'HEAD~1'], wt);
    commitFile(wt, 'other.txt');
    const res = run(['executor.ledger', 'read', '--phase', '02', '--plan', '04'], wt, tmp);
    assert.equal(res.exitCode, 1);
    assert.match(res.error, /is not an ancestor of HEAD/);
  });

  test('refuses phase and plan ids that are not plain names, and unknown actions', (t) => {
    const { tmp, wt } = mkFixture(t);
    for (const phase of ['../x', '', 'a/b', '.hidden']) {
      const res = run(['executor.ledger', 'record', '--phase', phase, '--plan', '01'], wt, tmp);
      assert.notEqual(res.exitCode, 0, `phase ${JSON.stringify(phase)} must be refused`);
    }
    assert.ok(!fs.existsSync(path.join(wt, '.gsd', 'executor-ledger')));
    const unknown = run(['executor.ledger', 'write', '--phase', '02', '--plan', '01'], wt, tmp);
    assert.notEqual(unknown.exitCode, 0);
    assert.match(unknown.error, /Available: record, read/);
  });
});

/**
 * Behaviours the replaced shell guards were tested for (by extracting the bash from the markdown
 * and running it against mocked `git` / `gsd_run`), re-expressed against the real verb in real
 * git fixtures. Origins: tests/executor-sequential-linked-worktree.test.cjs (#4799),
 * tests/git-base-branch.test.cjs § #3819, tests/worktree-cleanup.test.cjs § #2924.
 */
describe('#4799 / #3819 / #2924 behaviours, now held by executor.guard', () => {
  function writeConfig(main, config) {
    write(path.join(main, '.planning', 'config.json'), `${JSON.stringify(config)}\n`);
  }

  /** A further linked worktree of `main` on `branch`, created from `main`'s HEAD. */
  function addWorktree(tmp, main, branch) {
    const dir = path.join(tmp, `wt-${branch.replace(/[^A-Za-z0-9]/g, '_')}`);
    git(['worktree', 'add', '-q', '-b', branch, dir], main);
    return fs.realpathSync.native(dir);
  }

  // ── #4799: the allow-list follows the dispatch, not the physical worktree ──

  test('#4799 sequential dispatch in a linked worktree still refuses a protected branch', (t) => {
    const { tmp, main } = mkFixture(t);
    writeConfig(main, { git: { protected_branches: ['release/1.0'] } });
    const wt = addWorktree(tmp, main, 'release/1.0');
    const res = run(['executor.guard', '--sequential'], wt, tmp);
    assert.equal(res.exitCode, GUARD_EXIT_CODE);
    assert.deepEqual(failed(res), ['not-protected']);
    assert.match(res.error, /FATAL: executor\.guard not-protected: 'release\/1\.0' is a protected\/default branch/);
  });

  for (const [branch, passes] of [
    ['agent-', false],
    ['agent-x', true],
    ['xagent-1', false],
    ['worktree-agent-7', true],
    ['worktree-wf_abc', true],
  ]) {
    test(`#4799 allow-list boundary: isolated worktree on '${branch}' ${passes ? 'passes' : 'is refused'}`, (t) => {
      const { tmp, wt } = mkFixture(t, { agentBranch: branch });
      const preCommit = run(['executor.guard'], wt, tmp);
      const spawn = run(['executor.guard', '--expected-base', git(['rev-parse', 'HEAD'], wt)], wt, tmp);
      for (const res of [preCommit, spawn]) {
        if (passes) {
          assert.equal(res.exitCode, 0, res.error);
        } else {
          assert.equal(res.exitCode, GUARD_EXIT_CODE);
          assert.deepEqual(failed(res), ['agent-namespace']);
        }
      }
    });
  }

  test('#4799 --path given alone on a feature/* linked worktree runs only the path check, with and without --sequential', (t) => {
    const { tmp, main, wt } = mkFixture(t, { agentBranch: 'feature/phase-48' });
    const inside = path.join(wt, 'src', 'new', 'file.ts');
    for (const extra of [[], ['--sequential']]) {
      const res = run(['executor.guard', '--path', inside, ...extra], wt, tmp);
      assert.equal(res.exitCode, 0, `${JSON.stringify(extra)}: ${res.error}`);
      assert.deepEqual(json(res).checks.map((c) => c.name), ['path']);

      const outside = run(['executor.guard', '--path', path.join(main, 'README.md'), ...extra], wt, tmp);
      assert.equal(outside.exitCode, GUARD_EXIT_CODE);
      assert.deepEqual(json(outside).checks.map((c) => c.name), ['path']);
      assert.deepEqual(failed(outside), ['path']);
    }
  });

  test('#4799 --toplevel on a feature/* linked worktree is the pre-commit check: the namespace applies unless --sequential, also beside --path', (t) => {
    const { tmp, wt } = mkFixture(t, { agentBranch: 'feature/phase-48' });
    const inside = path.join(wt, 'src', 'new', 'file.ts');
    for (const flags of [['--toplevel', wt], ['--toplevel', wt, '--path', inside]]) {
      const isolated = run(['executor.guard', ...flags], wt, tmp);
      assert.equal(isolated.exitCode, GUARD_EXIT_CODE, JSON.stringify(flags));
      assert.deepEqual(failed(isolated), ['agent-namespace'], JSON.stringify(flags));

      const sequential = run(['executor.guard', ...flags, '--sequential'], wt, tmp);
      assert.equal(sequential.exitCode, 0, sequential.error);
      assert.deepEqual(
        json(sequential).checks.map((c) => c.name),
        ['head-attached', 'not-protected', 'toplevel', ...(flags.includes('--path') ? ['path'] : [])],
      );
    }
  });

  test('--path given alone reports the path on a protected branch and on a detached HEAD; step 0 still refuses both', (t) => {
    const { tmp, main } = mkFixture(t);
    const target = path.join(main, 'src', 'x.ts');
    const onMain = run(['executor.guard', '--path', target], main, tmp);
    assert.equal(onMain.exitCode, 0, onMain.error);
    assert.deepEqual(json(onMain).checks.map((c) => c.name), ['path']);
    assert.deepEqual(failed(run(['executor.guard'], main, tmp)), ['not-protected']);

    git(['checkout', '-q', '--detach'], main);
    const detached = run(['executor.guard', '--path', target], main, tmp);
    assert.equal(detached.exitCode, 0, detached.error);
    assert.ok(failed(run(['executor.guard'], main, tmp)).includes('head-attached'));
  });

  test('--path beside an empty --expected-base-alternate is --path alone; beside a non-empty one the branch checks run and base fails', (t) => {
    const { tmp, wt } = mkFixture(t, { agentBranch: 'feature/phase-48' });
    const inside = path.join(wt, 'src', 'x.ts');
    const empty = run(['executor.guard', '--path', inside, '--expected-base-alternate', ''], wt, tmp);
    assert.equal(empty.exitCode, 0, empty.error);
    assert.deepEqual(json(empty).checks.map((c) => c.name), ['path']);

    const named = run(['executor.guard', '--path', inside, '--expected-base-alternate', git(['rev-parse', 'HEAD'], wt)], wt, tmp);
    assert.equal(named.exitCode, GUARD_EXIT_CODE);
    assert.deepEqual(json(named).checks.map((c) => c.name), ['head-attached', 'not-protected', 'agent-namespace', 'base', 'path']);
    assert.deepEqual(failed(named), ['agent-namespace', 'base']);
  });

  test('#4799 a main checkout is not subject to the allow-list in either mode', (t) => {
    const { tmp, main } = mkFixture(t);
    git(['checkout', '-q', '-b', 'feature/phase-48'], main);
    for (const extra of [[], ['--sequential']]) {
      const res = run(['executor.guard', ...extra], main, tmp);
      assert.equal(res.exitCode, 0, res.error);
      assert.ok(!json(res).checks.some((c) => c.name === 'agent-namespace'), `no allow-list check with ${JSON.stringify(extra)}`);
    }
  });

  // ── #3819: the pre-commit protected-branch guard ──

  test('#3819 non-worktree on a branch the resolver reports protected (git.protected_branches) halts', (t) => {
    const { tmp, main } = mkFixture(t);
    writeConfig(main, { git: { protected_branches: ['feature-x'] } });
    git(['checkout', '-q', '-b', 'feature-x'], main);
    const res = run(['executor.guard'], main, tmp);
    assert.equal(res.exitCode, GUARD_EXIT_CODE);
    assert.deepEqual(failed(res), ['not-protected']);
  });

  test('#3819 non-worktree on an unprotected branch passes', (t) => {
    const { tmp, main } = mkFixture(t);
    git(['checkout', '-q', '-b', 'feature-x'], main);
    const res = run(['executor.guard'], main, tmp);
    assert.equal(res.exitCode, 0, res.error);
    assert.equal(json(res).ok, true);
  });

  test('#3819 worktree on a protected branch halts on the protected check, reported before the allow-list check', (t) => {
    const { tmp, main } = mkFixture(t);
    writeConfig(main, { git: { protected_branches: ['release/1.0'] } });
    const wt = addWorktree(tmp, main, 'release/1.0');
    const res = run(['executor.guard'], wt, tmp);
    assert.equal(res.exitCode, GUARD_EXIT_CODE);
    assert.deepEqual(failed(res), ['not-protected', 'agent-namespace']);
  });

  test('#3819 worktree on a protected branch inside the agent namespace still halts (protection does not depend on the allow-list)', (t) => {
    const { tmp, main } = mkFixture(t);
    writeConfig(main, { git: { protected_branches: ['agent-hot'] } });
    const wt = addWorktree(tmp, main, 'agent-hot');
    const res = run(['executor.guard'], wt, tmp);
    assert.equal(res.exitCode, GUARD_EXIT_CODE);
    assert.deepEqual(failed(res), ['not-protected']);
  });

  test('#3819 detached HEAD in a main checkout halts', (t) => {
    const { tmp, main } = mkFixture(t);
    git(['checkout', '-q', '--detach'], main);
    const res = run(['executor.guard'], main, tmp);
    assert.equal(res.exitCode, GUARD_EXIT_CODE);
    assert.ok(failed(res).includes('head-attached'));
    assert.match(res.error, /FATAL: executor\.guard head-attached: HEAD is detached/);
  });

  test('#3819 git.allow_default_branch_commits lets a main checkout commit on the default branch; a listed branch stays protected', (t) => {
    const { tmp, main } = mkFixture(t);
    writeConfig(main, { git: { allow_default_branch_commits: true } });
    const allowed = run(['executor.guard'], main, tmp);
    assert.equal(allowed.exitCode, 0, allowed.error);

    writeConfig(main, { git: { allow_default_branch_commits: true, protected_branches: ['main'] } });
    const listed = run(['executor.guard'], main, tmp);
    assert.equal(listed.exitCode, GUARD_EXIT_CODE);
    assert.deepEqual(failed(listed), ['not-protected']);
  });

  // ── #2924: the spawn-time worktree_branch_check ──

  test('#2924 spawn-time guard refuses a detached HEAD at the expected base', (t) => {
    const { tmp, wt } = mkFixture(t);
    const base = git(['rev-parse', 'HEAD'], wt);
    git(['checkout', '-q', '--detach'], wt);
    const res = run(['executor.guard', '--expected-base', base, '--expected-base-alternate', ''], wt, tmp);
    assert.equal(res.exitCode, GUARD_EXIT_CODE);
    assert.ok(failed(res).includes('head-attached'));
    assert.ok(failed(res).includes('agent-namespace'));
    assert.ok(!failed(res).includes('base'), 'HEAD is still at the expected base');
  });

  test('#2924 spawn-time guard refuses main (the default branch) as the agent branch', (t) => {
    const { tmp, main } = mkFixture(t);
    const base = git(['rev-parse', 'HEAD'], main);
    const res = run(['executor.guard', '--expected-base', base, '--expected-base-alternate', ''], main, tmp);
    assert.equal(res.exitCode, GUARD_EXIT_CODE);
    assert.deepEqual(failed(res), ['not-protected', 'agent-namespace']);
  });

  for (const branch of ['master', 'develop', 'trunk', 'release/x']) {
    test(`#2924 spawn-time guard refuses '${branch}' as the agent branch`, (t) => {
      const { tmp, main } = mkFixture(t);
      const wt = addWorktree(tmp, main, branch);
      const base = git(['rev-parse', 'HEAD'], wt);
      const res = run(['executor.guard', '--expected-base', base, '--expected-base-alternate', ''], wt, tmp);
      assert.equal(res.exitCode, GUARD_EXIT_CODE);
      assert.deepEqual(failed(res), ['not-protected', 'agent-namespace']);
      assert.match(res.error, /is a protected branch/);
      assert.match(res.error, /is not in the agent-\* \/ worktree-agent-\* \/ worktree-wf_\* namespace/);
    });
  }
});

describe('#6216 fix review: layouts, path resolution and ledger confinement', () => {
  function unprotected(t, dir, branch) {
    git(['checkout', '-q', '-b', branch], dir);
    return dir;
  }

  test('a --separate-git-dir checkout (.git is a file) requires the agent namespace unless --sequential', (t) => {
    const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-6216-sep-')));
    t.after(() => cleanup(tmp));
    const repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo);
    git(['init', '-q', '-b', 'main', '--separate-git-dir', path.join(tmp, 'repo.git')], repo);
    commitFile(repo, 'README.md');
    unprotected(t, repo, 'feature/login');
    assert.ok(fs.lstatSync(path.join(repo, '.git')).isFile());
    const isolated = run(['executor.guard'], repo, tmp);
    assert.equal(isolated.exitCode, GUARD_EXIT_CODE);
    assert.deepEqual(failed(isolated), ['agent-namespace']);
    assert.equal(run(['executor.guard', '--sequential'], repo, tmp).exitCode, 0);
  });

  test("a bare repository's first worktree requires the agent namespace unless --sequential", (t) => {
    const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-6216-bare-')));
    t.after(() => cleanup(tmp));
    const seed = path.join(tmp, 'seed');
    fs.mkdirSync(seed);
    git(['init', '-q', '-b', 'main'], seed);
    commitFile(seed, 'README.md');
    git(['clone', '-q', '--bare', seed, path.join(tmp, 'bare.git')], tmp);
    const first = path.join(tmp, 'first');
    git(['worktree', 'add', '-q', '-b', 'feature/first', first, 'main'], path.join(tmp, 'bare.git'));
    const isolated = run(['executor.guard'], first, tmp);
    assert.equal(isolated.exitCode, GUARD_EXIT_CODE);
    assert.deepEqual(failed(isolated), ['agent-namespace']);
    assert.equal(run(['executor.guard', '--sequential'], first, tmp).exitCode, 0);
  });

  test('--path refuses a dangling link pointing outside, and a path below a regular file', (t) => {
    const { tmp, wt } = mkFixture(t);
    const outside = path.join(tmp, 'outside');
    fs.mkdirSync(outside);
    fs.symlinkSync(path.join(outside, 'not-yet.txt'), path.join(wt, 'dangling'));
    const dangling = run(['executor.guard', '--path', path.join(wt, 'dangling')], wt, tmp);
    assert.equal(dangling.exitCode, GUARD_EXIT_CODE);
    assert.deepEqual(failed(dangling), ['path']);

    write(path.join(wt, 'regular.txt'), 'x\n');
    const below = run(['executor.guard', '--path', 'regular.txt/child'], wt, tmp);
    assert.equal(below.exitCode, GUARD_EXIT_CODE);
    assert.deepEqual(failed(below), ['path']);
  });

  test('--path resolves a link before its .. segment, and reads ..cache as a name', (t) => {
    const { tmp, wt } = mkFixture(t);
    const outside = path.join(tmp, 'outside', 'deep');
    fs.mkdirSync(outside, { recursive: true });
    fs.symlinkSync(outside, path.join(wt, 'linkdir'));
    const viaLink = run(['executor.guard', '--path', 'linkdir/../r.txt'], wt, tmp);
    assert.equal(viaLink.exitCode, GUARD_EXIT_CODE);
    assert.deepEqual(failed(viaLink), ['path']);

    const dotted = run(['executor.guard', '--path', '..cache/new.txt'], wt, tmp);
    assert.equal(dotted.exitCode, 0, dotted.error);
  });

  test('record refuses a linked .gsd/executor-ledger and writes nothing through it', (t) => {
    const { tmp, wt } = mkFixture(t);
    const escaped = path.join(tmp, 'escaped');
    fs.mkdirSync(escaped);
    fs.mkdirSync(path.join(wt, '.gsd'));
    fs.symlinkSync(escaped, path.join(wt, '.gsd', 'executor-ledger'));
    const res = run(['executor.ledger', 'record', '--phase', '01', '--plan', '01'], wt, tmp);
    assert.equal(res.exitCode, 1);
    assert.match(res.error, /must be a real directory/);
    assert.deepEqual(fs.readdirSync(escaped), []);
  });

  test('read refuses a record that is a link', (t) => {
    const { tmp, wt } = mkFixture(t);
    run(['executor.ledger', 'record', '--phase', '01', '--plan', '01'], wt, tmp);
    const dir = path.join(wt, '.gsd', 'executor-ledger');
    const elsewhere = path.join(tmp, 'elsewhere.json');
    fs.copyFileSync(path.join(dir, '01+01.json'), elsewhere);
    fs.unlinkSync(path.join(dir, '01+01.json'));
    fs.symlinkSync(elsewhere, path.join(dir, '01+01.json'));
    const res = run(['executor.ledger', 'read', '--phase', '01', '--plan', '01'], wt, tmp);
    assert.equal(res.exitCode, 1);
    assert.match(res.error, /must be a regular file/);
  });

  test('record leaves a tracked .gsd/.gitignore untouched and stays out of git status, even under a negation', (t) => {
    const { tmp, wt } = mkFixture(t);
    write(path.join(wt, '.gsd', '.gitignore'), '!/executor-ledger/\n');
    git(['add', '.gsd/.gitignore'], wt);
    git(['commit', '-q', '-m', 'track gsd ignore'], wt);
    const res = run(['executor.ledger', 'record', '--phase', '02', '--plan', '05'], wt, tmp);
    assert.equal(res.exitCode, 0, res.error);
    assert.equal(git(['status', '--porcelain', '--untracked-files=all'], wt), '');
  });

  test('distinct phase/plan pairs never share a record', (t) => {
    const { tmp, wt } = mkFixture(t);
    const first = run(['executor.ledger', 'record', '--phase', 'a-b', '--plan', 'c'], wt, tmp);
    commitFile(wt, 'between.txt');
    const second = run(['executor.ledger', 'record', '--phase', 'a', '--plan', 'b-c'], wt, tmp);
    assert.equal(json(first).recorded, true);
    assert.equal(json(second).recorded, true);
    assert.notEqual(json(first).plan_head_before, json(second).plan_head_before);
  });

  test('read refuses a recorded base that is not a commit (a tag object)', (t) => {
    const { tmp, wt } = mkFixture(t);
    run(['executor.ledger', 'record', '--phase', '01', '--plan', '01'], wt, tmp);
    git(['tag', '-a', '-m', 'annotated', 'v-test'], wt);
    const tagObject = git(['rev-parse', 'v-test'], wt);
    const file = path.join(wt, '.gsd', 'executor-ledger', '01+01.json');
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...record, plan_head_before: tagObject }));
    const res = run(['executor.ledger', 'read', '--phase', '01', '--plan', '01'], wt, tmp);
    assert.equal(res.exitCode, 1);
    assert.match(res.error, /is not a commit/);
  });

  test('the base-branch resolver is not consulted at spawn time or on a detached HEAD', () => {
    const commit = 'a'.repeat(40);
    const layout = (args) => {
      if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return { exitCode: 0, stdout: '/w\n' };
      if (args[0] === 'rev-parse' && args[1] === '--absolute-git-dir') return { exitCode: 0, stdout: '/w/.git\n/w/.git\n' };
      if (args[0] === 'rev-parse') return { exitCode: 0, stdout: `${commit}\n` };
      return null;
    };
    const attachedGit = (args) => layout(args) ?? (args[0] === 'symbolic-ref' ? { exitCode: 0, stdout: 'refs/heads/agent-x\n' } : { exitCode: 1, stdout: '' });
    const detachedGit = (args) => layout(args) ?? { exitCode: 1, stdout: '' };
    const protectedStatus = () => { throw new Error('resolver must not be called'); };
    const deps = (execGit) => ({ execGit, protectedStatus, realpath: (p) => p });

    const spawn = evaluateGuard({ projectRoot: '/w' }, { invokedFrom: '/w', expectedBase: commit }, deps(attachedGit));
    assert.equal(spawn.ok, true, JSON.stringify(spawn.checks));

    const detached = evaluateGuard({ projectRoot: '/w' }, { invokedFrom: '/w' }, deps(detachedGit));
    assert.deepEqual(detached.checks.filter((c) => !c.ok).map((c) => c.name), ['head-attached', 'not-protected']);
    assert.equal(detached.checks.find((c) => c.name === 'not-protected').detail, 'no branch to test');
  });
});

describe('#6216 fix review, pass 2: separators, layouts, ledger ignore file, fail-closed exit', () => {
  test('--path on POSIX treats a backslash as part of a name, so a link named a\\b is followed', { skip: process.platform === 'win32' }, (t) => {
    const { tmp, wt } = mkFixture(t);
    const outside = path.join(tmp, 'outside');
    fs.mkdirSync(outside);
    write(path.join(outside, 'secret.txt'), 'x\n');
    fs.symlinkSync(outside, path.join(wt, 'a\\b'));
    const res = run(['executor.guard', '--path', 'a\\b/secret.txt'], wt, tmp);
    assert.equal(res.exitCode, GUARD_EXIT_CODE);
    assert.deepEqual(failed(res), ['path']);
  });

  test('--path refuses `.` and a trailing separator below a regular file', (t) => {
    const { tmp, wt } = mkFixture(t);
    write(path.join(wt, 'regular.txt'), 'x\n');
    for (const p of ['regular.txt/.', 'regular.txt/']) {
      const res = run(['executor.guard', '--path', p], wt, tmp);
      assert.equal(res.exitCode, GUARD_EXIT_CODE, p);
      assert.deepEqual(failed(res), ['path'], p);
    }
    fs.mkdirSync(path.join(wt, 'sub'));
    assert.equal(run(['executor.guard', '--path', 'sub/.'], wt, tmp).exitCode, 0);
  });

  test('a .git that is a link to a gitdir file still requires the agent namespace', (t) => {
    const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-6216-gitlink-')));
    t.after(() => cleanup(tmp));
    const repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo);
    git(['init', '-q', '-b', 'main', '--separate-git-dir', path.join(tmp, 'repo.git')], repo);
    commitFile(repo, 'README.md');
    git(['checkout', '-q', '-b', 'feature/x'], repo);
    fs.renameSync(path.join(repo, '.git'), path.join(tmp, 'gitfile'));
    fs.symlinkSync(path.join(tmp, 'gitfile'), path.join(repo, '.git'));
    const res = run(['executor.guard'], repo, tmp);
    assert.equal(res.exitCode, GUARD_EXIT_CODE);
    assert.deepEqual(failed(res), ['agent-namespace']);
  });

  test('record refuses an executor-ledger/.gitignore that does not ignore everything', (t) => {
    const { tmp, wt } = mkFixture(t);
    write(path.join(wt, '.gsd', 'executor-ledger', '.gitignore'), '');
    const res = run(['executor.ledger', 'record', '--phase', '01', '--plan', '01'], wt, tmp);
    assert.equal(res.exitCode, 1);
    assert.match(res.error, /must be a regular file that ignores/);
  });

  test('an unreadable git layout requires the agent namespace', () => {
    const execGit = (args) => {
      if (args[1] === '--show-toplevel') return { exitCode: 0, stdout: '/w\n' };
      if (args[1] === '--absolute-git-dir') return { exitCode: 128, stdout: '' };
      if (args[0] === 'symbolic-ref') return { exitCode: 0, stdout: 'refs/heads/feature/x\n' };
      if (args[0] === 'rev-parse') return { exitCode: 0, stdout: `${'b'.repeat(40)}\n` };
      return { exitCode: 1, stdout: '' };
    };
    const result = evaluateGuard({ projectRoot: '/w' }, { invokedFrom: '/w' }, {
      execGit,
      protectedStatus: () => ({ isProtected: false, verified: true }),
      realpath: (p) => p,
    });
    assert.deepEqual(result.checks.filter((c) => !c.ok).map((c) => c.name), ['agent-namespace']);
  });

  test('a check that throws exits 42, not 1', () => {
    const lines = [];
    assert.throws(
      () => cmdExecutorGuard({ projectRoot: '/w' }, { invokedFrom: '/w', path: 42 }, false, {
        execGit: () => ({ exitCode: 0, stdout: '/w\n' }),
        realpath: (p) => p,
        writeDiagnostic: (l) => lines.push(l),
      }),
      (err) => err && err.code === GUARD_EXIT_CODE,
    );
    assert.match(lines.join(''), /FATAL: executor\.guard: the checks could not run/);
  });

  test('a git dir that is not the common dir requires the agent namespace, with no .git file', () => {
    const execGit = (args) => {
      if (args[1] === '--show-toplevel') return { exitCode: 0, stdout: '/nonexistent-6216/w\n' };
      if (args[1] === '--absolute-git-dir') return { exitCode: 0, stdout: '/g/worktrees/w\n/g\n' };
      if (args[0] === 'symbolic-ref') return { exitCode: 0, stdout: 'refs/heads/feature/x\n' };
      if (args[0] === 'rev-parse') return { exitCode: 0, stdout: `${'c'.repeat(40)}\n` };
      return { exitCode: 1, stdout: '' };
    };
    const result = evaluateGuard({ projectRoot: '/w' }, { invokedFrom: '/w' }, {
      execGit,
      protectedStatus: () => ({ isProtected: false, verified: true }),
      realpath: (p) => p,
    });
    assert.deepEqual(result.checks.filter((c) => !c.ok).map((c) => c.name), ['agent-namespace']);
  });

  test('--expected-base-alternate without --expected-base is refused', (t) => {
    const { tmp, wt } = mkFixture(t);
    const res = run(['executor.guard', '--expected-base-alternate', git(['rev-parse', 'HEAD'], wt)], wt, tmp);
    assert.equal(res.exitCode, GUARD_EXIT_CODE);
    assert.deepEqual(failed(res), ['base']);
  });

  test('record refuses a linked .gsd', (t) => {
    const { tmp, wt } = mkFixture(t);
    const escaped = path.join(tmp, 'escaped-gsd');
    fs.mkdirSync(escaped);
    fs.symlinkSync(escaped, path.join(wt, '.gsd'));
    const res = run(['executor.ledger', 'record', '--phase', '01', '--plan', '01'], wt, tmp);
    assert.equal(res.exitCode, 1);
    assert.match(res.error, /must be a real directory/);
    assert.deepEqual(fs.readdirSync(escaped), []);
  });

  test("read refuses a record whose own phase and plan are another plan's", (t) => {
    const { tmp, wt } = mkFixture(t);
    run(['executor.ledger', 'record', '--phase', '01', '--plan', '01'], wt, tmp);
    const file = path.join(wt, '.gsd', 'executor-ledger', '01+01.json');
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...record, plan: '02' }));
    const res = run(['executor.ledger', 'read', '--phase', '01', '--plan', '01'], wt, tmp);
    assert.equal(res.exitCode, 1);
    assert.match(res.error, /is not this plan's ledger record/);
  });
});
