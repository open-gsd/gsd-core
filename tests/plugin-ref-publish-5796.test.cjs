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
  assert.equal(r.exitCode, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
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
    const res = publisher.buildPluginRefCommit({ root, source: 'HEAD' });
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
    const res = publisher.buildPluginRefCommit({ root, source: 'HEAD' });
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
    const res = publisher.buildPluginRefCommit({ root, source: 'HEAD' });
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

  test('refuses when HEAD is not the source', () => {
    const root = makeFixtureRepo();
    const shaA = git(root, ['rev-parse', 'HEAD']);
    write(root, 'README.md', 'second\n');
    git(root, ['commit', '-q', '-am', 'second']);
    const shaB = git(root, ['rev-parse', 'HEAD']);
    const bare = makeBareRemote();
    const refused = publisher.publishPluginRef({ root, remote: bare, branch: 'plugin', source: shaA });
    assert.equal(refused.ok, false);
    assert.match(refused.error, /is not the source/);
    assert.equal(git(bare, ['branch', '--list']), '');
    const ok = publisher.publishPluginRef({ root, remote: bare, branch: 'plugin', source: shaB });
    assert.equal(ok.ok, true, JSON.stringify(ok));
    assert.equal(
      git(root, ['rev-list', '--parents', '-n', '1', ok.commit]),
      `${ok.commit} ${shaB}`,
    );
  });

  test('accepts a lightweight or annotated release tag on HEAD', () => {
    const root = makeFixtureRepo();
    const head = git(root, ['rev-parse', 'HEAD']);
    const bare = makeBareRemote();
    git(root, ['tag', 'v1.0.0']);
    const light = publisher.publishPluginRef({ root, remote: bare, branch: 'plugin', source: 'refs/tags/v1.0.0' });
    assert.equal(light.ok, true, JSON.stringify(light));
    assert.equal(git(root, ['rev-list', '--parents', '-n', '1', light.commit]), `${light.commit} ${head}`);
    git(root, ['tag', '-a', 'v1.0.1', '-m', 'rel']);
    const annotated = publisher.publishPluginRef({ root, remote: bare, branch: 'plugin', source: 'refs/tags/v1.0.1' });
    assert.equal(annotated.ok, true, JSON.stringify(annotated));
    assert.equal(git(root, ['rev-list', '--parents', '-n', '1', annotated.commit]), `${annotated.commit} ${head}`);
  });

  test('refuses a release tag that is not HEAD', () => {
    const root = makeFixtureRepo();
    git(root, ['tag', 'v0.9.0']);
    write(root, 'README.md', 'second\n');
    git(root, ['commit', '-q', '-am', 'second']);
    const bare = makeBareRemote();
    const res = publisher.publishPluginRef({ root, remote: bare, branch: 'plugin', source: 'refs/tags/v0.9.0' });
    assert.equal(res.ok, false);
    assert.match(res.error, /is not the source/);
    assert.equal(git(bare, ['branch', '--list']), '');
  });

  test('pushAuthEnv rejects bad tokens', () => {
    for (const ok of [undefined, '', null]) assert.deepEqual(publisher.pushAuthEnv(ok, {}), {});
    for (const bad of ['a\nb', 'a\rb', 'a\0b', 5]) {
      assert.ok(publisher.pushAuthEnv(bad, {}).error, JSON.stringify(bad));
    }
  });

  test('pushAuthEnv appends to an existing GIT_CONFIG_COUNT', () => {
    const key = 'http.https://github.com/.extraheader';
    const header = `AUTHORIZATION: basic ${Buffer.from('x-access-token:tok').toString('base64')}`;
    const appended = publisher.pushAuthEnv('tok', {
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'safe.directory', GIT_CONFIG_VALUE_0: '*',
    });
    assert.deepEqual(appended, {
      GIT_CONFIG_COUNT: '3',
      GIT_CONFIG_KEY_1: key, GIT_CONFIG_VALUE_1: '',
      GIT_CONFIG_KEY_2: key, GIT_CONFIG_VALUE_2: header,
    });
    assert.ok(!('GIT_CONFIG_KEY_0' in appended) && !('GIT_CONFIG_VALUE_0' in appended));
    assert.deepEqual(publisher.pushAuthEnv('tok', {}), {
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: key, GIT_CONFIG_VALUE_0: '',
      GIT_CONFIG_KEY_1: key, GIT_CONFIG_VALUE_1: header,
    });
    assert.equal(publisher.pushAuthEnv('tok', { GIT_CONFIG_COUNT: 'x' }).GIT_CONFIG_COUNT, '2');
  });

  test('push auth env replaces a header persisted through includeIf', () => {
    const root = makeFixtureRepo();
    const key = 'http.https://github.com/.extraheader';
    const creds = path.join(tmp('plugin-ref-creds-'), 'creds.config');
    fs.writeFileSync(creds, '[http "https://github.com/"]\n\textraheader = AUTHORIZATION: basic OLD\n');
    const gitDir = git(root, ['rev-parse', '--absolute-git-dir']);
    // No trailing slash: git matches a gitdir: pattern against the .git dir path.
    git(root, ['config', '--local', `includeIf.gitdir:${gitDir}.path`, creds]);
    assert.deepEqual(git(root, ['config', '--get-all', key]).split('\n'), ['AUTHORIZATION: basic OLD']);
    const header = `AUTHORIZATION: basic ${Buffer.from('x-access-token:tok').toString('base64')}`;
    const r = runGit(['config', '--get-all', key], {
      cwd: root, env: { ...process.env, ...publisher.pushAuthEnv('tok', process.env) },
    });
    assert.equal(r.exitCode, 0, r.stderr);
    // git config --get-all lists every value including the empty reset marker;
    // git's http code treats an empty extraheader as "forget the earlier ones".
    // So the headers actually sent are the lines after the last empty line. This
    // fails if the empty reset entry is removed: OLD would then be sent too.
    const lines = String(r.stdout).replace(/\n$/, '').split('\n');
    const afterReset = lines.slice(lines.lastIndexOf('') + 1);
    assert.deepEqual(afterReset, [header]);
    assert.ok(lines.includes(''), 'the reset entry is present');
  });

  test('scrubToken removes every printable form', () => {
    const token = 'sekret-5796';
    const b64 = Buffer.from(`x-access-token:${token}`).toString('base64');
    const header = `AUTHORIZATION: basic ${b64}`;
    const out = publisher.scrubToken(`raw ${token} b64 ${b64} header ${header}`, token);
    for (const form of [token, b64, header]) assert.ok(!out.includes(form), `${form} must be scrubbed`);
    assert.ok(out.includes('***'));
    assert.equal(publisher.scrubToken('plain text', ''), 'plain text');
  });

  test('publishes to a local remote with a push token set', () => {
    const root = makeFixtureRepo();
    const bare = makeBareRemote();
    const ok = publisher.publishPluginRef({
      root, remote: bare, branch: 'plugin', source: 'HEAD', pushToken: 'sekret-5796',
    });
    assert.equal(ok.ok, true, JSON.stringify(ok));
    assert.equal(git(bare, ['rev-parse', 'refs/heads/plugin']), ok.commit);
  });

  test('an invalid push token is a usage error that does not echo it', () => {
    const root = makeFixtureRepo();
    const bare = makeBareRemote();
    const bad = publisher.publishPluginRef({
      root, remote: bare, branch: 'plugin', source: 'HEAD', pushToken: 'a\nb',
    });
    assert.equal(bad.ok, false);
    assert.equal(bad.code, 'usage');
    assert.equal(bad.error, 'invalid push token');
    assert.equal(git(bare, ['branch', '--list']), '');
  });

  test('rejects a missing or option-like source', () => {
    const root = makeFixtureRepo();
    const bare = makeBareRemote();
    for (const source of [undefined, '', '-x']) {
      const res = publisher.publishPluginRef({ root, remote: bare, branch: 'plugin', source });
      assert.equal(res.ok, false, JSON.stringify(source));
      assert.equal(res.code, 'usage', JSON.stringify(source));
    }
    assert.equal(git(bare, ['branch', '--list']), '');
  });

  test('refuses to publish an unbuilt tree', () => {
    const root = makeFixtureRepo();
    cleanup(path.join(root, 'gsd-core/bin/lib/cli-exit.cjs'));
    const bare = makeBareRemote();
    const res = publisher.publishPluginRef({ root, remote: bare, branch: 'plugin', source: 'HEAD' });
    assert.equal(res.ok, false);
    assert.match(res.error, /cli-exit\.cjs/);
    assert.equal(git(bare, ['branch', '--list']), '');
  });

  test('force-updates a moving branch', () => {
    const root = makeFixtureRepo();
    const bare = makeBareRemote();
    const first = publisher.publishPluginRef({ root, remote: bare, branch: 'plugin', source: 'HEAD' });
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(git(bare, ['rev-parse', 'refs/heads/plugin']), first.commit);
    write(root, 'README.md', 'changed\n');
    git(root, ['commit', '-q', '-am', 'second']);
    const second = publisher.publishPluginRef({ root, remote: bare, branch: 'plugin', source: 'HEAD' });
    assert.equal(second.ok, true, JSON.stringify(second));
    assert.notEqual(second.commit, first.commit);
    assert.equal(git(bare, ['rev-parse', 'refs/heads/plugin']), second.commit);
  });

  test('returns ok:false when push fails', () => {
    const root = makeFixtureRepo();
    // git echoes the missing remote path in its error, and the path carries the
    // token text, so the scrub in publishPluginRef is what keeps it out.
    const res = publisher.publishPluginRef({
      root,
      remote: path.join(os.tmpdir(), 'no-such-remote-sekret-5796'),
      branch: 'plugin',
      source: 'HEAD',
      pushToken: 'sekret-5796',
    });
    assert.equal(res.ok, false);
    assert.match(res.error, /git push/);
    assert.ok(!res.error.includes('sekret-5796'), 'error must not contain the token');
    assert.ok(res.error.includes('***'), 'the token must be replaced, not dropped');
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
      path.join(ROOT, 'scripts', 'publish-plugin-ref.cjs'), '--branch', '-bad', '--remote', 'x', '--source', 'x',
    ], { cwd: ROOT });
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /branch/i);
  });

  test('CLI requires --source', () => {
    const r = runNode([
      path.join(ROOT, 'scripts', 'publish-plugin-ref.cjs'), '--remote', 'x', '--branch', 'plugin',
    ], { cwd: ROOT });
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /source/);
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
    const matching = steps.filter((s) => s.id === 'plugin_ref');
    assert.equal(matching.length, 1, 'finalize has exactly one plugin_ref step');
    assert.equal(matching[0].name, 'Publish plugin ref (prebuilt bin/lib)');
    assert.ok(
      typeof matching[0].run === 'string' && matching[0].run.includes('scripts/publish-plugin-ref.cjs'),
      'plugin_ref step runs the publisher',
    );
    const FAIL_STEP = 'Fail if the plugin ref was not published';
    const mentioning = steps.filter((s) => publishes(s)).map((s) => s.name);
    assert.deepEqual(mentioning, [matching[0].name, FAIL_STEP], 'only the publish and fail steps mention the publisher');
    assert.ok(String(matching[0].if).includes('!inputs.dry_run'), 'publish step is skipped on dry runs');
    const idx = steps.indexOf(matching[0]);
    const syncIdx = steps.findIndex((s) => typeof s.run === 'string' && s.run.includes('scripts/sync-next-version.cjs'));
    const verifyIdx = steps.findIndex((s) => s.name === 'Verify publish');
    assert.ok(syncIdx >= 0 && verifyIdx >= 0, 'sync and verify steps present');
    assert.ok(idx < syncIdx, 'publish step runs before the next sync checks out origin/next');
    assert.ok(idx > verifyIdx, 'publish step runs after Verify publish');
    assert.ok(matching[0].run.includes('--source "refs/tags/v${VERSION}"'), 'publish step names the release tag');
    assert.equal(matching[0].env && matching[0].env.VERSION, '${{ inputs.version }}');
    assert.equal(matching[0].env.PUSH_TOKEN, '${{ secrets.GSD_BOT_PR_TOKEN }}');
    assert.ok(matching[0].run.includes('GSD_PLUGIN_REF_PUSH_TOKEN'), 'publish step exports the push token');
    assert.ok(
      matching[0].run.includes(`::add-mask::$(printf 'x-access-token:%s' "$PUSH_TOKEN" | base64 | tr -d '\\n')`),
      'publish step masks the derived header',
    );
    assert.equal(matching[0].id, 'plugin_ref');
    assert.equal(matching[0]['continue-on-error'], true);
    const last = steps[steps.length - 1];
    assert.equal(last.name, FAIL_STEP);
    assert.ok(String(last.if).includes("steps.plugin_ref.outcome == 'failure'"), 'last step reports a failed publish');
    assert.ok(typeof last.run === 'string' && last.run.includes('exit 1'), 'last step fails the job');
    assert.ok(!String(steps[syncIdx].if).includes('steps.plugin_ref'), 'sync step does not depend on the publish step');
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
    // A fresh repository holding one commit of ROOT's tracked tree. Cloning ROOT would copy its whole
    // history (gigabytes), and how long that takes depends on the runner, not on the publisher (#6517).
    const tracked = git(ROOT, ['-c', 'safe.directory=*', 'ls-files', '-z']).split('\0').filter(Boolean);
    fs.mkdirSync(repo, { recursive: true });
    for (const rel of tracked) {
      const to = path.join(repo, rel);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(path.join(ROOT, rel), to);
    }
    git(repo, ['init', '-q', '-b', 'main']);
    // -f: only tracked files were copied, so forcing cannot add an untracked ignored file, and a
    // tracked file that .gitignore also names is kept rather than silently dropped.
    git(repo, ['add', '-f', '-A']);
    git(repo, ['commit', '-q', '-m', 'tracked tree of the checkout under test']);
    assert.deepEqual(
      git(repo, ['ls-files', '-z']).split('\0').filter(Boolean).sort(), tracked.slice().sort(),
      'the fixture repository tracks the same paths as the checkout',
    );
    fs.cpSync(
      path.join(ROOT, 'gsd-core', 'bin', 'lib'), path.join(repo, 'gsd-core', 'bin', 'lib'),
      { recursive: true },
    );
    const bare = makeBareRemote();
    const res = publisher.publishPluginRef({
      root: repo, remote: bare, branch: 'plugin', source: git(repo, ['rev-parse', 'HEAD']),
    });
    assert.equal(res.ok, true, JSON.stringify(res));
    const clone = tmp('plugin-cache-');
    git(clone, ['clone', '-q', '--branch', 'plugin', bare, path.join(clone, 'cache')]);
    const cache = path.join(clone, 'cache');
    assert.ok(!fs.existsSync(path.join(cache, 'node_modules')));
    const r = runNode([
      path.join(cache, 'gsd-core', 'bin', 'gsd-tools.cjs'), 'generate-slug', 'hello world',
    ], { cwd: cache });
    assert.equal(r.exitCode, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /runtime library/);
    assert.equal(JSON.parse(r.stdout).slug, 'hello-world');
  });
});
