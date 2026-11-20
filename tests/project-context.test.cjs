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
  readGitLayout,
  parseGitConfig,
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
      deps: { readGitLayout: () => null, execGit: (args, opts) => { calls.push({ args, opts }); return TIMED_OUT; } },
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
        readGitLayout: () => null,
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
        readGitLayout: () => null,
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
        readGitLayout: () => null,
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
        readGitLayout: () => null,
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
        readGitLayout: () => null,
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
        readGitLayout: () => null,
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
        readGitLayout: () => null,
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
        readGitLayout: () => null,
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
    const timedOut = resolveProjectContext('/repo/wt', { deps: { readGitLayout: () => null, execGit: () => TIMED_OUT } });
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

// ─── #6355: the git layout read from the filesystem ─────────────────────────
//
// That the reader agrees with real git is proved over git-built fixtures in
// git-layout-parity.process.test.cjs. These cases build the on-disk shapes by
// hand, which is what lets them cover the shapes git itself will not create,
// and pin the reader's other half: what it declines to answer.
describe('#6355: readGitLayout', () => {
  /** The files git needs to see before it calls a directory a git dir. */
  function gitDir(dir, { config = '[core]\n\tbare = false\n' } = {}) {
    fs.mkdirSync(path.join(dir, 'objects'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'refs'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'HEAD'), 'ref: refs/heads/main\n');
    if (config !== null) fs.writeFileSync(path.join(dir, 'config'), config);
    return dir;
  }

  /** A main checkout and one linked worktree of it, as `git worktree add` lays them out. */
  function mainAndLinked(root) {
    const main = path.join(root, 'main');
    const common = gitDir(path.join(main, '.git'));
    const linked = path.join(root, 'linked');
    const linkedGitDir = path.join(common, 'worktrees', 'linked');
    fs.mkdirSync(linked);
    fs.mkdirSync(linkedGitDir, { recursive: true });
    fs.writeFileSync(path.join(linkedGitDir, 'HEAD'), 'ref: refs/heads/linked\n');
    fs.writeFileSync(path.join(linkedGitDir, 'commondir'), '../..\n');
    fs.writeFileSync(path.join(linkedGitDir, 'gitdir'), `${path.join(linked, '.git')}\n`);
    fs.writeFileSync(path.join(linked, '.git'), `gitdir: ${linkedGitDir}\n`);
    return { main, common, linked, linkedGitDir };
  }

  test('a main checkout: the checkout is both roots, from its top and from below', (t) => {
    const root = mkTmp(t);
    const { main, common } = mainAndLinked(root);
    fs.mkdirSync(path.join(main, 'a', 'b'), { recursive: true });

    for (const start of [main, path.join(main, 'a', 'b')]) {
      assert.deepEqual(readGitLayout(start), {
        worktreeRoot: main, repoRoot: main, gitCommonDir: common, reason: 'ok', degraded: false, warnings: [],
      });
    }
  });

  test('a linked worktree: its own top, the main checkout as the repo root, the shared git dir', (t) => {
    const root = mkTmp(t);
    const { main, common, linked } = mainAndLinked(root);
    fs.mkdirSync(path.join(linked, 'a'));

    for (const start of [linked, path.join(linked, 'a')]) {
      assert.deepEqual(readGitLayout(start), {
        worktreeRoot: linked, repoRoot: main, gitCommonDir: common, reason: 'ok', degraded: false, warnings: [],
      });
    }
  });

  test('no repository above the start: the start itself, and that is not a degradation', (t) => {
    const start = path.join(mkTmp(t), 'a', 'b');
    fs.mkdirSync(start, { recursive: true });

    assert.deepEqual(readGitLayout(start), {
      worktreeRoot: start, repoRoot: start, gitCommonDir: null, reason: 'not_git_repo', degraded: false, warnings: [],
    });
  });

  test('the nearest repository wins: a repository nested in another answers for what is inside it', (t) => {
    const root = mkTmp(t);
    const outer = path.join(root, 'outer');
    const inner = path.join(outer, 'vendor', 'inner');
    gitDir(path.join(outer, '.git'));
    gitDir(path.join(inner, '.git'));
    fs.mkdirSync(path.join(inner, 'src'));

    assert.equal(readGitLayout(path.join(inner, 'src')).worktreeRoot, inner);
    assert.equal(readGitLayout(path.join(outer, 'vendor')).worktreeRoot, outer);
  });

  test('property: from any depth, the answer is the nearest ancestor that holds a repository', (t) => {
    const root = mkTmp(t);
    let n = 0;
    fc.assert(fc.property(
      fc.integer({ min: 0, max: 6 }),
      fc.array(fc.integer({ min: 0, max: 6 }), { maxLength: 3 }),
      (depth, repoLevels) => {
        n += 1;
        const dirs = [path.join(root, `case-${n}`)];
        for (let level = 1; level <= depth; level += 1) dirs.push(path.join(dirs[level - 1], `d${level}`));
        fs.mkdirSync(dirs[depth], { recursive: true });
        const repos = [...new Set(repoLevels.filter((level) => level <= depth))];
        for (const level of repos) gitDir(path.join(dirs[level], '.git'));

        const layout = readGitLayout(dirs[depth]);
        if (repos.length === 0) return layout.reason === 'not_git_repo' && layout.worktreeRoot === dirs[depth];
        const nearest = dirs[Math.max(...repos)];
        return layout.reason === 'ok' && layout.worktreeRoot === nearest && layout.repoRoot === nearest
          && layout.gitCommonDir === path.join(nearest, '.git');
      },
    ), { numRuns: 60 });
  });

  describe('declines, so that git decides', () => {
    const cases = {
      'a start that does not exist': (root) => path.join(root, 'not-there'),
      'a start inside the git dir': (root) => path.join(mainAndLinked(root).common, 'objects'),
      'a bare repository': (root) => gitDir(path.join(root, 'bare.git'), { config: '[core]\n\tbare = true\n' }),
      'a `.git` whose HEAD git cannot parse': (root) => {
        const { main, common } = mainAndLinked(root);
        fs.writeFileSync(path.join(common, 'HEAD'), 'garbage\n');
        return main;
      },
      'a `.git` with an empty HEAD': (root) => {
        const { main, common } = mainAndLinked(root);
        fs.writeFileSync(path.join(common, 'HEAD'), '');
        return main;
      },
      'a `.git` with no objects directory': (root) => {
        const { main, common } = mainAndLinked(root);
        cleanup(path.join(common, 'objects'));
        return main;
      },
      'a config git would reject': (root) => {
        const { main, common } = mainAndLinked(root);
        fs.writeFileSync(path.join(common, 'config'), '[core\njunk\n');
        return main;
      },
      'a repository format this reader does not know': (root) => {
        const { main, common } = mainAndLinked(root);
        fs.writeFileSync(path.join(common, 'config'), '[core]\n\trepositoryformatversion = 2\n');
        return main;
      },
      'an extension this reader does not know': (root) => {
        const { main, common } = mainAndLinked(root);
        fs.writeFileSync(path.join(common, 'config'), '[core]\n\trepositoryformatversion = 1\n[extensions]\n\tfooBar = true\n');
        return main;
      },
      'core.bare spelled in a way a pattern would miss': (root) => {
        const { main, common } = mainAndLinked(root);
        fs.writeFileSync(path.join(common, 'config'), '[core]\n\tbare = "true"\n');
        return main;
      },
      'core.bare = true hidden behind a later subsection of core': (root) => {
        const { main, common } = mainAndLinked(root);
        fs.writeFileSync(path.join(common, 'config'), '[core]\n\tbare = true\n[core "x"]\n\tbare = false\n');
        return main;
      },
      'core.worktree on the section header line': (root) => {
        const { main, common } = mainAndLinked(root);
        fs.writeFileSync(path.join(common, 'config'), '[core] worktree = ../elsewhere\n');
        return main;
      },
      'a `.git` that is not a git dir': (root) => {
        fs.mkdirSync(path.join(root, 'work', '.git'), { recursive: true });
        return path.join(root, 'work');
      },
      'a `.git` file that names no git dir': (root) => {
        fs.mkdirSync(path.join(root, 'work'));
        fs.writeFileSync(path.join(root, 'work', '.git'), 'not a pointer\n');
        return path.join(root, 'work');
      },
      'a `.git` file larger than a pointer': (root) => {
        fs.mkdirSync(path.join(root, 'work'));
        fs.writeFileSync(path.join(root, 'work', '.git'), `gitdir: ${'x'.repeat(5000)}\n`);
        return path.join(root, 'work');
      },
      'core.worktree in the config': (root) => {
        const { main, common } = mainAndLinked(root);
        fs.writeFileSync(path.join(common, 'config'), '[core]\n\tworktree = ../elsewhere\n');
        return main;
      },
      'core.bare = true in the config': (root) => {
        const { main, common } = mainAndLinked(root);
        fs.writeFileSync(path.join(common, 'config'), '[core]\n\tbare = true\n');
        return main;
      },
      'an include in the config': (root) => {
        const { main, common } = mainAndLinked(root);
        fs.writeFileSync(path.join(common, 'config'), '[include]\n\tpath = ../other.config\n');
        return main;
      },
      'core.worktree in the per-worktree config': (root) => {
        const { main, common } = mainAndLinked(root);
        fs.writeFileSync(path.join(common, 'config.worktree'), '[core]\n\tworktree = ../elsewhere\n');
        return main;
      },
      'a linked worktree whose main repository is bare': (root) => {
        const { linked, common } = mainAndLinked(root);
        fs.writeFileSync(path.join(common, 'config'), '[core]\n\tbare = true\n');
        return linked;
      },
      'a linked worktree whose git dir points back somewhere else': (root) => {
        const { linked, linkedGitDir } = mainAndLinked(root);
        fs.writeFileSync(path.join(linkedGitDir, 'gitdir'), `${path.join(root, 'main', '.git')}\n`);
        return linked;
      },
      'a linked worktree whose git dir is not under <common>/worktrees': (root) => {
        const { linked, linkedGitDir } = mainAndLinked(root);
        fs.writeFileSync(path.join(linkedGitDir, 'commondir'), '..\n');
        return linked;
      },
      'a git dir with a commondir where a main checkout has none': (root) => {
        const { main, common } = mainAndLinked(root);
        fs.writeFileSync(path.join(common, 'commondir'), '.\n');
        return main;
      },
    };
    for (const [name, build] of Object.entries(cases)) {
      test(name, (t) => {
        assert.equal(readGitLayout(build(mkTmp(t))), null);
      });
    }

    test('a `.git` that is a symbolic link', { skip: process.platform === 'win32' && 'needs symlink privilege' }, (t) => {
      const root = mkTmp(t);
      const { common } = mainAndLinked(root);
      fs.mkdirSync(path.join(root, 'work'));
      fs.symlinkSync(common, path.join(root, 'work', '.git'), 'dir');
      assert.equal(readGitLayout(path.join(root, 'work')), null);
    });

    // A FIFO blocks whoever opens it for reading until a writer appears. One
    // planted as `config` or `commondir` must never be opened: the open would
    // hang every CLI call. The stand-in turns "opened it" into a failure
    // instead of a hang.
    test('a FIFO where a file is expected is never opened', { skip: process.platform === 'win32' && 'no FIFOs' }, (t) => {
      const { runHook, OUTCOME } = require('./helpers/process-seam.cjs');
      const root = mkTmp(t);
      const { main, common, linked, linkedGitDir } = mainAndLinked(root);
      for (const file of [path.join(common, 'config'), path.join(linkedGitDir, 'commondir')]) {
        fs.unlinkSync(file);
        const made = runHook(file, [], { interpreter: 'mkfifo' });
        assert.equal(made.outcome, OUTCOME.EXITED, `mkfifo did not run: ${made.outcome}`);
        assert.equal(made.exitCode, 0, made.stderr);
      }
      const realOpen = fs.openSync;
      const opened = [];
      t.mock.method(fs, 'openSync', (file, ...rest) => {
        if (fs.lstatSync(file).isFIFO()) {
          opened.push(file);
          throw new Error(`opened a FIFO: ${file}`);
        }
        return realOpen.call(fs, file, ...rest);
      });

      assert.equal(readGitLayout(main), null);
      assert.equal(readGitLayout(linked), null);
      assert.deepEqual(opened, []);
    });

    // Windows has no uid. There the reader answers only when everything the
    // answer rests on is inside the user's home directory, and leaves any
    // other repository to git and git's own ownership check.
    test('where there is no uid: a repository outside the home directory', (t) => {
      const root = mkTmp(t);
      const { main, linked } = mainAndLinked(root);
      const home = path.join(root, 'home');
      fs.mkdirSync(home);
      const uid = Object.getOwnPropertyDescriptor(process, 'getuid');
      Object.defineProperty(process, 'getuid', { value: undefined, configurable: true, writable: true });
      t.after(() => {
        if (uid) Object.defineProperty(process, 'getuid', uid);
        else delete process.getuid;
      });

      // One mock, re-pointed. Mocking the same method again would leave the
      // earlier mock installed when the test ends, for every test after it.
      const homedir = t.mock.method(os, 'homedir', () => home);
      assert.equal(readGitLayout(main), null);
      assert.equal(readGitLayout(linked), null);

      // The same repositories, with the home directory above them, are answered.
      homedir.mock.mockImplementation(() => root);
      assert.equal(readGitLayout(main).worktreeRoot, main);
      assert.equal(readGitLayout(linked).repoRoot, main);

      // A home that is a filesystem root vouches for nothing.
      homedir.mock.mockImplementation(() => path.parse(root).root);
      assert.equal(readGitLayout(main), null);
    });

    test('a repository another user owns', { skip: typeof process.getuid !== 'function' && 'no uid on this platform' }, (t) => {
      const { main } = mainAndLinked(mkTmp(t));
      const mine = process.getuid();
      t.mock.method(process, 'getuid', () => mine + 1);
      assert.equal(readGitLayout(main), null);
    });
  });

  describe('parseGitConfig', () => {
    const values = (text) => Object.fromEntries(parseGitConfig(text).values);

    test('sections, subsections, case and the last value of a key', () => {
      assert.deepEqual(values('[Core]\n\tBare = false\n[branch "A b"]\n\tmerge = x\n[core]\n\tbare = true\n'), {
        'core.bare': 'true', 'branch.A b.merge': 'x',
      });
      assert.deepEqual([...parseGitConfig('[core]\n[branch "a"]\n[include]\n').sections].sort(), ['branch', 'core', 'include']);
    });

    test('values: quotes, escapes, comments, continuations, and a key with no value', () => {
      assert.deepEqual(values('[s]\n k = "a;b" ; c\n q = a"b"c\n e = a\\tb\n c = tr\\\nue\n t =  x  \n bare\n'), {
        's.k': 'a;b', 's.q': 'abc', 's.e': 'a\tb', 's.c': 'true', 's.t': 'x', 's.bare': true,
      });
    });

    test('a key on the header line, and a key before any section', () => {
      assert.deepEqual(values('top = 1\n[core] worktree = /tmp\n'), { '.top': '1', 'core.worktree': '/tmp' });
    });

    // `[core "x"]` is its own namespace to git. Read as plain `core`, a later
    // `[core "x"] bare = false` would hide a real `core.bare = true`.
    test('a subsection of core does not override core', () => {
      assert.deepEqual(values('[core]\n\tbare = true\n[core "x"]\n\tbare = false\n'), {
        'core.bare': 'true', 'core.x.bare': 'false',
      });
    });

    test('a form feed or a vertical tab is not whitespace', () => {
      assert.equal(parseGitConfig('[core]\f\n\tfoo = 1\n'), null);
      assert.equal(parseGitConfig('[core]\v\n\tfoo = 1\n'), null);
      assert.deepEqual(values('[s]\n\tk = a\fb\n'), { 's.k': 'a\fb' });
    });

    test('what git rejects is rejected', () => {
      for (const text of ['[core\n', '[ core]\n', '[]\n', '!!!\n', '[s]\n1k = v\n', '[s]\nk_1 = v\n',
        '[s]\nk = "open\n', '[s]\nk = a\\qb\n', '[s]\nk v\n']) {
        assert.equal(parseGitConfig(text), null, JSON.stringify(text));
      }
    });
  });

  test('resolveProjectContext says which path answered, and uses git only when the reader declines', (t) => {
    const { main } = mainAndLinked(mkTmp(t));
    const calls = [];
    const execGit = (args, opts) => {
      calls.push(args.join(' '));
      return shellProjection.execGit(args, opts);
    };

    assert.equal(resolveProjectContext(main, { deps: { execGit } }).provenance.layout, 'filesystem');
    assert.deepEqual(calls, []);

    const declined = resolveProjectContext(main, { deps: { execGit, readGitLayout: () => null } });
    assert.equal(declined.provenance.layout, 'git');
    assert.equal(calls.length, 1);
  });
});
