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
const yaml = require('js-yaml');
const fc = require('./helpers/fast-check-setup.cjs');
const { runGit, runNode } = require('./helpers/process-seam.cjs');
const { createTempDir, cleanup } = require('./helpers.cjs');

const ROOT = path.resolve(__dirname, '..');
const publisher = require(path.join(ROOT, 'scripts', 'publish-plugin-ref.cjs'));

const cleanups = [];
afterEach(() => {
  while (cleanups.length) cleanup(cleanups.pop());
});

function tmp(prefix) {
  const d = createTempDir(prefix);
  cleanups.push(d);
  return d;
}

function git(cwd, args) {
  const r = runGit(args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com',
    },
  });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  return String(r.stdout).trim();
}

function write(root, rel, body) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
}

// A repo shaped like gsd-core: tracked source + tracked lib file + a tracked
// workflow, with some compiled lib outputs (and unrelated junk) gitignored and
// one compiled output that no .gitignore line names.
function makeFixtureRepo() {
  const root = tmp('plugin-ref-fixture-');
  git(root, ['init', '-q', '-b', 'main']);
  write(root, '.gitignore', [
    'node_modules/', '.gsd/', 'tsconfig.build.tsbuildinfo',
    '/gsd-core/bin/lib/cli-exit.cjs',
    '/gsd-core/bin/lib/health-diagnostic-rules/',
    '/gsd-core/bin/lib/not-js.d.ts',
    'extra/',
  ].join('\n') + '\n');
  write(root, '.claude-plugin/plugin.json', '{"name":"gsd-core"}\n');
  write(root, '.github/workflows/ci.yml', 'name: ci\n');
  write(root, 'gsd-core/bin/lib/tracked.cjs', 'module.exports = 1;\n');
  write(root, 'gsd-core/bin/lib/vendor/v.cjs', 'module.exports = 2;\n');
  write(root, 'README.md', 'x\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'init']);
  // build outputs + junk
  write(root, 'gsd-core/bin/lib/unlisted.cjs', 'module.exports = 5;\n');
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
      'gsd-core/bin/lib/unlisted.cjs',
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

  test('ref commit is parented on HEAD and leaves the checkout untouched', () => {
    const root = makeFixtureRepo();
    const headBefore = git(root, ['rev-parse', 'HEAD']);
    const statusBefore = git(root, ['status', '--porcelain', '--ignored']);
    const res = publisher.buildPluginRefCommit({ root });
    assert.equal(
      git(root, ['rev-list', '--parents', '-n', '1', res.commit]),
      `${res.commit} ${headBefore}`,
    );
    const changed = git(root, ['diff', '--name-only', headBefore, res.commit]).split('\n').filter(Boolean);
    assert.ok(changed.length > 0, 'the ref commit must add the compiled lib');
    for (const line of changed) {
      assert.ok(line.startsWith('gsd-core/bin/lib/'), `${line} must not differ from HEAD`);
      assert.ok(!line.startsWith('.github/'), `${line} must not differ from HEAD`);
    }
    assert.equal(git(root, ['rev-parse', 'HEAD']), headBefore);
    assert.equal(git(root, ['status', '--porcelain', '--ignored']), statusBefore);
    assert.equal(git(root, ['diff', '--cached', '--name-only']), '');
  });

  test('refuses to publish an unbuilt tree', () => {
    const root = makeFixtureRepo();
    cleanup(path.join(root, 'gsd-core/bin/lib/cli-exit.cjs'));
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
    assert.match(res.error, /git push/);
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

  test('CLI rejects an invalid branch with a usage exit', () => {
    const r = runNode([
      path.join(ROOT, 'scripts', 'publish-plugin-ref.cjs'), '--branch', '-bad', '--remote', 'x',
    ], { cwd: ROOT });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /branch/i);
  });

  test('marketplace source parity', () => {
    const mp = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude-plugin', 'marketplace.json'), 'utf8'));
    assert.deepEqual(mp.plugins[0].source, {
      source: 'github', repo: 'open-gsd/gsd-core', ref: publisher.PLUGIN_REF_BRANCH,
    });
  });

  test('release workflow publishes only from finalize', () => {
    const wf = yaml.load(fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8'));
    const publishes = (step) => typeof step.run === 'string' && step.run.includes('publish-plugin-ref');
    assert.ok(wf.jobs.finalize, 'finalize job present');
    const steps = wf.jobs.finalize.steps;
    const matching = steps.filter((s) => typeof s.run === 'string' && s.run.includes('scripts/publish-plugin-ref.cjs'));
    assert.equal(matching.length, 1, 'finalize has exactly one publish step');
    assert.ok(String(matching[0].if).includes('!inputs.dry_run'), 'publish step is skipped on dry runs');
    const idx = steps.indexOf(matching[0]);
    assert.equal(steps[idx + 1] && steps[idx + 1].name, 'Summary', 'publish step is immediately before Summary');
    for (const [name, job] of Object.entries(wf.jobs)) {
      if (name === 'finalize') continue;
      assert.ok(!(job.steps || []).some(publishes), `${name} must not publish the plugin ref`);
    }
  });

  test('published plugin ref runs gsd-tools with no node_modules', () => {
    assert.ok(
      fs.existsSync(path.join(ROOT, 'gsd-core', 'bin', 'lib', 'cli-exit.cjs')),
      'compiled lib must exist (npm run build:lib)',
    );
    const src = tmp('plugin-ref-src-');
    const repo = path.join(src, 'repo');
    git(src, ['clone', '-q', '--no-local', ROOT, repo]);
    fs.cpSync(
      path.join(ROOT, 'gsd-core', 'bin', 'lib'), path.join(repo, 'gsd-core', 'bin', 'lib'),
      { recursive: true },
    );
    const bare = makeBareRemote();
    const res = publisher.publishPluginRef({ root: repo, remote: bare, branch: 'plugin' });
    assert.equal(res.ok, true, JSON.stringify(res));
    const clone = tmp('plugin-cache-');
    git(clone, ['clone', '-q', '--branch', 'plugin', bare, path.join(clone, 'cache')]);
    const cache = path.join(clone, 'cache');
    assert.ok(!fs.existsSync(path.join(cache, 'node_modules')));
    const r = runNode([
      path.join(cache, 'gsd-core', 'bin', 'gsd-tools.cjs'), 'generate-slug', 'hello world',
    ], { cwd: cache });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /runtime library/);
    assert.equal(JSON.parse(r.stdout).slug, 'hello-world');
  });
});
