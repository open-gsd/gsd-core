/**
 * Repository-scoped release tags (#5705, epic #3628 Phase 1).
 *
 * Behavioral tests over real temporary git repositories. The single injected
 * seam is `{ execGit }` (row 18 and the zero-git-call assertions); every other
 * row drives the real git binary. Row 23 (no edits to tests/config.test.cjs)
 * is a diff property, not a runtime test.
 */

'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const fc = require('fast-check');
const { cleanup } = require('./helpers.cjs');
const { GIT_FIXTURE_TIMEOUT_MS, GSD_TOOLS_CLI_MODERATE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

const TOOLS_PATH = path.join(__dirname, '..', 'gsd-core', 'bin', 'gsd-tools.cjs');
const CONTEXT_PATH = path.join(__dirname, '..', 'CONTEXT.md');

const mod = require('../gsd-core/bin/lib/milestone-release-tags.cjs');
const { execGit: realExecGit } = require('../gsd-core/bin/lib/shell-command-projection.cjs');
const {
  preflightReleaseTags,
  createReleaseTags,
  RELEASE_TAG_REASONS,
  MAX_RELEASE_TAG_ENTRIES,
} = mod;

// ─── helpers ────────────────────────────────────────────────────────────────

function git(dir, ...args) {
  return execFileSync('git', args, {
    cwd: dir,
    encoding: 'utf-8',
    timeout: GIT_FIXTURE_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function gitStatus(dir, ...args) {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf-8', timeout: GIT_FIXTURE_TIMEOUT_MS });
  return { status: r.status, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() };
}

function initRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.name', 't');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'config', 'tag.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  git(dir, 'add', 'a.txt');
  git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'first');
  return git(dir, 'rev-parse', 'HEAD');
}

function addCommit(dir, name) {
  fs.writeFileSync(path.join(dir, name), `${name}\n`);
  git(dir, 'add', name);
  git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', name);
  return git(dir, 'rev-parse', 'HEAD');
}

function tagExists(dir, tag) {
  return gitStatus(dir, 'show-ref', '--verify', '--quiet', `refs/tags/${tag}`).status === 0;
}

function writeConfig(root, subRepos) {
  fs.mkdirSync(path.join(root, '.planning'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.planning', 'config.json'),
    JSON.stringify({ sub_repos: subRepos }),
  );
  fs.writeFileSync(path.join(root, '.planning', 'STATE.md'), '# State\n');
}

/** A project root with the named sub-repos initialised as git repos. */
function makeProject(t, repoNames, { init = true } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-reltags-')));
  t.after(() => cleanup(root));
  const shas = {};
  for (const name of repoNames) {
    if (init) shas[name] = initRepo(path.join(root, name));
  }
  writeConfig(root, repoNames);
  return { root, shas };
}

function countingGit(real) {
  const calls = [];
  const fn = (args, opts) => {
    calls.push({ args, opts });
    return real ? real(args, opts) : { exitCode: 0, stdout: '', stderr: '', signal: null, error: null, timedOut: false };
  };
  fn.calls = calls;
  return fn;
}

function timeoutResult() {
  const error = Object.assign(new Error('spawnSync git ETIMEDOUT'), { code: 'ETIMEDOUT' });
  return { exitCode: 1, stdout: '', stderr: '', signal: 'SIGTERM', error, timedOut: true };
}

function runCli(cwd, args) {
  const r = spawnSync(process.execPath, [TOOLS_PATH, ...args], {
    cwd,
    encoding: 'utf-8',
    timeout: GSD_TOOLS_CLI_MODERATE_TIMEOUT_MS,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function writeMap(root, entries, name = 'map.json') {
  const p = path.join(root, name);
  fs.writeFileSync(p, JSON.stringify(entries));
  return p;
}

// ─── tests ──────────────────────────────────────────────────────────────────

describe('release tags: creation (rows 1, 2, 7, 9, 12, 16)', () => {
  test('creates annotated tags in each repo (row 1)', (t) => {
    const { root, shas } = makeProject(t, ['api', 'web']);
    const res = createReleaseTags(root, [
      { repo: 'api', tag: 'v1.2.0' },
      { repo: 'web', tag: 'v3.4.0', message: 'web release' },
    ]);
    assert.equal(res.ok, true);
    assert.equal(res.phase, 'apply');
    assert.equal(res.repos.api.status, 'created');
    assert.equal(res.repos.api.tag, 'v1.2.0');
    assert.equal(res.repos.api.commit, shas.api);
    assert.equal(res.repos.web.status, 'created');
    assert.deepEqual([...res.created].sort(), ['api:v1.2.0', 'web:v3.4.0']);
    assert.deepEqual(res.errors, []);
    assert.equal(git(path.join(root, 'api'), 'cat-file', '-t', 'v1.2.0'), 'tag');
    assert.equal(git(path.join(root, 'api'), 'rev-parse', 'v1.2.0^{commit}'), shas.api);
    assert.equal(git(path.join(root, 'web'), 'cat-file', '-t', 'v3.4.0'), 'tag');
    assert.equal(git(path.join(root, 'web'), 'tag', '-l', '--format=%(contents)', 'v3.4.0'), 'web release');
    assert.equal(git(path.join(root, 'api'), 'tag', '-l', '--format=%(contents)', 'v1.2.0'), 'v1.2.0');
  });

  test('skip entry writes nothing (row 2)', (t) => {
    const { root } = makeProject(t, ['api', 'web']);
    const exec = countingGit();
    const res = createReleaseTags(root, [
      { repo: 'api', tag: 'v1.0.0' },
      { repo: 'web', skip: true },
    ]);
    assert.equal(res.ok, true);
    assert.equal(res.repos.web.status, 'skipped');
    assert.equal(tagExists(path.join(root, 'web'), 'v1.0.0'), false);
    assert.equal(git(path.join(root, 'web'), 'tag', '-l'), '');
    assert.deepEqual(res.created, ['api:v1.0.0']);
    // A skip entry with no tag fields at all is not preflighted.
    const only = createReleaseTags(root, [{ repo: 'web', skip: true }], { execGit: exec });
    assert.equal(only.ok, true);
    assert.equal(only.repos.web.status, 'skipped');
    assert.equal(exec.calls.length, 0);
  });

  test('resolves ref, default HEAD (row 7)', (t) => {
    const { root, shas } = makeProject(t, ['api']);
    const repo = path.join(root, 'api');
    const second = addCommit(repo, 'b.txt');
    const branch = git(repo, 'rev-parse', '--abbrev-ref', 'HEAD');

    const def = createReleaseTags(root, [{ repo: 'api', tag: 'tdefault' }]);
    assert.equal(def.repos.api.commit, second);

    const prev = createReleaseTags(root, [{ repo: 'api', tag: 'tprev', ref: 'HEAD~1' }]);
    assert.equal(prev.ok, true);
    assert.equal(prev.repos.api.commit, shas.api);
    assert.equal(git(repo, 'rev-parse', 'tprev^{commit}'), shas.api);

    const byBranch = createReleaseTags(root, [{ repo: 'api', tag: 'tbranch', ref: branch }]);
    assert.equal(byBranch.repos.api.commit, second);
  });

  test('idempotent when tag already at commit (row 9)', (t) => {
    const { root, shas } = makeProject(t, ['api']);
    const repo = path.join(root, 'api');
    git(repo, 'tag', '-a', '-m', 'pre', 'v1.0.0');
    const objBefore = git(repo, 'rev-parse', 'v1.0.0');

    const pre = preflightReleaseTags(root, [{ repo: 'api', tag: 'v1.0.0' }]);
    assert.equal(pre.ok, true);
    assert.equal(pre.repos.api.status, 'already_tagged');

    const res = createReleaseTags(root, [{ repo: 'api', tag: 'v1.0.0' }]);
    assert.equal(res.ok, true);
    assert.equal(res.repos.api.status, 'already_tagged');
    assert.equal(res.repos.api.commit, shas.api);
    assert.deepEqual(res.created, []);
    assert.equal(git(repo, 'rev-parse', 'v1.0.0'), objBefore);
  });

  test('tags on detached HEAD (row 12)', (t) => {
    const { root, shas } = makeProject(t, ['api']);
    const repo = path.join(root, 'api');
    git(repo, 'checkout', '-q', '--detach');
    const res = createReleaseTags(root, [{ repo: 'api', tag: 'vd' }]);
    assert.equal(res.ok, true);
    assert.equal(res.repos.api.status, 'created');
    assert.equal(res.repos.api.detached_head, true);
    assert.equal(git(repo, 'rev-parse', 'vd^{commit}'), shas.api);

    const attached = makeProject(t, ['web']);
    const ok = createReleaseTags(attached.root, [{ repo: 'web', tag: 'va' }]);
    assert.notEqual(ok.repos.web.detached_head, true);
  });

  test('dry run writes nothing (row 16)', (t) => {
    const { root, shas } = makeProject(t, ['api', 'web']);
    const res = createReleaseTags(
      root,
      [{ repo: 'api', tag: 'v1.0.0' }, { repo: 'web', tag: 'v2.0.0' }],
      { dryRun: true },
    );
    assert.equal(res.ok, true);
    assert.equal(res.phase, 'dry_run');
    assert.equal(res.repos.api.status, 'would_create');
    assert.equal(res.repos.api.commit, shas.api);
    assert.equal(res.repos.web.status, 'would_create');
    assert.deepEqual(res.created, []);
    assert.equal(tagExists(path.join(root, 'api'), 'v1.0.0'), false);
    assert.equal(tagExists(path.join(root, 'web'), 'v2.0.0'), false);
  });

  test('uncommitted changes are not an error', (t) => {
    const { root } = makeProject(t, ['api']);
    fs.writeFileSync(path.join(root, 'api', 'a.txt'), 'dirty\n');
    const res = createReleaseTags(root, [{ repo: 'api', tag: 'vdirty' }]);
    assert.equal(res.ok, true);
    assert.equal(res.repos.api.status, 'created');
  });
});

describe('release tags: preflight rejections (rows 3-6, 8, 10, 11, 17)', () => {
  test('rejects unconfigured repo, writes nothing (row 3)', (t) => {
    const { root } = makeProject(t, ['api']);
    // loadConfig auto-syncs sub_repos with first-level git directories, so a repo only
    // counts as unconfigured when it is nested deeper than the project root's children.
    initRepo(path.join(root, 'nested', 'stray'));
    const res = createReleaseTags(root, [
      { repo: 'api', tag: 'v1.0.0' },
      { repo: 'nested/stray', tag: 'v1.0.0' },
    ]);
    assert.equal(res.ok, false);
    assert.equal(res.phase, 'preflight');
    assert.ok(res.errors.some((e) => e.repo === 'nested/stray' && e.reason === 'repo_not_configured'));
    assert.equal(tagExists(path.join(root, 'api'), 'v1.0.0'), false);
    assert.equal(tagExists(path.join(root, 'nested', 'stray'), 'v1.0.0'), false);
    assert.deepEqual(res.created, []);
  });

  test('normalizes ./ prefix and trailing slash for configuration match (row 3)', (t) => {
    const { root } = makeProject(t, ['api']);
    const res = preflightReleaseTags(root, [{ repo: './api/', tag: 'v1.0.0' }]);
    assert.equal(res.ok, true);
    assert.equal(res.repos.api.status, 'would_create');
  });

  test('rejects escaping paths (row 4)', (t) => {
    const { root } = makeProject(t, ['a']);
    for (const bad of ['../x', '/abs', 'a\\..\\b', './a/..', 'a/../..', '..\\x', 'C:\\x']) {
      const exec = countingGit();
      const res = createReleaseTags(root, [{ repo: bad, tag: 'v1' }], { execGit: exec });
      assert.equal(res.ok, false, bad);
      assert.equal(res.errors.length, 1, bad);
      assert.equal(res.errors[0].reason, 'repo_path_invalid', bad);
      assert.equal(exec.calls.length, 0, `no git call for ${bad}`);
    }
  });

  test('a deleted repo and one that lost its .git are unconfigured after the config sync (row 5)', (t) => {
    const { root } = makeProject(t, ['gone', 'plain', 'okrepo']);
    cleanup(path.join(root, 'gone'));
    cleanup(path.join(root, 'plain', '.git'));
    const res = createReleaseTags(root, [
      { repo: 'gone', tag: 'v1' },
      { repo: 'plain', tag: 'v1' },
      { repo: 'okrepo', tag: 'v1' },
    ]);
    assert.equal(res.ok, false);
    // loadConfig drops a deleted directory, and a directory that lost its .git, from
    // sub_repos, so both are unconfigured rather than "missing" / "not a git repo".
    assert.equal(res.repos.gone.reason, 'repo_not_configured');
    assert.equal(res.repos.plain.reason, 'repo_not_configured');
    assert.equal(tagExists(path.join(root, 'okrepo'), 'v1'), false);
  });

  test('a configured repo whose directory vanishes after config load is repo_missing (row 5)', (t) => {
    const { root } = makeProject(t, ['ghost', 'okrepo']);
    const original = fs.statSync;
    t.after(() => { fs.statSync = original; });
    fs.statSync = function patched(p, ...rest) {
      if (String(p).endsWith(`${path.sep}ghost`)) {
        throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
      }
      return original.call(this, p, ...rest);
    };
    let res;
    try {
      res = createReleaseTags(root, [
        { repo: 'ghost', tag: 'v1' },
        { repo: 'okrepo', tag: 'v1' },
      ]);
    } finally {
      fs.statSync = original;
    }
    assert.equal(res.ok, false);
    assert.equal(res.repos.ghost.reason, 'repo_missing');
    assert.equal(tagExists(path.join(root, 'okrepo'), 'v1'), false);
  });

  test('a plain directory inside a git project is not a git repo (row 5)', (t) => {
    const { root } = makeProject(t, ['plain'], { init: false });
    initRepo(root);
    fs.mkdirSync(path.join(root, 'plain'), { recursive: true });
    const res = preflightReleaseTags(root, [{ repo: 'plain', tag: 'v1' }]);
    assert.equal(res.ok, false);
    assert.equal(res.repos.plain.reason, 'not_a_git_repo');
  });

  test('validates tag names (row 6)', (t) => {
    const { root } = makeProject(t, ['api']);
    for (const bad of ['', '-x', 'a b', 'a..b', 'a/', '--force']) {
      const res = preflightReleaseTags(root, [{ repo: 'api', tag: bad }]);
      assert.equal(res.ok, false, JSON.stringify(bad));
      assert.equal(res.repos.api.reason, 'tag_invalid', JSON.stringify(bad));
    }
    for (const good of ['v1.0', 'release/1.2']) {
      const res = preflightReleaseTags(root, [{ repo: 'api', tag: good }]);
      assert.equal(res.ok, true, good);
      assert.equal(res.repos.api.status, 'would_create', good);
    }
    const slashed = createReleaseTags(root, [{ repo: 'api', tag: 'release/1.2' }]);
    assert.equal(slashed.ok, true);
    assert.equal(tagExists(path.join(root, 'api'), 'release/1.2'), true);
  });

  test('rejects unresolved ref (row 8)', (t) => {
    const { root } = makeProject(t, ['api']);
    const repo = path.join(root, 'api');
    const blob = git(repo, 'hash-object', '-w', 'a.txt');
    git(repo, 'tag', 'blobtag', blob);
    for (const ref of ['no-such-ref', 'blobtag', '-evil']) {
      const res = createReleaseTags(root, [{ repo: 'api', tag: 'v9', ref }]);
      assert.equal(res.ok, false, ref);
      assert.equal(res.repos.api.reason, 'ref_unresolved', ref);
      assert.equal(tagExists(repo, 'v9'), false, ref);
    }
  });

  test('never overwrites a conflicting tag (row 10)', (t) => {
    const { root, shas } = makeProject(t, ['api', 'web']);
    const apiRepo = path.join(root, 'api');
    const second = addCommit(apiRepo, 'b.txt');
    git(apiRepo, 'tag', '-a', '-m', 'old', 'v1.0.0', shas.api);
    const before = git(apiRepo, 'rev-parse', 'v1.0.0');

    const res = createReleaseTags(root, [
      { repo: 'api', tag: 'v1.0.0' },
      { repo: 'web', tag: 'v1.0.0' },
    ]);
    assert.equal(res.ok, false);
    assert.equal(res.phase, 'preflight');
    assert.equal(res.repos.api.reason, 'tag_conflict');
    assert.equal(res.repos.api.existing_commit, shas.api);
    assert.equal(res.repos.api.requested_commit, second);
    assert.equal(git(apiRepo, 'rev-parse', 'v1.0.0'), before);
    assert.equal(tagExists(path.join(root, 'web'), 'v1.0.0'), false);
    assert.deepEqual(res.created, []);
  });

  test('rejects duplicate entries (row 11)', (t) => {
    const { root } = makeProject(t, ['api']);
    const res = createReleaseTags(root, [
      { repo: 'api', tag: 'v1.0.0' },
      { repo: 'api', tag: 'v1.0.0' },
    ]);
    assert.equal(res.ok, false);
    assert.ok(res.errors.some((e) => e.reason === 'duplicate_entry'));
    assert.equal(tagExists(path.join(root, 'api'), 'v1.0.0'), false);
  });

  test('one repo may receive two different tags, keyed repo:tag (row 11 negative space)', (t) => {
    const { root, shas } = makeProject(t, ['api', 'web']);
    const res = createReleaseTags(root, [
      { repo: 'api', tag: 'v1.0.0' },
      { repo: 'api', tag: 'stable' },
      { repo: 'web', tag: 'v2.0.0' },
    ]);
    assert.equal(res.ok, true);
    assert.equal(res.repos['api:v1.0.0'].status, 'created');
    assert.equal(res.repos['api:stable'].status, 'created');
    assert.equal(res.repos['api:stable'].commit, shas.api);
    assert.equal(res.repos.web.status, 'created');
    assert.deepEqual([...res.created].sort(), ['api:stable', 'api:v1.0.0', 'web:v2.0.0']);
    assert.equal(tagExists(path.join(root, 'api'), 'v1.0.0'), true);
    assert.equal(tagExists(path.join(root, 'api'), 'stable'), true);
  });

  test('errors without sub_repos (row 17)', (t) => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-reltags-')));
    t.after(() => cleanup(root));
    writeConfig(root, []);
    initRepo(path.join(root, 'api'));
    const exec = countingGit();
    const res = createReleaseTags(root, [{ repo: 'api', tag: 'v1' }], { execGit: exec });
    assert.equal(res.ok, false);
    assert.equal(res.errors[0].reason, 'no_sub_repos');
    assert.equal(exec.calls.length, 0);
    assert.equal(tagExists(path.join(root, 'api'), 'v1'), false);
  });
});

describe('release tags: partial failure and retry (rows 13, 14)', () => {
  function setup(t, names = ['api', 'web']) {
    const p = makeProject(t, names);
    // A loose ref `refs/tags/v2/child` makes `refs/tags/v2` a directory, so
    // creating the tag `v2` in this repo fails portably (D/F conflict).
    const blocker = path.join(p.root, 'web', '.git', 'refs', 'tags', 'v2');
    fs.mkdirSync(blocker, { recursive: true });
    fs.writeFileSync(path.join(blocker, 'child'), `${p.shas.web}\n`);
    return { ...p, blocker };
  }

  test('partial failure reports created tags (row 13)', (t) => {
    const { root } = setup(t);
    const res = createReleaseTags(root, [
      { repo: 'api', tag: 'v2' },
      { repo: 'web', tag: 'v2' },
    ]);
    assert.equal(res.ok, false);
    assert.equal(res.phase, 'apply');
    assert.equal(res.repos.api.status, 'created');
    assert.equal(res.repos.web.status, 'failed');
    assert.equal(res.repos.web.reason, 'tag_create_failed');
    assert.deepEqual(res.created, ['api:v2']);
    assert.ok(res.errors.some((e) => e.repo === 'web' && e.reason === 'tag_create_failed'));
    assert.equal(tagExists(path.join(root, 'api'), 'v2'), true);
  });

  test('retry after partial failure (row 14)', (t) => {
    const { root, blocker } = setup(t);
    const map = [
      { repo: 'api', tag: 'v2' },
      { repo: 'web', tag: 'v2' },
    ];
    const first = createReleaseTags(root, map);
    assert.equal(first.ok, false);
    cleanup(blocker);
    const second = createReleaseTags(root, map);
    assert.equal(second.ok, true);
    assert.equal(second.repos.api.status, 'already_tagged');
    assert.equal(second.repos.web.status, 'created');
    assert.deepEqual(second.created, ['web:v2']);
  });

  test('failure of an earlier repo does not stop later repos (row 13)', (t) => {
    const { root } = setup(t, ['web', 'api']);
    const res = createReleaseTags(root, [
      { repo: 'web', tag: 'v2' },
      { repo: 'api', tag: 'v2' },
    ]);
    assert.equal(res.ok, false);
    assert.equal(res.repos.web.status, 'failed');
    assert.equal(res.repos.api.status, 'created');
    assert.deepEqual(res.created, ['api:v2']);
  });
});

describe('release tags: cwd independence, bounds, argv safety (rows 15, 18, 19)', () => {
  test('cwd independent (row 15)', (t) => {
    const { root, shas } = makeProject(t, ['api', 'web']);
    fs.mkdirSync(path.join(root, 'nested', 'deeper'), { recursive: true });
    const map = (name) => writeMap(root, [
      { repo: 'api', tag: name },
      { repo: 'web', tag: name },
    ], `map-${name}.json`);

    const cwds = [
      ['from-root', root],
      ['from-nested', path.join(root, 'nested', 'deeper')],
      ['from-subrepo', path.join(root, 'api')],
    ];
    for (const [name, cwd] of cwds) {
      const r = runCli(cwd, ['milestone', 'release-tags', '--map', map(name)]);
      assert.equal(r.status, 0, `${name}: ${r.stderr}${r.stdout}`);
      const out = JSON.parse(r.stdout);
      assert.equal(out.ok, true, name);
      assert.equal(out.repos.api.commit, shas.api, name);
      assert.equal(out.repos.web.commit, shas.web, name);
      assert.equal(tagExists(path.join(root, 'api'), name), true, name);
      assert.equal(tagExists(path.join(root, 'web'), name), true, name);
    }
  });

  test('every git call runs in the repo directory with a 15s bound (row 15)', (t) => {
    const { root } = makeProject(t, ['api']);
    const exec = countingGit(realExecGit);
    const res = createReleaseTags(root, [{ repo: 'api', tag: 'vc' }], { execGit: exec });
    assert.equal(res.ok, true);
    assert.ok(exec.calls.length > 0);
    for (const call of exec.calls) {
      assert.equal(call.opts.cwd, path.join(root, 'api'), `git ${call.args.join(' ')}`);
      assert.equal(call.opts.timeout, 15000);
    }
  });

  test('bounds git subprocesses (row 18)', (t) => {
    const { root } = makeProject(t, ['api', 'web']);
    // Every git call times out: preflight reports git_timeout per repo, never throws.
    const pre = createReleaseTags(root, [
      { repo: 'api', tag: 'v1' },
      { repo: 'web', tag: 'v1' },
    ], { execGit: () => timeoutResult() });
    assert.equal(pre.ok, false);
    assert.equal(pre.repos.api.reason, 'git_timeout');
    assert.equal(pre.repos.web.reason, 'git_timeout');

    // Only the tag write times out: apply reports failed/git_timeout; later repos still attempted.
    const tagTimesOutInApi = (args, opts) => {
      if (args[0] === 'tag' && args.includes('-a') && opts.cwd.endsWith(`${path.sep}api`)) return timeoutResult();
      return realExecGit(args, opts);
    };
    const res = createReleaseTags(root, [
      { repo: 'api', tag: 'v2' },
      { repo: 'web', tag: 'v2' },
    ], { execGit: tagTimesOutInApi });
    assert.equal(res.ok, false);
    assert.equal(res.repos.api.status, 'failed');
    assert.equal(res.repos.api.reason, 'git_timeout');
    assert.equal(res.repos.web.status, 'created');
    assert.deepEqual(res.created, ['web:v2']);
  });

  test('message passed as argv (row 19)', (t) => {
    const { root } = makeProject(t, ['api']);
    const marker = path.join(root, 'PWNED');
    const message = `-rf "quoted" $(touch ${marker}) \`touch ${marker}\` 'single'\nsecond line`;
    const res = createReleaseTags(root, [{ repo: 'api', tag: 'vm', message }]);
    assert.equal(res.ok, true);
    assert.equal(fs.existsSync(marker), false);
    assert.equal(git(path.join(root, 'api'), 'tag', '-l', '--format=%(contents)', 'vm'), message);
  });
});

describe('release tags: request size and shape (row 20)', () => {
  function bigProject(t) {
    const names = Array.from({ length: MAX_RELEASE_TAG_ENTRIES + 1 }, (_, i) => `r${i}`);
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-reltags-')));
    t.after(() => cleanup(root));
    writeConfig(root, names);
    return { root, names };
  }

  test('MAX_RELEASE_TAG_ENTRIES is 256', () => {
    assert.equal(MAX_RELEASE_TAG_ENTRIES, 256);
  });

  test('255 and 256 entries accepted, 257 rejected before any git call', (t) => {
    const { root, names } = bigProject(t);
    for (const n of [MAX_RELEASE_TAG_ENTRIES - 1, MAX_RELEASE_TAG_ENTRIES]) {
      const exec = countingGit();
      const res = createReleaseTags(root, names.slice(0, n).map((repo) => ({ repo, skip: true })), { execGit: exec });
      assert.equal(res.ok, true, `n=${n}`);
      assert.equal(Object.keys(res.repos).length, n);
      assert.equal(exec.calls.length, 0, `n=${n}`);
    }
    const exec = countingGit();
    const over = createReleaseTags(
      root,
      names.slice(0, MAX_RELEASE_TAG_ENTRIES + 1).map((repo) => ({ repo, skip: true })),
      { execGit: exec },
    );
    assert.equal(over.ok, false);
    assert.equal(over.errors[0].reason, 'too_many_entries');
    assert.equal(exec.calls.length, 0);
  });

  test('malformed requests are invalid_request before any git call', (t) => {
    const { root } = makeProject(t, ['api']);
    const bad = [
      { not: 'an array' },
      'string',
      null,
      [null],
      ['api'],
      [{ tag: 'v1' }],
      [{ repo: 5, tag: 'v1' }],
      [{ repo: 'api', tag: 5 }],
      [{ repo: 'api', tag: 'v1', ref: 5 }],
      [{ repo: 'api', tag: 'v1', message: 5 }],
    ];
    for (const req of bad) {
      const exec = countingGit();
      const res = createReleaseTags(root, req, { execGit: exec });
      assert.equal(res.ok, false, JSON.stringify(req));
      assert.equal(res.errors[0].reason, 'invalid_request', JSON.stringify(req));
      assert.equal(exec.calls.length, 0, JSON.stringify(req));
    }
  });
});

describe('release tags: invariant property (row 21)', () => {
  test('fc: preflight failure implies zero writes', () => {
    const KINDS = ['valid', 'badtag', 'badref', 'skip', 'absent'];
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...KINDS), { minLength: 3, maxLength: 3 }),
        fc.boolean(),
        (kinds, duplicate) => {
          const names = ['p0', 'p1', 'p2'];
          const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-reltags-prop-')));
          try {
            for (const n of names) initRepo(path.join(root, n));
            writeConfig(root, names);
            const entries = [];
            kinds.forEach((kind, i) => {
              const repo = names[i];
              if (kind === 'absent') return;
              if (kind === 'skip') entries.push({ repo, skip: true });
              else if (kind === 'badtag') entries.push({ repo, tag: 'bad tag' });
              else if (kind === 'badref') entries.push({ repo, tag: 'vprop', ref: 'no-such-ref' });
              else entries.push({ repo, tag: 'vprop' });
            });
            if (duplicate && entries.length > 0) entries.push({ ...entries[0] });
            const res = createReleaseTags(root, entries);
            if (res.phase === 'preflight' && res.ok === false) {
              for (const n of names) {
                if (git(path.join(root, n), 'tag', '-l') !== '') return false;
              }
            }
            return true;
          } finally {
            cleanup(root);
          }
        },
      ),
      { seed: 5705, numRuns: 25 },
    );
  });
});

describe('release tags: CLI verb (row 22)', () => {
  test('cli verb contract: JSON shape and exit codes', (t) => {
    const { root, shas } = makeProject(t, ['api', 'web']);
    const goodMap = writeMap(root, [
      { repo: 'api', tag: 'v1.0.0' },
      { repo: 'web', skip: true },
    ]);

    const dry = runCli(root, ['milestone', 'release-tags', '--map', goodMap, '--dry-run']);
    assert.equal(dry.status, 0, dry.stderr);
    const dryOut = JSON.parse(dry.stdout);
    assert.equal(dryOut.ok, true);
    assert.equal(dryOut.phase, 'dry_run');
    assert.equal(dryOut.repos.api.status, 'would_create');
    assert.equal(dryOut.repos.web.status, 'skipped');
    assert.equal(tagExists(path.join(root, 'api'), 'v1.0.0'), false);

    const real = runCli(root, ['milestone', 'release-tags', '--map', goodMap]);
    assert.equal(real.status, 0, real.stderr);
    const out = JSON.parse(real.stdout);
    assert.equal(out.ok, true);
    assert.equal(out.phase, 'apply');
    assert.equal(out.repos.api.status, 'created');
    assert.equal(out.repos.api.commit, shas.api);
    assert.deepEqual(out.created, ['api:v1.0.0']);
    assert.deepEqual(out.errors, []);

    const again = runCli(root, ['milestone', 'release-tags', '--map', goodMap]);
    assert.equal(again.status, 0);
    assert.equal(JSON.parse(again.stdout).repos.api.status, 'already_tagged');

    addCommit(path.join(root, 'api'), 'c.txt');
    const failed = runCli(root, ['milestone', 'release-tags', '--map', goodMap]);
    assert.notEqual(failed.status, 0);
    const failedOut = JSON.parse(failed.stdout);
    assert.equal(failedOut.ok, false);
    assert.equal(failedOut.repos.api.reason, 'tag_conflict');
  });

  test('cli verb rejects unknown flag, missing map, unreadable and oversized map', (t) => {
    const { root } = makeProject(t, ['api']);
    const goodMap = writeMap(root, [{ repo: 'api', tag: 'vx' }]);

    const unknown = runCli(root, ['milestone', 'release-tags', '--map', goodMap, '--bogus']);
    assert.notEqual(unknown.status, 0);
    assert.equal(tagExists(path.join(root, 'api'), 'vx'), false);

    const missing = runCli(root, ['milestone', 'release-tags']);
    assert.notEqual(missing.status, 0);

    const nofile = runCli(root, ['milestone', 'release-tags', '--map', path.join(root, 'nope.json')]);
    assert.notEqual(nofile.status, 0);

    const garbage = path.join(root, 'garbage.json');
    fs.writeFileSync(garbage, '{not json');
    const parse = runCli(root, ['milestone', 'release-tags', '--map', garbage]);
    assert.notEqual(parse.status, 0);

    const huge = path.join(root, 'huge.json');
    fs.writeFileSync(huge, `[${'1,'.repeat(700000)}1]`);
    const big = runCli(root, ['milestone', 'release-tags', '--map', huge]);
    assert.notEqual(big.status, 0);
    assert.equal(tagExists(path.join(root, 'api'), 'vx'), false);

    const sub = runCli(root, ['milestone', 'nonsense']);
    assert.notEqual(sub.status, 0);
  });
});

describe('release tags: review-found edge cases', () => {
  test('a skip entry and a tag entry for the same repo conflict in either order, writing nothing', (t) => {
    const { root } = makeProject(t, ['api']);
    const orders = [
      [{ repo: 'api', tag: 'v1' }, { repo: 'api', skip: true }],
      [{ repo: 'api', skip: true }, { repo: 'api', tag: 'v1' }],
    ];
    for (const entries of orders) {
      const res = createReleaseTags(root, entries);
      assert.equal(res.ok, false);
      assert.ok(res.errors.some((e) => e.reason === 'duplicate_entry'));
      // The repo result must show the error in either order, never `skipped`.
      assert.equal(res.repos.api.status, 'error');
      assert.equal(res.repos.api.reason, 'duplicate_entry');
      assert.equal(tagExists(path.join(root, 'api'), 'v1'), false);
    }
  });

  test('a repo with no commits (unborn HEAD) is rejected as ref_unresolved', (t) => {
    const { root } = makeProject(t, ['api'], { init: false });
    const dir = path.join(root, 'api');
    fs.mkdirSync(dir, { recursive: true });
    git(dir, 'init', '-q');
    const res = preflightReleaseTags(root, [{ repo: 'api', tag: 'v1' }]);
    assert.equal(res.ok, false);
    assert.equal(res.errors[0].reason, 'ref_unresolved');
    assert.equal(git(dir, 'tag', '-l'), '');
  });

  test('an existing lightweight tag at the same commit is already_tagged', (t) => {
    const { root, shas } = makeProject(t, ['api']);
    git(path.join(root, 'api'), 'tag', 'v1');
    const res = createReleaseTags(root, [{ repo: 'api', tag: 'v1' }]);
    assert.equal(res.ok, true);
    assert.equal(res.repos.api.status, 'already_tagged');
    assert.equal(res.repos.api.commit, shas.api);
    assert.deepEqual(res.created, []);
  });

  test('a sub-repo that is a symlink to a repo outside the project root is rejected', (t) => {
    const { root } = makeProject(t, []);
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-reltags-out-')));
    t.after(() => cleanup(outside));
    initRepo(outside);
    try {
      fs.symlinkSync(outside, path.join(root, 'ext'), 'dir');
    } catch (e) {
      t.skip(`symlinks unavailable on this platform: ${e.code}`);
      return;
    }
    writeConfig(root, ['ext']);
    const res = createReleaseTags(root, [{ repo: 'ext', tag: 'v1' }]);
    assert.equal(res.ok, false);
    assert.equal(res.errors[0].reason, 'repo_path_invalid');
    assert.equal(git(outside, 'tag', '-l'), '');
  });

  test('a relative --map resolves against the shell working directory', (t) => {
    const { root } = makeProject(t, ['api']);
    const deep = path.join(root, 'deep');
    fs.mkdirSync(deep);
    writeMap(root, [{ repo: 'api', tag: 'vrel' }]);
    const res = runCli(deep, ['milestone', 'release-tags', '--map', '../map.json']);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(JSON.parse(res.stdout).ok, true);
    assert.equal(tagExists(path.join(root, 'api'), 'vrel'), true);
  });

  test('a --map that is a directory is refused', (t) => {
    const { root } = makeProject(t, ['api']);
    const res = runCli(root, ['milestone', 'release-tags', '--map', root]);
    assert.notEqual(res.status, 0);
    assert.equal(git(path.join(root, 'api'), 'tag', '-l'), '');
  });
});

describe('release tags: reason-code parity (row 24)', () => {
  test('exported reason codes equal the codes CONTEXT.md lists', () => {
    assert.ok(Object.isFrozen(RELEASE_TAG_REASONS));
    const context = fs.readFileSync(CONTEXT_PATH, 'utf-8');
    const section = context.split(/^### /m).find((s) => s.startsWith('Release Tags Module'));
    assert.ok(section, 'CONTEXT.md must carry a "Release Tags Module" glossary entry');
    const m = /Reason codes \(closed set\): ([^;]{1,500});/.exec(section);
    assert.ok(m, 'glossary entry must list "Reason codes (closed set): ...;"');
    const documented = m[1].split(',').map((s) => s.trim().replace(/`/g, '')).filter(Boolean);
    assert.deepEqual([...documented].sort(), [...RELEASE_TAG_REASONS].sort());
  });
});
