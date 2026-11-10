'use strict';

/**
 * #5867: `planning.sub_repos` workspaces. The workspace root holds `.planning/` and is not a git
 * repo; the code and the commits live in the sub-repos. The evaluation-scope resolver must look
 * in each configured sub-repo and merge what it finds, and report `unresolvable` only when a
 * configured sub-repo itself cannot be read. Behavioral tests against real git fixtures.
 */

const { describe, test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');
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

  test('[boundary] since filters the repo that holds it by ancestry and the others by its commit time', () => {
    const ws = makeWorkspace(['api', 'web']);
    commit(ws.repos.web, 'w0.js', 'feat(01-01): w before', 1_699_999_000);
    const first = commit(ws.repos.api, 'a1.js', 'feat(01-01): a1', 1_700_000_000);
    const second = commit(ws.repos.api, 'a2.js', 'feat(01-01): a2', 1_700_000_100);
    const web = commit(ws.repos.web, 'w.js', 'feat(01-01): w', 1_700_000_050);
    const atBoundary = commit(ws.repos.web, 'w2.js', 'feat(01-01): w at the boundary', 1_700_000_000);
    const scope = planScope(ws, { commitsOnly: true, since: first });
    assert.deepEqual(scope.commits.map((c) => c.sha), [second, web]);
    assert.ok(!scope.commits.some((c) => c.sha === atBoundary), 'a commit made at the since time is not newer than it');
  });

  test('[negative] a since commit no repo holds is unresolvable, never an unfiltered scope', () => {
    const ws = makeWorkspace(['api']);
    commit(ws.repos.api, 'a.js', 'feat(01-01): a', 1_700_000_000);
    const scope = planScope(ws, { commitsOnly: true, since: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' });
    assert.equal(scope.status, 'unresolvable');
    assert.equal(scope.reason, 'since-not-found');
  });

  test('[happy] the quick unit is merged across sub-repos the same way', () => {
    const ws = makeWorkspace(['api', 'web']);
    const a = commit(ws.repos.api, 'a.js', 'fix(quick-260101-abc): a', 1_700_000_000);
    const w = commit(ws.repos.web, 'w.js', 'fix(quick-260101-abc): w', 1_700_000_100);
    const scope = resolveEvaluationScope(ws.root, { kind: 'quick', id: 'quick-260101-abc' }, { commitsOnly: true });
    assert.deepEqual(scope.commits.map((c) => c.sha), [w, a]);
  });

  test('[happy] the legacy top-level sub_repos key, blank and duplicate entries and spelling variants resolve once', () => {
    const ws = makeWorkspace(['app'], { subRepos: ['app'] });
    write(ws.root, '.planning/config.json', JSON.stringify({ sub_repos: ['./app', 'app/', '  ', 'app', '.'] }));
    const sha = commit(ws.repos.app, 'src/x.js', 'feat(01-01): x', 1_700_000_000);
    const scope = planScope(ws);
    assert.deepEqual(scope.commits.map((c) => c.sha), [sha]);
    assert.deepEqual(scope.changedFiles, ['app/src/x.js']);
  });

  test('[independence] a sub-repo with no commits yet, or a ref only another repo has, contributes nothing', () => {
    const ws = makeWorkspace(['api', 'fresh']);
    const sha = commit(ws.repos.api, 'a.js', 'feat(01-01): a', 1_700_000_000);
    const empty = planScope(ws, { commitsOnly: true });
    assert.equal(empty.status, 'resolved');
    assert.deepEqual(empty.commits.map((c) => c.sha), [sha]);
    ws.repos.api.git('branch', 'only-api');
    commit(ws.repos.fresh, 'f.js', 'feat(01-01): f', 1_700_000_100);
    const byRef = planScope(ws, { commitsOnly: true, ref: 'only-api' });
    assert.equal(byRef.status, 'resolved');
    assert.deepEqual(byRef.commits.map((c) => c.sha), [sha]);
  });

  test('[negative] a ref no repo has is unresolvable', () => {
    const ws = makeWorkspace(['api']);
    commit(ws.repos.api, 'a.js', 'feat(01-01): a', 1_700_000_000);
    const scope = planScope(ws, { commitsOnly: true, ref: 'no-such-ref' });
    assert.equal(scope.status, 'unresolvable');
    assert.equal(scope.reason, 'git-failed:rev-parse');
  });

  test('[boundary] more than 64 sub_repos entries are refused (limit, limit+1)', () => {
    const names = Array.from({ length: 65 }, (_, i) => `r${i}`);
    const ws = makeWorkspace([], { subRepos: names });
    assert.equal(planScope(ws, { commitsOnly: true }).reason, 'sub-repo-too-many');
    const atLimit = makeWorkspace([], { subRepos: names.slice(0, 64) });
    assert.match(planScope(atLimit, { commitsOnly: true }).reason, /^sub-repo-unreadable:r0:/);
  });

  test('[independence] a root repo with a stale missing sub_repos entry is unresolvable, naming it', () => {
    const ws = makeWorkspace([], { rootIsRepo: true, subRepos: ['gone'] });
    commit(ws.rootRepo, 'docs/x.md', 'docs(01-01): x', 1_700_000_000);
    const scope = planScope(ws, { commitsOnly: true });
    assert.equal(scope.status, 'unresolvable');
    assert.equal(scope.reason, 'sub-repo-unreadable:gone:not-a-directory');
  });

  test('[happy] includeFiles prefixes every commit\'s own file list', () => {
    const ws = makeWorkspace(['api']);
    commit(ws.repos.api, 'src/a.js', 'feat(01-01): a', 1_700_000_000);
    const scope = planScope(ws, { includeFiles: true });
    assert.deepEqual(scope.commits[0].files, ['api/src/a.js']);
  });

  test('[independence] two config names that resolve to one repo are read once', (t) => {
    const ws = makeWorkspace(['api']);
    try {
      fs.symlinkSync(ws.repos.api.dir, path.join(ws.root, 'alias'), 'dir');
    } catch {
      t.skip('symlinks unavailable on this platform');
      return;
    }
    write(ws.root, '.planning/config.json', JSON.stringify({ planning: { sub_repos: ['api', 'alias'] } }));
    const sha = commit(ws.repos.api, 'src/a.js', 'feat(01-01): a', 1_700_000_000);
    assert.deepEqual(planScope(ws, { commitsOnly: true }).commits.map((c) => c.sha), [sha]);
  });

  test('[hyrums] --pathspec, --committed-since and --milestone-bound apply inside every repo', () => {
    const ws = makeWorkspace(['api', 'web']);
    const tagged = commit(ws.repos.api, 'src/old.js', 'feat(01-01): old', 1_700_000_000);
    ws.repos.api.git('tag', 'v1');
    const fresh = commit(ws.repos.api, 'src/new.js', 'feat(01-01): new', 1_700_000_100);
    const web = commit(ws.repos.web, 'ui/w.js', 'feat(01-01): w', 1_700_000_200);
    assert.deepEqual(planScope(ws, { commitsOnly: true, pathspecs: ['src'] }).commits.map((c) => c.sha), [fresh, tagged]);
    assert.deepEqual(planScope(ws, { commitsOnly: true, committedSince: '2023-01-01' }).commits.map((c) => c.sha), [web, fresh, tagged]);
    assert.deepEqual(planScope(ws, { commitsOnly: true, committedSince: '2030-01-01' }).commits, []);
    // api is bounded at its latest tag; web has no tag, so it is unbounded.
    assert.deepEqual(planScope(ws, { commitsOnly: true, milestoneBound: true }).commits.map((c) => c.sha), [web, fresh]);
  });

  test('[property] spelling variants of a sub_repos name all report the canonical prefix', () => {
    const ws = makeWorkspace(['app']);
    const sha = commit(ws.repos.app, 'src/x.js', 'feat(01-01): x', 1_700_000_000);
    fc.assert(fc.property(
      fc.integer({ min: 0, max: 3 }), fc.integer({ min: 0, max: 3 }), fc.boolean(), fc.boolean(),
      (dots, slashes, backslash, padded) => {
        const sep = backslash ? '\\' : '/';
        const spelled = (padded ? ' ' : '') + ('.' + sep).repeat(dots) + 'app' + sep.repeat(slashes) + (padded ? ' ' : '');
        write(ws.root, '.planning/config.json', JSON.stringify({ planning: { sub_repos: [spelled] } }));
        const scope = planScope(ws);
        assert.equal(scope.status, 'resolved', spelled);
        assert.deepEqual(scope.commits.map((c) => c.sha), [sha]);
        assert.deepEqual(scope.changedFiles, ['app/src/x.js']);
      },
    ), { numRuns: 12 });
  });

  test('[property] the merged list is the newest-first slice of every repo\'s commits, whatever the times and limit', () => {
    fc.assert(fc.property(
      fc.array(fc.tuple(fc.boolean(), fc.integer({ min: 1, max: 40 })), { minLength: 1, maxLength: 7 }),
      fc.integer({ min: 1, max: 9 }),
      (spec, max) => {
        const ws = makeWorkspace(['api', 'web']);
        // Times strictly increase along one repo's history; the two repos' clocks are offset so no two
        // commits share a time, which makes the newest-first order total.
        const last = { api: 1_700_000_000, web: 1_700_000_000 + 1000 };
        const used = new Set();
        const made = spec.map(([inApi, delta], i) => {
          const name = inApi ? 'api' : 'web';
          last[name] += delta;
          while (used.has(last[name])) last[name] += 1;
          used.add(last[name]);
          return { time: last[name], order: i, sha: commit(ws.repos[name], `f${i}.js`, `feat(01-01): c${i}`, last[name]) };
        });
        const expected = [...made].sort((a, b) => b.time - a.time || b.order - a.order).slice(0, max);
        const got = planScope(ws, { commitsOnly: true, maxCommits: max }).commits.map((c) => c.sha);
        assert.equal(got.length, Math.min(max, made.length));
        assert.deepEqual(got, expected.map((m) => m.sha));
        cleanup(ws.root);
      },
    ), { numRuns: 8 });
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
    assert.equal(scope.reason, 'sub-repo-unreadable:ghost:not-a-directory');
    assert.deepEqual(scope.commits, []);
  });

  test('[negative] a configured directory that is not a git repo is unresolvable', () => {
    const ws = makeWorkspace(['api']);
    fs.mkdirSync(path.join(ws.root, 'plain'));
    write(ws.root, '.planning/config.json', JSON.stringify({ planning: { sub_repos: ['api', 'plain'] } }));
    commit(ws.repos.api, 'a.js', 'feat(01-01): a', 1_700_000_000);
    const scope = planScope(ws, { commitsOnly: true });
    assert.equal(scope.status, 'unresolvable');
    assert.match(scope.reason, /^sub-repo-unreadable:plain:/);
  });

  test('[independence] a plain folder of the root repo is covered by the root repo, not refused', () => {
    const ws = makeWorkspace([], { rootIsRepo: true, subRepos: ['inner'] });
    write(ws.root, 'inner/x.js', 'x\n');
    const sha = commit(ws.rootRepo, 'inner/y.js', 'feat(01-01): y', 1_700_000_000);
    const scope = planScope(ws, { commitsOnly: true });
    assert.equal(scope.status, 'resolved');
    assert.deepEqual(scope.commits.map((c) => c.sha), [sha]);
  });

  test('[negative] a plain folder under a non-root parent repo is refused, never read through that parent', () => {
    const parent = makeWorkspace([], { rootIsRepo: true, subRepos: [] });
    const ws = { root: path.join(parent.root, 'ws') };
    write(ws.root, '.planning/config.json', JSON.stringify({ planning: { sub_repos: ['inner'] } }));
    write(ws.root, 'inner/x.js', 'x\n');
    commit(parent.rootRepo, 'ws/inner/y.js', 'feat(01-01): y', 1_700_000_000);
    const scope = planScope(ws, { commitsOnly: true });
    assert.equal(scope.status, 'unresolvable');
    assert.equal(scope.reason, 'sub-repo-unreadable:inner:not-a-repo-root');
  });

  for (const [label, entry, expected] of [
    ['a parent-escaping path', '../outside', /^sub-repo-escapes-root:\.\.\/outside$/],
    ['an absolute path', path.join(os.tmpdir(), 'elsewhere'), /^sub-repo-escapes-root:/],
    ['a nested parent segment', 'a/../../outside', /^sub-repo-escapes-root:\.\.\/outside$/],
    ['a NUL byte', 'app\0x', /^sub-repo-escapes-root:/],
    ['a non-string entry', 42, /^sub-repo-invalid:0$/],
  ]) {
    test(`[hostile] ${label} in sub_repos is refused as unresolvable`, () => {
      const ws = makeWorkspace([], { subRepos: [entry] });
      const scope = planScope(ws, { commitsOnly: true });
      assert.equal(scope.status, 'unresolvable');
      assert.match(scope.reason, expected);
    });
  }

  test('[hostile] a sub-repo .git/config cannot make a signed commit run a program', (t) => {
    if (process.platform === 'win32') { t.skip('POSIX shell script fixture'); return; }
    const ws = makeWorkspace(['app']);
    const repo = ws.repos.app;
    const first = commit(repo, 'a.js', 'feat(01-01): a', 1_700_000_000);
    const marker = path.join(ws.root, 'gpg-ran');
    const program = path.join(ws.root, 'fake-gpg.sh');
    fs.writeFileSync(program, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o755 });
    // A commit object carrying a gpgsig header, so `git log` with showSignature would call gpg.
    const tree = repo.git('rev-parse', `${first}^{tree}`);
    const raw = `tree ${tree}\nparent ${first}\nauthor T <t@t.io> 1700000100 +0000\ncommitter T <t@t.io> 1700000100 +0000\n`
      + 'gpgsig -----BEGIN PGP SIGNATURE-----\n \n fake\n -----END PGP SIGNATURE-----\n\nfeat(01-01): signed\n';
    const objectFile = path.join(ws.root, 'signed-commit.txt');
    fs.writeFileSync(objectFile, raw);
    const signed = repo.git('hash-object', '-t', 'commit', '-w', objectFile);
    repo.git('update-ref', 'HEAD', signed);
    repo.git('config', 'log.showSignature', 'true');
    repo.git('config', 'gpg.program', program);
    const scope = planScope(ws);
    assert.equal(scope.status, 'resolved');
    assert.ok(scope.commits.some((c) => c.sha === signed));
    assert.equal(fs.existsSync(marker), false, 'gpg.program from the sub-repo config must never run');
  });

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
    assert.equal(scope.reason, 'sub-repo-escapes-root:link');
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
    commit(ws.repos.web, 'ui/base.js', 'feat(01-01): base', 1_700_000_050);
    ws.repos.web.git('checkout', '-b', 'side');
    const side = commit(ws.repos.web, 'ui/side.js', 'feat(01-01): side', 1_700_000_100);
    ws.repos.web.git('checkout', 'main');
    summarize(ws, [a, side]);
    const scope = phaseScope(ws);
    assert.deepEqual(scope.files, ['api/src/a.js']);
    assert.deepEqual(scope.unreachable, [side]);
  });

  test('[boundary] since on a phase filters the holder by ancestry and the other repos by its commit time', () => {
    const ws = makeWorkspace(['api', 'web']);
    const earlyWeb = commit(ws.repos.web, 'ui/early.js', 'feat(01-01): web early', 1_699_999_000);
    const first = commit(ws.repos.api, 'src/a1.js', 'feat(01-01): a1', 1_700_000_000);
    const second = commit(ws.repos.api, 'src/a2.js', 'feat(01-01): a2', 1_700_000_100);
    const lateWeb = commit(ws.repos.web, 'ui/late.js', 'feat(01-01): web late', 1_700_000_050);
    summarize(ws, [earlyWeb, first, second, lateWeb]);
    const scope = phaseScope(ws, { since: first });
    assert.equal(scope.status, 'resolved');
    assert.deepEqual(scope.files, ['api/src/a2.js', 'web/ui/late.js']);
  });

  test('[negative] an ambiguous short id in one repo is named unreachable and the other repo still resolves', () => {
    const ws = makeWorkspace(['api', 'web']);
    const a = commit(ws.repos.api, 'src/a.js', 'feat(01-01): a', 1_700_000_000);
    const w = commit(ws.repos.web, 'ui/w.js', 'feat(01-01): w', 1_700_000_100);
    summarize(ws, [a, w]);
    const { execGit } = require('../gsd-core/bin/lib/shell-command-projection.cjs');
    const ambiguousInWeb = (args, opts) => (opts && fs.realpathSync(opts.cwd) === fs.realpathSync(ws.repos.web.dir) && args.includes(`${w}^{commit}`)
      ? { exitCode: 128, stdout: '', stderr: 'ambiguous', timedOut: false }
      : execGit(args, opts));
    const scope = phaseScope(ws, { execGit: ambiguousInWeb });
    assert.equal(scope.status, 'resolved');
    assert.deepEqual(scope.files, ['api/src/a.js']);
    assert.deepEqual(scope.unreachable, [w]);
  });

  test('[independence] a root repo that tracks the phase never lets its degraded range override task commits', () => {
    const ws = makeWorkspace(['api'], { rootIsRepo: true });
    write(ws.root, '.gitignore', 'api/\n');
    ws.rootRepo.git('add', '.');
    ws.rootRepo.gitAt({}, 'commit', '-m', 'docs(01): scaffold');
    const a = commit(ws.repos.api, 'src/a.js', 'feat(01-01): a', 1_700_000_000);
    summarize(ws, [a]);
    const scope = phaseScope(ws);
    assert.equal(scope.status, 'resolved');
    assert.equal(scope.source, 'task-commits');
    assert.deepEqual(scope.files, ['api/src/a.js']);
  });

  test('[boundary] ids x repos over the lookup budget are refused (limit-1, limit, limit+1)', () => {
    const ws = makeWorkspace(['api']);
    const a = commit(ws.repos.api, 'src/a.js', 'feat(01-01): a', 1_700_000_000);
    const { execGit } = require('../gsd-core/bin/lib/shell-command-projection.cjs');
    // Unknown ids answer "no such commit" at once, so the budget is exercised without thousands of spawns.
    const noSuchCommit = (args, opts) => (args.some((arg) => /^0{20,}[0-9a-f]*\^\{commit\}$/.test(arg))
      ? { exitCode: 1, stdout: '', stderr: '', timedOut: false }
      : execGit(args, opts));
    const fake = (n) => Array.from({ length: n }, (_, i) => i.toString(16).padStart(40, '0'));
    for (const [ids, refused] of [[1023, false], [1024, false], [1025, true]]) {
      summarize(ws, [a, ...fake(ids - 1)]);
      const scope = phaseScope(ws, { execGit: noSuchCommit });
      assert.equal(scope.reason === 'sub-repo-too-many-lookups', refused, `${ids} ids`);
      if (!refused) {
        assert.equal(scope.status, 'resolved', `${ids} ids`);
        assert.equal(scope.unreachable.length, ids - 1, `${ids} ids`);
      }
    }
  });

  test('[negative] no SUMMARY and no anchor is a loud empty degraded scope, never a pass-shaped one', () => {
    const ws = makeWorkspace(['api']);
    commit(ws.repos.api, 'src/a.js', 'feat(01-01): a', 1_700_000_000);
    const scope = phaseScope(ws);
    assert.equal(scope.status, 'degraded');
    assert.equal(scope.source, 'phase-range');
    assert.equal(scope.reason, 'no-summary:no-phase-start-anchor');
    assert.deepEqual(scope.files, []);
    const verdict = evaluateEvaluationScope({ projectDir: ws.root, args: ['--phase', '1'] });
    assert.equal(verdict.outcome, 'advisory');
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

  test('[negative] a timeout in one repo is never read as "no" because a clone listed after it answered false', () => {
    const ws = makeWorkspace(['api', 'clone']);
    const red = commit(ws.repos.api, 'a.js', 'test(01-01): red', 1_700_000_000);
    const green = commit(ws.repos.api, 'b.js', 'feat(01-01): green', 1_700_000_100);
    const cloneDir = path.join(ws.root, 'clone');
    cleanup(cloneDir);
    gitOrThrow(['clone', '-q', ws.repos.api.dir, cloneDir], { env: { ...process.env, ...IDENTITY } });
    const { execGit } = require('../gsd-core/bin/lib/shell-command-projection.cjs');
    const timingOutInApi = (args, opts) => (opts && fs.realpathSync(opts.cwd) === fs.realpathSync(ws.repos.api.dir)
      ? { exitCode: 1, stdout: '', stderr: '', timedOut: true }
      : execGit(args, opts));
    // The clone holds both commits and would say "no" (green is not an ancestor of red).
    assert.equal(commitIsAncestor(ws.root, green, red), false);
    assert.equal(commitIsAncestor(ws.root, green, red, timingOutInApi), null);
  });

  test('[negative] commitIsAncestor is null when no sub-repo knows the commits', () => {
    const ws = makeWorkspace(['api']);
    const known = commit(ws.repos.api, 'a.js', 'feat(01-01): a', 1_700_000_000);
    assert.equal(commitIsAncestor(ws.root, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', known), null);
  });
});
