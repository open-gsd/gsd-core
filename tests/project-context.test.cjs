'use strict';

/**
 * #6043 (Phase 1 of #4908, ADR-4908 §1-§3): resolveProjectContext is the only
 * root resolver. Failing-first suite: every test here is RED until
 * src/project-context.cts (gsd-core/bin/lib/project-context.cjs) exists.
 *
 * Fixtures are real `git init` / `git worktree add` / `git init --bare`
 * repositories in mkdtemp dirs (realpath'd so macOS /var -> /private/var never
 * skews an equality), cleaned with t.after. IO / git failure is injected via
 * deps.execGit, never chmod.
 */

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const fc = require('fast-check');
const { cleanup } = require('./helpers.cjs');
const { GIT_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { gitOrThrow } = require('./helpers/git-fixture.cjs');

const {
  resolveProjectContext,
  legacyDispatchCwd,
} = require('../gsd-core/bin/lib/project-context.cjs');
const shellProjection = require('../gsd-core/bin/lib/shell-command-projection.cjs');

const GIT_CFG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-6043-gitcfg-'));
const EMPTY_GITCONFIG = path.join(GIT_CFG_DIR, 'gitconfig');
fs.writeFileSync(EMPTY_GITCONFIG, '');
after(() => cleanup(GIT_CFG_DIR));

const GIT_ENV = {
  // os.devNull is \\.\nul on win32, which git cannot open as a config file.
  GIT_CONFIG_GLOBAL: EMPTY_GITCONFIG,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'gsd-test',
  GIT_AUTHOR_EMAIL: 'gsd-test@example.invalid',
  GIT_COMMITTER_NAME: 'gsd-test',
  GIT_COMMITTER_EMAIL: 'gsd-test@example.invalid',
};

function git(args, cwd) {
  return gitOrThrow(args, {
    cwd,
    env: { ...process.env, ...GIT_ENV },
    timeoutMs: GIT_TIMEOUT_MS,
  }).trim();
}

function mkTmp(t, prefix = 'gsd-6043-') {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => cleanup(dir));
  return dir;
}

function real(p) {
  return fs.realpathSync.native(p);
}

function write(file, body = '') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

/** A main checkout with one commit; `planning` tracks a .planning/ in it. */
function mkRepo(dir, { planning = false } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  git(['init', '-q', '-b', 'main'], dir);
  write(path.join(dir, 'README.md'), '# fixture\n');
  if (planning) write(path.join(dir, '.planning', 'PROJECT.md'), '# project\n');
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', 'init'], dir);
  return dir;
}

function addWorktree(main, wtDir, branch) {
  git(['worktree', 'add', '-q', '-b', branch, wtDir], main);
  return fs.realpathSync.native(wtDir);
}

function subdir(root, depth) {
  const parts = Array.from({ length: depth }, (_, i) => `d${i + 1}`);
  const dir = path.join(root, ...parts);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const TIMED_OUT = Object.freeze({
  exitCode: null, stdout: '', stderr: '', signal: 'SIGTERM', error: null, timedOut: true,
});

describe('project-context: main checkout', () => {
  test('project-context: main checkout root', (t) => {
    const root = real(mkRepo(path.join(mkTmp(t), 'main'), { planning: true }));
    const ctx = resolveProjectContext(root);
    assert.equal(ctx.projectRoot, root);
    assert.equal(ctx.worktreeRoot, root);
    assert.equal(ctx.repoRoot, root);
    assert.equal(ctx.planningRoot, real(path.join(root, '.planning')));
    assert.equal(ctx.gitCommonDir, path.join(root, '.git'));
    assert.equal(ctx.isLinkedWorktree, false);
    assert.equal(ctx.provenance.source, 'ancestor');
    assert.equal(ctx.provenance.reason, 'ok');
    assert.equal(ctx.provenance.degraded, false);
    assert.deepEqual(ctx.provenance.warnings, []);
    assert.equal(Object.isFrozen(ctx), true, 'ProjectContext is frozen');
  });

  test('project-context: main subdir', (t) => {
    const root = real(mkRepo(path.join(mkTmp(t), 'main'), { planning: true }));
    for (const depth of [1, 3]) {
      const start = subdir(root, depth);
      const ctx = resolveProjectContext(start);
      assert.equal(ctx.projectRoot, root, `depth ${depth}`);
      assert.equal(ctx.worktreeRoot, root, `depth ${depth}`);
      assert.equal(ctx.repoRoot, root, `depth ${depth}`);
      assert.equal(ctx.isLinkedWorktree, false, `depth ${depth}`);
      assert.equal(ctx.provenance.source, 'ancestor', `depth ${depth}`);
    }
  });
});

describe('project-context: linked worktree', () => {
  test('project-context: linked worktree root', (t) => {
    const main = real(mkRepo(path.join(mkTmp(t), 'main'), { planning: true }));
    const wt = addWorktree(main, path.join(path.dirname(main), 'wt'), 'feat-a');
    const ctx = resolveProjectContext(wt);
    assert.equal(ctx.projectRoot, wt);
    assert.equal(ctx.worktreeRoot, wt);
    assert.equal(ctx.repoRoot, main);
    assert.equal(ctx.gitCommonDir, path.join(main, '.git'));
    assert.equal(ctx.isLinkedWorktree, true);
    assert.equal(ctx.provenance.source, 'ancestor');
  });

  test('project-context: linked worktree subdirectory (#4885)', (t) => {
    const main = real(mkRepo(path.join(mkTmp(t), 'main'), { planning: true }));
    const wt = addWorktree(main, path.join(path.dirname(main), 'wt'), 'feat-a');
    for (const depth of [1, 2, 3]) {
      const ctx = resolveProjectContext(subdir(wt, depth));
      assert.equal(ctx.projectRoot, wt, `depth ${depth}`);
      assert.equal(ctx.worktreeRoot, wt, `depth ${depth}`);
      assert.equal(ctx.repoRoot, main, `depth ${depth}`);
      assert.equal(ctx.isLinkedWorktree, true, `depth ${depth}`);
    }
  });

  test('project-context: worktree without planning falls back to main checkout', (t) => {
    // The worktree is cut BEFORE .planning exists, so only the main checkout has it.
    const main = real(mkRepo(path.join(mkTmp(t), 'main')));
    const wt = addWorktree(main, path.join(path.dirname(main), 'wt'), 'feat-a');
    write(path.join(main, '.planning', 'config.json'), '{}');
    const ctx = resolveProjectContext(subdir(wt, 2));
    assert.equal(ctx.projectRoot, main);
    assert.equal(ctx.planningRoot, real(path.join(main, '.planning')));
    assert.equal(ctx.worktreeRoot, wt);
    assert.equal(ctx.repoRoot, main);
    assert.equal(ctx.isLinkedWorktree, true);
    assert.equal(ctx.provenance.source, 'main-checkout');
  });
});

describe('project-context: planning store', () => {
  test('project-context: symlinked planning store (#4815)', (t) => {
    const tmp = mkTmp(t);
    const holder = real(mkRepo(path.join(tmp, 'holder')));
    const store = path.join(tmp, 'external-store');
    mkRepo(store);
    write(path.join(store, 'planning', 'PROJECT.md'), '# external\n');
    fs.symlinkSync(path.join(store, 'planning'), path.join(holder, '.planning'), 'dir');
    const ctx = resolveProjectContext(subdir(holder, 1));
    assert.equal(ctx.projectRoot, holder);
    assert.equal(ctx.planningRoot, real(path.join(store, 'planning')));
    assert.notEqual(ctx.planningRoot, path.join(holder, '.planning'));
    assert.equal(ctx.worktreeRoot, holder);
  });

  test('project-context: nested repo boundary kept', (t) => {
    const outer = real(mkRepo(path.join(mkTmp(t), 'outer'), { planning: true }));
    const child = path.join(outer, 'child');
    mkRepo(child);
    const start = subdir(real(child), 1);
    const ctx = resolveProjectContext(start);
    assert.notEqual(ctx.projectRoot, outer, '#2843: must not cross into the outer project');
    assert.equal(ctx.projectRoot, start);
    assert.equal(ctx.provenance.source, 'none');
    assert.equal(ctx.worktreeRoot, real(child));
    assert.equal(ctx.planningRoot, path.join(start, '.planning'));
  });

  test('project-context: workspace sub_repos worktree (#4908 comment)', (t) => {
    const tmp = mkTmp(t);
    const main = real(mkRepo(path.join(tmp, 'main-repo')));
    const ws = path.join(tmp, 'workspace');
    write(path.join(ws, '.planning', 'config.json'), JSON.stringify({ planning: { sub_repos: ['wt-a'] } }));
    const wt = addWorktree(main, path.join(ws, 'wt-a'), 'feat-ws');
    const ctx = resolveProjectContext(subdir(wt, 1));
    assert.equal(ctx.projectRoot, real(ws));
    assert.equal(ctx.planningRoot, real(path.join(ws, '.planning')));
    assert.equal(ctx.worktreeRoot, wt);
    assert.equal(ctx.repoRoot, main);
    assert.equal(ctx.isLinkedWorktree, true);
    assert.equal(ctx.provenance.source, 'workspace');
  });
});

describe('project-context: explicit project dir', () => {
  test('project-context: explicit project dir', (t) => {
    const tmp = mkTmp(t);
    const x = real(mkRepo(path.join(tmp, 'x'), { planning: true }));
    const elsewhere = path.join(tmp, 'elsewhere');
    fs.mkdirSync(elsewhere);
    const ctx = resolveProjectContext(elsewhere, { explicit: x });
    assert.equal(ctx.projectRoot, x);
    assert.equal(ctx.worktreeRoot, x);
    assert.equal(ctx.repoRoot, x);
    assert.equal(ctx.provenance.source, 'explicit');
  });

  test('project-context: explicit dir inside linked worktree', (t) => {
    const tmp = mkTmp(t);
    const main = real(mkRepo(path.join(tmp, 'main'), { planning: true }));
    const wt = addWorktree(main, path.join(tmp, 'wt'), 'feat-a');
    const elsewhere = path.join(tmp, 'elsewhere');
    fs.mkdirSync(elsewhere);
    const ctx = resolveProjectContext(elsewhere, { explicit: wt });
    assert.equal(ctx.projectRoot, wt);
    assert.equal(ctx.worktreeRoot, wt);
    assert.equal(ctx.repoRoot, main);
    assert.equal(ctx.gitCommonDir, path.join(main, '.git'));
    assert.equal(ctx.isLinkedWorktree, true);
    assert.equal(ctx.provenance.source, 'explicit');
  });
});

describe('project-context: git degradation', () => {
  test('project-context: not a git repo', (t) => {
    const root = mkTmp(t);
    write(path.join(root, '.planning', 'config.json'), '{}');
    const start = subdir(root, 1);
    const ctx = resolveProjectContext(start);
    assert.equal(ctx.worktreeRoot, start);
    assert.equal(ctx.repoRoot, start);
    assert.equal(ctx.gitCommonDir, null);
    assert.equal(ctx.isLinkedWorktree, false);
    assert.equal(ctx.provenance.reason, 'not_git_repo');
    assert.equal(ctx.projectRoot, root, 'the planning walk-up still runs outside git');
  });

  test('project-context: git timeout degrades', (t) => {
    const start = mkTmp(t);
    const calls = [];
    const ctx = resolveProjectContext(start, {
      deps: { execGit: (args, opts) => { calls.push({ args, opts }); return TIMED_OUT; } },
    });
    assert.equal(ctx.provenance.degraded, true);
    assert.equal(ctx.provenance.reason, 'git_timed_out');
    assert.equal(ctx.worktreeRoot, start);
    assert.equal(ctx.repoRoot, start);
    assert.equal(ctx.isLinkedWorktree, false);
    assert.ok(calls.length >= 1, 'git was consulted through deps.execGit');
  });

  test('project-context: git spawn failure degrades', (t) => {
    const start = mkTmp(t);
    const ctx = resolveProjectContext(start, {
      deps: {
        execGit: () => ({
          exitCode: null, stdout: '', stderr: '', signal: null, error: new Error('spawn git ENOENT'), timedOut: false,
        }),
      },
    });
    assert.equal(ctx.provenance.degraded, true);
    assert.equal(ctx.worktreeRoot, start);
    assert.equal(ctx.repoRoot, start);
  });

  test('project-context: git queries are bounded and run from the start directory', (t) => {
    const root = real(mkRepo(path.join(mkTmp(t), 'main'), { planning: true }));
    const start = subdir(root, 1);
    const calls = [];
    const ctx = resolveProjectContext(start, {
      deps: {
        execGit: (args, opts) => {
          calls.push({ args, opts });
          return shellProjection.execGit(args, { ...opts, env: { ...GIT_ENV, ...(opts && opts.env) } });
        },
      },
    });
    assert.equal(ctx.worktreeRoot, root);
    assert.deepEqual(calls[0].args, ['rev-parse', '--show-toplevel', '--git-dir', '--git-common-dir']);
    for (const c of calls) {
      assert.equal(c.opts.cwd, start);
      assert.equal(c.opts.timeout, 10000);
    }
  });

  test('project-context: a main checkout spawns exactly one git process', (t) => {
    const root = real(mkRepo(path.join(mkTmp(t), 'main'), { planning: true }));
    const calls = [];
    const ctx = resolveProjectContext(subdir(root, 1), {
      deps: {
        execGit: (args, opts) => {
          calls.push(args);
          return shellProjection.execGit(args, { ...opts, env: { ...GIT_ENV, ...(opts && opts.env) } });
        },
      },
    });
    assert.equal(ctx.worktreeRoot, root);
    assert.equal(ctx.repoRoot, root);
    assert.equal(calls.length, 1, `a main checkout needs no worktree list: ${JSON.stringify(calls)}`);
  });

  test('project-context: a linked worktree adds exactly one worktree list', (t) => {
    const tmp = mkTmp(t);
    const main = real(mkRepo(path.join(tmp, 'main')));
    const wt = addWorktree(main, path.join(tmp, 'wt'), 'feat-one-list');
    const calls = [];
    resolveProjectContext(wt, {
      deps: {
        execGit: (args, opts) => {
          calls.push(args);
          return shellProjection.execGit(args, { ...opts, env: { ...GIT_ENV, ...(opts && opts.env) } });
        },
      },
    });
    assert.deepEqual(calls.map((a) => a[0]), ['rev-parse', 'worktree']);
  });

  test('project-context: git worktree list failure degrades to worktree_list_failed', (t) => {
    const start = mkTmp(t);
    const ctx = resolveProjectContext(start, {
      deps: {
        execGit: (args) => {
          const out = (exitCode, stdout, stderr = '') => ({ exitCode, stdout, stderr, signal: null, error: null, timedOut: false });
          if (args[0] === 'rev-parse') return out(0, `${start}\n${start}/.git/worktrees/w\n${start}/.git\n`);
          return out(128, '', 'fatal: unable to read worktrees');
        },
      },
    });
    assert.equal(ctx.provenance.reason, 'worktree_list_failed');
    assert.equal(ctx.provenance.degraded, true);
    assert.equal(ctx.repoRoot, ctx.worktreeRoot);
    assert.equal(ctx.isLinkedWorktree, false);
    assert.equal(ctx.provenance.warnings.length, 1);
  });

  test('project-context: rev-parse "not a git repository" is not_git_repo and not degraded', (t) => {
    const start = mkTmp(t);
    const ctx = resolveProjectContext(start, {
      deps: {
        execGit: () => ({ exitCode: 128, stdout: '', stderr: 'fatal: not a git repository (or any of the parent directories): .git\n', signal: null, error: null, timedOut: false }),
      },
    });
    assert.equal(ctx.provenance.reason, 'not_git_repo');
    assert.equal(ctx.provenance.degraded, false);
  });

  test('project-context: any other rev-parse failure is git_error and degraded', (t) => {
    const start = mkTmp(t);
    const ctx = resolveProjectContext(start, {
      deps: {
        execGit: () => ({ exitCode: 128, stdout: '', stderr: 'fatal: detected dubious ownership in repository at /x\n', signal: null, error: null, timedOut: false }),
      },
    });
    assert.equal(ctx.provenance.reason, 'git_error');
    assert.equal(ctx.provenance.degraded, true);
    assert.equal(ctx.worktreeRoot, start);
    assert.equal(ctx.repoRoot, start);
    assert.equal(ctx.provenance.warnings.length, 1);
  });
});

describe('project-context: repository shapes', () => {
  test('project-context: bare repository', (t) => {
    const tmp = mkTmp(t);
    const src = mkRepo(path.join(tmp, 'src'));
    const bare = path.join(tmp, 'bare.git');
    git(['clone', '-q', '--bare', src, bare], tmp);
    git(['worktree', 'add', '-q', path.join(tmp, 'wt-a'), 'main'], bare);
    git(['worktree', 'add', '-q', '-b', 'feat-b', path.join(tmp, 'wt-b')], bare);
    const wtA = real(path.join(tmp, 'wt-a'));
    const wtB = real(path.join(tmp, 'wt-b'));

    const fromB = resolveProjectContext(wtB);
    assert.equal(fromB.worktreeRoot, wtB);
    assert.equal(fromB.repoRoot, wtA, 'repoRoot is the first non-bare worktree entry');
    assert.equal(fromB.isLinkedWorktree, true);
    assert.equal(fromB.gitCommonDir, real(bare));

    const fromA = resolveProjectContext(wtA);
    assert.equal(fromA.repoRoot, wtA);
    assert.equal(fromA.isLinkedWorktree, false);
  });

  test('project-context: bare repository with no non-bare entry', (t) => {
    const start = mkTmp(t);
    const bareOnly = `worktree ${start}\nbare\n\n`;
    const ctx = resolveProjectContext(start, {
      deps: {
        execGit: (args) => {
          const out = (stdout) => ({ exitCode: 0, stdout, stderr: '', signal: null, error: null, timedOut: false });
          if (args[0] === 'rev-parse') return out(`${start}\n${start}/.git/worktrees/w\n${start}/.git\n`);
          if (args[0] === 'worktree') return out(bareOnly);
          return TIMED_OUT;
        },
      },
    });
    assert.equal(ctx.repoRoot, ctx.worktreeRoot);
    assert.equal(ctx.provenance.reason, 'bare_main_worktree');
    assert.equal(ctx.isLinkedWorktree, false);
  });

  test('project-context: submodule', (t) => {
    const tmp = mkTmp(t);
    const lib = mkRepo(path.join(tmp, 'lib'));
    const superRepo = mkRepo(path.join(tmp, 'super'));
    git(['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', lib, 'mods/lib'], superRepo);
    git(['commit', '-q', '-m', 'add submodule'], superRepo);
    const sub = real(path.join(superRepo, 'mods', 'lib'));
    const ctx = resolveProjectContext(sub);
    assert.equal(ctx.worktreeRoot, sub);
    assert.equal(ctx.repoRoot, sub, 'repoRoot is the submodule checkout, never the superproject');
    assert.equal(ctx.isLinkedWorktree, false);
  });
});

describe('project-context: legacyDispatchCwd parity', () => {
  // Encodes the resolveMainWorktreeCwd cases of tests/commands.test.cjs (#3050)
  // as expected outputs of legacyDispatchCwd, plus the real-layout analogues.
  test('project-context: legacyDispatchCwd parity', (t) => {
    // (1) git_timed_out: fallback root is the start itself.
    const timedOut = resolveProjectContext('/repo/wt', { deps: { execGit: () => TIMED_OUT } });
    assert.equal(legacyDispatchCwd(timedOut, '/repo/wt'), '/repo/wt');

    // (2) benign linked_worktree: no .planning in the worktree -> main checkout.
    const linked = { isLinkedWorktree: true, repoRoot: '/repo', worktreeRoot: '/repo/wt' };
    assert.equal(legacyDispatchCwd(linked, '/repo/wt'), '/repo');

    // (3) benign not_git_repo: unchanged.
    const notGit = { isLinkedWorktree: false, repoRoot: '/repo/wt', worktreeRoot: '/repo/wt' };
    assert.equal(legacyDispatchCwd(notGit, '/repo/wt'), '/repo/wt');

    // (4) .planning already in cwd: short-circuits to cwd, even inside a linked worktree.
    const main = real(mkRepo(path.join(mkTmp(t), 'main'), { planning: true }));
    const wt = addWorktree(main, path.join(path.dirname(main), 'wt'), 'feat-a');
    assert.equal(legacyDispatchCwd(resolveProjectContext(wt), wt), wt);
  });

  test('project-context: legacyDispatchCwd parity on real layouts', (t) => {
    const tmp = mkTmp(t);
    const main = real(mkRepo(path.join(tmp, 'main'), { planning: true }));
    const tracked = addWorktree(main, path.join(tmp, 'wt-tracked'), 'feat-a');

    // linked worktree subdir whose top level has .planning (#4885): top level.
    const trackedSub = subdir(tracked, 2);
    assert.equal(legacyDispatchCwd(resolveProjectContext(trackedSub), trackedSub), tracked);

    // main checkout subdir (not linked, no .planning there): unchanged.
    const mainSub = subdir(main, 1);
    assert.equal(legacyDispatchCwd(resolveProjectContext(mainSub), mainSub), mainSub);

    // linked worktree with no .planning anywhere inside: main checkout.
    const bareMain = real(mkRepo(path.join(tmp, 'main2')));
    const untracked = addWorktree(bareMain, path.join(tmp, 'wt-untracked'), 'feat-b');
    write(path.join(bareMain, '.planning', 'config.json'), '{}');
    const untrackedSub = subdir(untracked, 1);
    assert.equal(legacyDispatchCwd(resolveProjectContext(untrackedSub), untrackedSub), bareMain);

    // not a git repository: unchanged.
    const plain = subdir(mkTmp(t), 1);
    assert.equal(legacyDispatchCwd(resolveProjectContext(plain), plain), plain);
  });
});

describe('project-context: invariants property', () => {
  test('project-context: invariants property', () => {
    const arbitrary = fc.record({
      linked: fc.boolean(),
      planningAt: fc.constantFrom('main', 'wt', 'none'),
      depth: fc.integer({ min: 0, max: 4 }),
    });
    fc.assert(
      fc.property(arbitrary, ({ linked, planningAt, depth }) => {
        const tmp = real(fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-6043-prop-')));
        try {
          const main = real(mkRepo(path.join(tmp, 'main'), { planning: planningAt === 'main' }));
          let wt = main;
          if (linked) {
            wt = addWorktree(main, path.join(tmp, 'wt'), 'feat-p');
            if (planningAt === 'wt') write(path.join(wt, '.planning', 'config.json'), '{}');
          } else if (planningAt === 'wt') {
            write(path.join(main, '.planning', 'config.json'), '{}');
          }
          const start = subdir(wt, depth);
          const ctx = resolveProjectContext(start);

          assert.equal(ctx.isLinkedWorktree, ctx.worktreeRoot !== ctx.repoRoot);
          assert.equal(ctx.isLinkedWorktree, linked);
          assert.ok(
            start === ctx.worktreeRoot || start.startsWith(ctx.worktreeRoot + path.sep),
            'worktreeRoot contains the start directory',
          );
          if (ctx.provenance.source === 'none') {
            assert.equal(ctx.projectRoot, start);
          } else {
            assert.ok(fs.existsSync(path.join(ctx.projectRoot, '.planning')), 'projectRoot holds .planning');
          }
          if (planningAt === 'none') assert.equal(ctx.provenance.source, 'none');
          assert.equal(Object.isFrozen(ctx), true);
        } finally {
          cleanup(tmp);
        }
      }),
      { seed: 6043, numRuns: 25 },
    );
  });
});
