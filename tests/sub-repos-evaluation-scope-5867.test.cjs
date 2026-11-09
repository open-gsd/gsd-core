'use strict';

/**
 * #5867: `planning.sub_repos` workspaces. The workspace root holds `.planning/` and is not a git
 * repo; the code and the commits live in the sub-repos. The evaluation-scope resolver must look
 * in each configured sub-repo and merge what it finds, and report `unresolvable` only when a
 * configured sub-repo itself cannot be read. Behavioral tests against real git fixtures.
 */

const { describe, test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { cleanup } = require('./helpers.cjs');
const { gitOrThrow } = require('./helpers/git-fixture.cjs');
const {
  resolveEvaluationScope,
  evaluateEvaluationScope,
  commitIsAncestor,
} = require('../gsd-core/bin/lib/gate-evaluation-scope.cjs');

const IDENTITY = {
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@test.io',
  GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@test.io',
};
const PHASE_DIR = '.planning/phases/01-demo';

const dirs = [];
afterEach(() => { while (dirs.length > 0) cleanup(dirs.pop()); });

function write(dir, rel, content) {
  const target = path.join(dir, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
}

function initRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const git = (env, ...args) => gitOrThrow(args, { cwd: dir, env: { ...process.env, ...IDENTITY, ...env } }).trim();
  git({}, 'init', '--initial-branch=main');
  return { dir, git: (...args) => git({}, ...args), gitAt: git };
}

/** A workspace: `.planning/` at the root (not a repo) and one git repo per name in `repos`. */
function makeWorkspace(repos, { rootIsRepo = false, subRepos = repos } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-subrepos-'));
  dirs.push(root);
  write(root, '.planning/config.json', JSON.stringify({ planning: { sub_repos: subRepos, commit_docs: false } }));
  write(root, `${PHASE_DIR}/01-01-PLAN.md`, '---\nphase: 01-demo\nplan: 01\n---\n# Plan\n');
  write(root, '.planning/ROADMAP.md', '# Roadmap\n\n## Phases\n\n### Phase 1: Demo\n');
  const ws = { root, repos: {}, rootRepo: null };
  if (rootIsRepo) ws.rootRepo = initRepo(root);
  for (const name of repos) ws.repos[name] = initRepo(path.join(root, name));
  return ws;
}

/** Commit one file in `repo` at a fixed unix `time`; returns the full sha. */
function commit(repo, rel, message, time) {
  write(repo.dir, rel, `${rel}\n`);
  repo.git('add', rel);
  const stamp = `${time} +0000`;
  repo.gitAt({ GIT_AUTHOR_DATE: stamp, GIT_COMMITTER_DATE: stamp }, 'commit', '-m', message);
  return repo.git('rev-parse', 'HEAD');
}

const planScope = (ws, options = {}) => resolveEvaluationScope(ws.root, { kind: 'plan', planId: '01-01' }, options);

describe('#5867 plan unit across planning.sub_repos', () => {
  test('[regression] the reproduction resolves the commit of a configured sub-repo', () => {
    const ws = makeWorkspace(['app']);
    const sha = commit(ws.repos.app, 'src/thing.js', 'feat(01-01): add thing', 1_700_000_000);
    const scope = planScope(ws, { commitsOnly: true });
    assert.equal(scope.status, 'resolved');
    assert.equal(scope.reason, null);
    assert.deepEqual(scope.commits.map((c) => c.sha), [sha]);
    assert.equal(scope.commits[0].subject, 'feat(01-01): add thing');
  });

  test('[happy] commits from two sub-repos are merged newest first', () => {
    const ws = makeWorkspace(['api', 'web']);
    const oldest = commit(ws.repos.api, 'a.js', 'feat(01-01): api first', 1_700_000_000);
    const newest = commit(ws.repos.web, 'w.js', 'feat(01-01): web second', 1_700_000_200);
    const middle = commit(ws.repos.api, 'b.js', 'fix(01-01): api third', 1_700_000_100);
    const scope = planScope(ws, { commitsOnly: true });
    assert.deepEqual(scope.commits.map((c) => c.sha), [newest, middle, oldest]);
  });

  test('[happy] changed files are workspace-relative and the existing set is the reviewable one', () => {
    const ws = makeWorkspace(['api', 'web']);
    commit(ws.repos.api, 'src/a.js', 'feat(01-01): a', 1_700_000_000);
    commit(ws.repos.web, 'ui/w.js', 'feat(01-01): w', 1_700_000_100);
    const scope = planScope(ws);
    assert.equal(scope.status, 'resolved');
    assert.deepEqual(scope.changedFiles, ['api/src/a.js', 'web/ui/w.js']);
    assert.deepEqual(scope.files, ['api/src/a.js', 'web/ui/w.js']);
    assert.deepEqual(scope.missingOnDisk, []);
  });

  test('[negative] a plan with no commits anywhere is a truthful none, not unresolvable', () => {
    const ws = makeWorkspace(['api', 'web']);
    commit(ws.repos.api, 'a.js', 'feat(02-01): other plan', 1_700_000_000);
    commit(ws.repos.web, 'w.js', 'chore: unrelated', 1_700_000_100);
    const scope = planScope(ws, { commitsOnly: true });
    assert.equal(scope.status, 'resolved');
    assert.equal(scope.reason, 'no-matching-commits');
    assert.deepEqual(scope.commits, []);
  });

  test('[boundary] maxCommits caps the MERGED list, keeping the newest (limit-1, limit, limit+1)', () => {
    const ws = makeWorkspace(['api', 'web']);
    const shas = [
      commit(ws.repos.api, 'a1.js', 'feat(01-01): a1', 1_700_000_000),
      commit(ws.repos.web, 'w1.js', 'feat(01-01): w1', 1_700_000_100),
      commit(ws.repos.api, 'a2.js', 'feat(01-01): a2', 1_700_000_200),
    ];
    const newestFirst = [...shas].reverse();
    for (const [max, expected] of [[2, 2], [3, 3], [4, 3]]) {
      const scope = planScope(ws, { commitsOnly: true, maxCommits: max });
      assert.deepEqual(scope.commits.map((c) => c.sha), newestFirst.slice(0, expected), `maxCommits ${max}`);
    }
  });

  test('[boundary] since is applied in the repo that holds it, the other repo is unfiltered', () => {
    const ws = makeWorkspace(['api', 'web']);
    const first = commit(ws.repos.api, 'a1.js', 'feat(01-01): a1', 1_700_000_000);
    const second = commit(ws.repos.api, 'a2.js', 'feat(01-01): a2', 1_700_000_100);
    const web = commit(ws.repos.web, 'w.js', 'feat(01-01): w', 1_700_000_050);
    const scope = planScope(ws, { commitsOnly: true, since: first });
    assert.deepEqual(scope.commits.map((c) => c.sha), [second, web]);
  });

  test('[independence] a workspace root that is itself a repo keeps contributing its commits', () => {
    const ws = makeWorkspace(['app'], { rootIsRepo: true });
    write(ws.root, '.gitignore', 'app/\n');
    ws.rootRepo.git('add', '.gitignore');
    ws.rootRepo.gitAt({}, 'commit', '-m', 'chore: ignore app');
    const rootSha = commit(ws.rootRepo, 'docs/plan.md', 'docs(01-01): plan notes', 1_700_000_300);
    const appSha = commit(ws.repos.app, 'src/x.js', 'feat(01-01): x', 1_700_000_100);
    const scope = planScope(ws);
    assert.deepEqual(scope.commits.map((c) => c.sha), [rootSha, appSha]);
    assert.deepEqual(scope.changedFiles, ['app/src/x.js', 'docs/plan.md']);
  });

  test('[independence] no sub_repos configured keeps the legacy unresolvable answer for a non-repo root', () => {
    const ws = makeWorkspace([], { subRepos: [] });
    const scope = planScope(ws, { commitsOnly: true });
    assert.equal(scope.status, 'unresolvable');
    assert.equal(scope.reason, 'git-failed:rev-parse');
  });
});

describe('#5867 unreadable or hostile sub_repos', () => {
  test('[negative] a configured sub-repo that does not exist is unresolvable and named', () => {
    const ws = makeWorkspace(['api'], { subRepos: ['api', 'ghost'] });
    commit(ws.repos.api, 'a.js', 'feat(01-01): a', 1_700_000_000);
    const scope = planScope(ws, { commitsOnly: true });
    assert.equal(scope.status, 'unresolvable');
    assert.match(scope.reason, /ghost/);
    assert.deepEqual(scope.commits, []);
  });

  test('[negative] a configured directory that is not a git repo is unresolvable', () => {
    const ws = makeWorkspace(['api']);
    fs.mkdirSync(path.join(ws.root, 'plain'));
    write(ws.root, '.planning/config.json', JSON.stringify({ planning: { sub_repos: ['api', 'plain'] } }));
    commit(ws.repos.api, 'a.js', 'feat(01-01): a', 1_700_000_000);
    const scope = planScope(ws, { commitsOnly: true });
    assert.equal(scope.status, 'unresolvable');
    assert.match(scope.reason, /plain/);
  });

  test('[negative] a directory inside the root repo that is not its own repo is refused, never read through the parent', () => {
    const ws = makeWorkspace([], { rootIsRepo: true, subRepos: ['inner'] });
    write(ws.root, 'inner/x.js', 'x\n');
    commit(ws.rootRepo, 'inner/y.js', 'feat(01-01): y', 1_700_000_000);
    const scope = planScope(ws, { commitsOnly: true });
    assert.equal(scope.status, 'unresolvable');
    assert.match(scope.reason, /inner/);
  });

  for (const [label, entry] of [
    ['a parent-escaping path', '../outside'],
    ['an absolute path', path.join(os.tmpdir(), 'elsewhere')],
    ['a nested parent segment', 'a/../../outside'],
    ['a NUL byte', 'app\0x'],
    ['a non-string entry', 42],
  ]) {
    test(`[hostile] ${label} in sub_repos is refused as unresolvable`, () => {
      const ws = makeWorkspace([], { subRepos: [entry] });
      const scope = planScope(ws, { commitsOnly: true });
      assert.equal(scope.status, 'unresolvable');
      assert.match(scope.reason, /sub-repo/);
    });
  }

  test('[hostile] a sub_repos symlink that resolves outside the workspace is refused', (t) => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-subrepos-out-'));
    dirs.push(outside);
    const outsideRepo = initRepo(outside);
    commit(outsideRepo, 'a.js', 'feat(01-01): leak', 1_700_000_000);
    const ws = makeWorkspace([], { subRepos: ['link'] });
    try {
      fs.symlinkSync(outside, path.join(ws.root, 'link'), 'dir');
    } catch {
      t.skip('symlinks unavailable on this platform');
      return;
    }
    const scope = planScope(ws, { commitsOnly: true });
    assert.equal(scope.status, 'unresolvable');
    assert.deepEqual(scope.commits, []);
  });
});

describe('#5867 phase unit across planning.sub_repos', () => {
  function summarize(ws, shas) {
    const rows = shas.map((sha, i) => `${i + 1}. **Task ${i + 1}: work** - \`${sha}\``).join('\n');
    write(ws.root, `${PHASE_DIR}/01-01-SUMMARY.md`, `# Summary\n\n## Task Commits\n\n${rows}\n\n## Next\n`);
  }
  const phaseScope = (ws, options = {}) => resolveEvaluationScope(ws.root, { kind: 'phase', phase: '1' }, options);

  test('[happy] task commits listed from two sub-repos resolve to one workspace-relative union', () => {
    const ws = makeWorkspace(['api', 'web']);
    const a = commit(ws.repos.api, 'src/a.js', 'feat(01-01): a', 1_700_000_000);
    const w = commit(ws.repos.web, 'ui/w.js', 'feat(01-01): w', 1_700_000_100);
    summarize(ws, [a, w]);
    const scope = phaseScope(ws);
    assert.equal(scope.status, 'resolved');
    assert.equal(scope.source, 'task-commits');
    assert.deepEqual(scope.files, ['api/src/a.js', 'web/ui/w.js']);
    assert.deepEqual(scope.commits.map((c) => c.sha).sort(), [a, w].sort());
    assert.deepEqual(scope.commits.find((c) => c.sha === a).files, ['api/src/a.js']);
    assert.deepEqual(scope.unreachable, []);
  });

  test('[negative] a listed sha no sub-repo has is named unreachable, the rest still resolve', () => {
    const ws = makeWorkspace(['api', 'web']);
    const a = commit(ws.repos.api, 'src/a.js', 'feat(01-01): a', 1_700_000_000);
    const ghost = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
    summarize(ws, [a, ghost]);
    const scope = phaseScope(ws);
    assert.equal(scope.status, 'resolved');
    assert.deepEqual(scope.files, ['api/src/a.js']);
    assert.deepEqual(scope.unreachable, [ghost]);
  });

  test('[negative] a task commit on a side branch of its sub-repo is unreachable, not scope', () => {
    const ws = makeWorkspace(['api', 'web']);
    const a = commit(ws.repos.api, 'src/a.js', 'feat(01-01): a', 1_700_000_000);
    ws.repos.web.git('checkout', '-b', 'side');
    const side = commit(ws.repos.web, 'ui/side.js', 'feat(01-01): side', 1_700_000_100);
    ws.repos.web.git('checkout', 'main');
    summarize(ws, [a, side]);
    const scope = phaseScope(ws);
    assert.deepEqual(scope.files, ['api/src/a.js']);
    assert.deepEqual(scope.unreachable, [side]);
  });

  test('[negative] no SUMMARY and no anchor is unresolvable, never an empty resolved scope', () => {
    const ws = makeWorkspace(['api']);
    commit(ws.repos.api, 'src/a.js', 'feat(01-01): a', 1_700_000_000);
    const scope = phaseScope(ws);
    assert.equal(scope.status, 'unresolvable');
    assert.deepEqual(scope.files, []);
  });

  test('[negative] an unreadable sub-repo makes the phase unresolvable even when another holds the commits', () => {
    const ws = makeWorkspace(['api'], { subRepos: ['api', 'ghost'] });
    const a = commit(ws.repos.api, 'src/a.js', 'feat(01-01): a', 1_700_000_000);
    summarize(ws, [a]);
    const scope = phaseScope(ws);
    assert.equal(scope.status, 'unresolvable');
    assert.match(scope.reason, /ghost/);
  });
});

describe('#5867 the check evaluation-scope verb and commitIsAncestor', () => {
  test('[regression] the verb resolves (outcome pass-shaped, not unavailable) for a sub_repos workspace', () => {
    const ws = makeWorkspace(['app']);
    const sha = commit(ws.repos.app, 'src/thing.js', 'feat(01-01): add thing', 1_700_000_000);
    const result = evaluateEvaluationScope({ projectDir: ws.root, args: ['--plan', '01-01', '--commits-only'] });
    assert.notEqual(result.outcome, 'unreadable');
    assert.equal(result.payload.status, 'resolved');
    assert.deepEqual(result.payload.commits.map((c) => c.sha), [sha]);
  });

  test('[happy] commitIsAncestor answers from the sub-repo that holds both commits', () => {
    const ws = makeWorkspace(['api', 'web']);
    const red = commit(ws.repos.api, 'a.js', 'test(01-01): red', 1_700_000_000);
    const green = commit(ws.repos.api, 'b.js', 'feat(01-01): green', 1_700_000_100);
    commit(ws.repos.web, 'w.js', 'feat(01-01): w', 1_700_000_200);
    assert.equal(commitIsAncestor(ws.root, red, green), true);
    assert.equal(commitIsAncestor(ws.root, green, red), false);
  });

  test('[negative] commitIsAncestor is null when no sub-repo knows the commits', () => {
    const ws = makeWorkspace(['api']);
    const known = commit(ws.repos.api, 'a.js', 'feat(01-01): a', 1_700_000_000);
    assert.equal(commitIsAncestor(ws.root, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', known), null);
  });
});
