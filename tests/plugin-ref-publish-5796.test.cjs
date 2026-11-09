'use strict';

// #5796: `claude plugin update` leaves gsd-core/bin/lib/*.cjs unbuilt because the
// plugin channel materializes the tracked git tree and the compiled lib is a
// gitignored build artifact. The release workflow therefore publishes a moving
// `plugin` branch (HEAD tree + compiled lib) that .claude-plugin/marketplace.json
// points at. These tests drive the publisher against real git repositories.

const { describe, test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const fc = require('fast-check');

const ROOT = path.resolve(__dirname, '..');
const publisher = require(path.join(ROOT, 'scripts', 'publish-plugin-ref.cjs'));

const cleanups = [];
afterEach(() => {
  while (cleanups.length) fs.rmSync(cleanups.pop(), { recursive: true, force: true });
});

function tmp(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(d);
  return d;
}

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com',
    },
  }).trim();
}

function write(root, rel, body) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
}

// A repo shaped like gsd-core: tracked source + tracked lib file, with the
// compiled lib (and unrelated junk) gitignored.
function makeFixtureRepo() {
  const root = tmp('plugin-ref-fixture-');
  git(root, ['init', '-q', '-b', 'main']);
  write(root, '.gitignore', [
    'node_modules/', '.gsd/', 'tsconfig.build.tsbuildinfo',
    '/gsd-core/bin/lib/*', '!/gsd-core/bin/lib/tracked.cjs', '!/gsd-core/bin/lib/vendor/',
    'extra/',
  ].join('\n') + '\n');
  write(root, '.claude-plugin/plugin.json', '{"name":"gsd-core"}\n');
  write(root, 'gsd-core/bin/lib/tracked.cjs', 'module.exports = 1;\n');
  write(root, 'gsd-core/bin/lib/vendor/v.cjs', 'module.exports = 2;\n');
  write(root, 'README.md', 'x\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'init']);
  // build outputs + junk, all ignored
  write(root, 'gsd-core/bin/lib/cli-exit.cjs', 'module.exports = 3;\n');
  write(root, 'gsd-core/bin/lib/health-diagnostic-rules/r.cjs', 'module.exports = 4;\n');
  write(root, 'gsd-core/bin/lib/not-js.d.ts', 'declare const x: 1;\n');
  write(root, 'node_modules/dep/index.js', 'x\n');
  write(root, '.gsd/bug/queue.json', '{}\n');
  write(root, 'tsconfig.build.tsbuildinfo', '{}\n');
  write(root, 'extra/e.cjs', 'x\n');
  return root;
}

function makeBareRemote() {
  const bare = tmp('plugin-ref-remote-');
  git(bare, ['init', '-q', '--bare', '-b', 'main']);
  return bare;
}

function lsTree(repo, ref) {
  return git(repo, ['ls-tree', '-r', '--name-only', ref]).split('\n').filter(Boolean).sort();
}

describe('#5796 plugin ref publisher', () => {
  test('ref tree contains tracked files and compiled lib', () => {
    const root = makeFixtureRepo();
    const res = publisher.buildPluginRefCommit({ root });
    assert.equal(res.ok, true, JSON.stringify(res));
    const files = lsTree(root, res.commit);
    for (const f of [
      '.claude-plugin/plugin.json', 'README.md', 'gsd-core/bin/lib/tracked.cjs',
      'gsd-core/bin/lib/vendor/v.cjs', 'gsd-core/bin/lib/cli-exit.cjs',
      'gsd-core/bin/lib/health-diagnostic-rules/r.cjs',
    ]) assert.ok(files.includes(f), `${f} missing from ${files.join(',')}`);
  });

  test('ref tree excludes ignored non-lib files', () => {
    const root = makeFixtureRepo();
    const res = publisher.buildPluginRefCommit({ root });
    const files = lsTree(root, res.commit);
    for (const f of [
      'node_modules/dep/index.js', '.gsd/bug/queue.json', 'tsconfig.build.tsbuildinfo',
      'gsd-core/bin/lib/not-js.d.ts', 'extra/e.cjs',
    ]) assert.ok(!files.includes(f), `${f} must not be in the plugin ref`);
  });

  test('ref commit is an orphan and leaves the checkout untouched', () => {
    const root = makeFixtureRepo();
    const headBefore = git(root, ['rev-parse', 'HEAD']);
    const statusBefore = git(root, ['status', '--porcelain', '--ignored']);
    const res = publisher.buildPluginRefCommit({ root });
    assert.equal(git(root, ['rev-list', '--parents', '-n', '1', res.commit]), res.commit);
    assert.equal(git(root, ['rev-parse', 'HEAD']), headBefore);
    assert.equal(git(root, ['status', '--porcelain', '--ignored']), statusBefore);
    assert.equal(git(root, ['diff', '--cached', '--name-only']), '');
  });

  test('refuses to publish an unbuilt tree', () => {
    const root = makeFixtureRepo();
    fs.rmSync(path.join(root, 'gsd-core/bin/lib/cli-exit.cjs'));
    const bare = makeBareRemote();
    const res = publisher.publishPluginRef({ root, remote: bare, branch: 'plugin' });
    assert.equal(res.ok, false);
    assert.match(res.error, /cli-exit\.cjs/);
    assert.equal(git(bare, ['branch', '--list']), '');
  });

  test('force-updates a moving branch', () => {
    const root = makeFixtureRepo();
    const bare = makeBareRemote();
    const first = publisher.publishPluginRef({ root, remote: bare, branch: 'plugin' });
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(git(bare, ['rev-parse', 'refs/heads/plugin']), first.commit);
    write(root, 'README.md', 'changed\n');
    git(root, ['commit', '-q', '-am', 'second']);
    const second = publisher.publishPluginRef({ root, remote: bare, branch: 'plugin' });
    assert.equal(second.ok, true, JSON.stringify(second));
    assert.notEqual(second.commit, first.commit);
    assert.equal(git(bare, ['rev-parse', 'refs/heads/plugin']), second.commit);
  });

  test('returns ok:false when push fails', () => {
    const root = makeFixtureRepo();
    const res = publisher.publishPluginRef({
      root, remote: path.join(os.tmpdir(), 'plugin-ref-no-such-remote-5796'), branch: 'plugin',
    });
    assert.equal(res.ok, false);
    assert.ok(res.error);
  });

  test('branch name length boundary', () => {
    for (const [len, ok] of [[99, true], [100, true], [101, false]]) {
      assert.equal(publisher.isValidBranchName('a'.repeat(len)), ok, `length ${len}`);
    }
  });

  test('rejects unsafe branch names', () => {
    for (const bad of ['', '-x', '.x', 'a b', 'a;b', '../x', 'a/b', 'a\nb', null, undefined, 5]) {
      assert.equal(publisher.isValidBranchName(bad), false, JSON.stringify(bad));
    }
    assert.equal(publisher.isValidBranchName('plugin'), true);
  });

  test('branch validator property', () => {
    const safe = fc.stringMatching(/^[A-Za-z0-9_][A-Za-z0-9._-]{0,98}$/);
    fc.assert(fc.property(safe, (s) => publisher.isValidBranchName(s) === true));
    const unsafe = fc.tuple(safe, fc.constantFrom(' ', '/', ';', '$', '`', '\n', ':', '*', '\\'), safe)
      .map(([a, c, b]) => a + c + b);
    fc.assert(fc.property(unsafe, (s) => publisher.isValidBranchName(s) === false));
  });

  test('CLI rejects an invalid branch with a non-zero exit', () => {
    const r = spawnSync(process.execPath, [
      path.join(ROOT, 'scripts', 'publish-plugin-ref.cjs'), '--branch', '-bad', '--remote', 'x',
    ], { encoding: 'utf8', timeout: 30000 });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /branch/i);
  });

  test('marketplace source parity', () => {
    const mp = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude-plugin', 'marketplace.json'), 'utf8'));
    assert.deepEqual(mp.plugins[0].source, {
      source: 'github', repo: 'open-gsd/gsd-core', ref: publisher.PLUGIN_REF_BRANCH,
    });
  });

  test('release workflow publishes only from finalize', () => {
    // allow-test-rule: the workflow YAML is the runtime contract under test
    const wf = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8');
    const jobs = wf.split(/^  (?=[a-z][a-z0-9-]*:\s*$)/m);
    const byName = Object.fromEntries(jobs.map((j) => [j.split(':')[0], j]));
    assert.ok(byName.finalize, 'finalize job present');
    assert.match(byName.finalize, /scripts\/publish-plugin-ref\.cjs/);
    assert.match(byName.finalize, /!inputs\.dry_run/);
    for (const name of Object.keys(byName)) {
      if (name !== 'finalize') {
        assert.ok(!byName[name].includes('publish-plugin-ref'), `${name} must not publish the plugin ref`);
      }
    }
  });

  test('published plugin ref runs gsd-tools with no node_modules', (t) => {
    if (!fs.existsSync(path.join(ROOT, 'gsd-core', 'bin', 'lib', 'cli-exit.cjs'))) {
      t.skip('repo checkout has no compiled lib');
      return;
    }
    const bare = makeBareRemote();
    const res = publisher.publishPluginRef({ root: ROOT, remote: bare, branch: 'plugin' });
    assert.equal(res.ok, true, JSON.stringify(res));
    const clone = tmp('plugin-cache-');
    git(clone, ['clone', '-q', '--branch', 'plugin', bare, path.join(clone, 'cache')]);
    const cache = path.join(clone, 'cache');
    assert.ok(!fs.existsSync(path.join(cache, 'node_modules')));
    const r = spawnSync(process.execPath, [
      path.join(cache, 'gsd-core', 'bin', 'gsd-tools.cjs'), 'generate-slug', 'hello world',
    ], { cwd: cache, encoding: 'utf8', timeout: 60000 });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /runtime library/);
    assert.equal(JSON.parse(r.stdout).slug, 'hello-world');
  });
});
