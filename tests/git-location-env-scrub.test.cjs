'use strict';
// #5548: git repo-location env vars must never redirect a git call away from its cwd.
const { describe, test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runGit, runHook } = require('./helpers/process-seam.cjs');
const { gitOrThrow: rawGitOrThrow } = require('./helpers/git-fixture.cjs');
const { createTempDir, cleanup, runGsdTools, delay } = require('./helpers.cjs');
const { STAGED_HOOK_SCRIPT_TIMEOUT_MS, HOOK_FANOUT_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const fc = require('./helpers/fast-check-setup.cjs');

const ROOT = path.join(__dirname, '..');
const lib = (name) => require(path.join(ROOT, 'gsd-core', 'bin', 'lib', `${name}.cjs`));
const proj = lib('shell-command-projection');
// Fixture git must obey cwd even when the suite itself runs inside a git hook (inherited GIT_DIR).
const gitOrThrow = (args, o = {}) => rawGitOrThrow(args, { ...o, env: proj.scrubGitLocationEnv(process.env) });
const probe = require(path.join(ROOT, 'hooks', 'lib', 'git-probe.js'));
const hookPath = (name) => path.join(ROOT, 'hooks', name);

describe('git location env scrub (#5548)', () => {
  test('scrubGitLocationEnv drops every location var, any casing, keeps config injection', () => {
    const env = { PATH: '/bin', GIT_AUTHOR_NAME: 'a', GIT_CONFIG_COUNT: '1', Git_Dir: 'x' };
    for (const k of proj.GIT_LOCATION_ENV_VARS) env[k] = 'x';
    assert.deepEqual(proj.scrubGitLocationEnv(env), { PATH: '/bin', GIT_AUTHOR_NAME: 'a', GIT_CONFIG_COUNT: '1' });
  });

  test('location list is a subset of `git rev-parse --local-env-vars`, and omits only config-injection vars', () => {
    const r = runGit(['rev-parse', '--local-env-vars']);
    const local = r.stdout.split('\n').filter(Boolean);
    const configInjection = /^GIT_CONFIG(_PARAMETERS|_COUNT)?$/;
    for (const v of proj.GIT_LOCATION_ENV_VARS) assert.ok(local.includes(v), `${v} is not a git local env var`);
    const missing = local.filter((v) => !configInjection.test(v) && !proj.GIT_LOCATION_ENV_VARS.includes(v));
    assert.deepEqual(missing, [], 'new git local env vars: add them to GIT_LOCATION_ENV_VARS and hooks/lib/git-probe.js');
  });

  test('hooks/lib/git-probe.js list matches the src list (hooks ship standalone)', () => {
    assert.deepEqual([...probe.GIT_LOCATION_ENV_VARS].sort(), [...proj.GIT_LOCATION_ENV_VARS].sort());
  });

  // Property: for any env map, no location key survives in any casing and every
  // other key/value is preserved. Run against both copies (src and hooks).
  describe('scrub property (both copies)', () => {
    const isLocation = (k) => proj.GIT_LOCATION_ENV_VARS.includes(k.toUpperCase());
    const recased = fc.tuple(fc.constantFrom(...proj.GIT_LOCATION_ENV_VARS), fc.integer({ min: 0, max: 2 ** 30 }))
      .map(([k, mask]) => [...k].map((c, i) => ((mask >> (i % 30)) & 1 ? c.toLowerCase() : c)).join(''));
    const key = fc.oneof(recased, fc.constantFrom('PATH', 'GIT_AUTHOR_NAME', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS'), fc.stringMatching(/^[A-Za-z_][A-Za-z0-9_]{0,10}$/));
    const envMap = fc.dictionary(key, fc.string({ maxLength: 12 }));

    for (const [label, scrub] of [['src scrubGitLocationEnv', proj.scrubGitLocationEnv], ['hooks gitEnv', probe.gitEnv]]) {
      test(`${label}: drops all location keys, preserves all others`, () => {
        fc.assert(fc.property(envMap, (env) => {
          const out = scrub(env);
          assert.ok(Object.keys(out).every((k) => !isLocation(k)));
          const kept = Object.entries(env).filter(([k]) => !isLocation(k));
          assert.deepEqual(Object.entries(out), kept);
        }));
      });
    }
  });

  // Every runtime git spawn: cwd (repo A, branch alpha) must win over an
  // inherited location var pointing at repo B (branch beta, dirty). Each test
  // fails if its site stops passing a scrubbed env.
  describe('every runtime git spawn ignores inherited location vars', () => {
    const cleanups = [];
    afterEach(() => { while (cleanups.length) cleanups.pop()(); });

    function repo(branch, { extra } = {}) {
      const dir = createTempDir('gsd-5548-');
      cleanups.push(() => cleanup(dir));
      gitOrThrow(['init', '-b', branch], { cwd: dir });
      gitOrThrow(['config', 'user.email', 't@t'], { cwd: dir });
      gitOrThrow(['config', 'user.name', 't'], { cwd: dir });
      fs.writeFileSync(path.join(dir, `${branch}.txt`), '1\n');
      if (extra) extra(dir);
      gitOrThrow(['add', '-A'], { cwd: dir });
      gitOrThrow(['commit', '-m', 'init'], { cwd: dir });
      return dir;
    }
    const gitDirOf = (dir) => path.join(dir, '.git');
    /** Another repo, dirty, on a different branch: what a leaked GIT_DIR would show. */
    const otherRepo = () => {
      const b = repo('beta');
      fs.writeFileSync(path.join(b, 'beta.txt'), 'dirty\n');
      return b;
    };
    /** Set env vars in-process for the call, restore after (these sites read process.env). */
    function withEnv(vars, fn) {
      const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
      Object.assign(process.env, vars);
      try { return fn(); } finally {
        for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      }
    }
    const leak = (b) => ({ GIT_DIR: gitDirOf(b) });

    test('hooks/gsd-statusline.js readGitStatus', () => {
      const a = repo('alpha'); const b = otherRepo();
      const sl = require(hookPath('gsd-statusline.js'));
      const out = withEnv(leak(b), () => sl.readGitStatus(a));
      assert.match(out, /# branch\.head alpha\n/);
    });

    test('hooks/gsd-statusline.js readStateHeadCommits', () => {
      const a = repo('alpha'); const b = otherRepo();
      const stamp = gitOrThrow(['rev-parse', 'HEAD'], { cwd: a }).trim();
      fs.writeFileSync(path.join(a, 'alpha.txt'), '2\n');
      gitOrThrow(['commit', '-am', 'second'], { cwd: a });
      const sl = require(hookPath('gsd-statusline.js'));
      const out = withEnv(leak(b), () => sl.readStateHeadCommits(a, stamp));
      assert.deepEqual(sl.parseRevListCounts(out), { left: 0, right: 1 });
    });

    test('src/smart-entry.cts detectSignals', () => {
      const a = repo('alpha'); const b = otherRepo();
      const sig = withEnv(leak(b), () => lib('smart-entry').detectSignals(a));
      assert.equal(sig.has_git, true);
      assert.equal(sig.git_dirty, false, 'repo A is clean; B\'s dirtiness must not leak in');
    });

    test('src/pristine-baseline.cts gitExec', () => {
      const a = repo('alpha'); const b = otherRepo();
      const out = withEnv(leak(b), () => lib('pristine-baseline').gitExec(a, ['rev-parse', '--abbrev-ref', 'HEAD']));
      assert.equal(out.trim(), 'alpha');
    });

    test('src/roadmap-upgrade.cts applyMigration clean-tree check', () => {
      const a = repo('alpha', { extra: (d) => fs.writeFileSync(path.join(d, '.gitignore'), '.planning/\n') });
      const b = otherRepo();
      fs.mkdirSync(path.join(a, '.planning'), { recursive: true });
      fs.writeFileSync(path.join(a, '.planning', 'config.json'), JSON.stringify({ phase_id_convention: null }) + '\n');
      const emptyPlan = { alreadyMigrated: false, phases: [], roadmapEdits: [], crossRefEdits: [] };
      const r = withEnv(leak(b), () => lib('roadmap-upgrade').applyMigration(a, emptyPlan, { dryRun: false }));
      assert.equal(r.applied, true);
    });

    test('src/phase.cts sibling-worktree phase allocation', () => {
      const a = repo('main', {
        extra: (d) => {
          fs.mkdirSync(path.join(d, '.planning', 'phases', '440-existing'), { recursive: true });
          fs.writeFileSync(path.join(d, '.planning', 'phases', '440-existing', '.gitkeep'), '');
          fs.writeFileSync(path.join(d, '.planning', 'ROADMAP.md'), '# Roadmap v1.0\n\n### Phase 440: existing\n**Goal:** x\n\n---\n');
        },
      });
      const b = otherRepo();
      const sib = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-5548-sib-'));
      gitOrThrow(['worktree', 'add', '--detach', sib, 'HEAD'], { cwd: a });
      cleanups.push(() => { runGit(['worktree', 'remove', '--force', sib], { cwd: a, env: proj.scrubGitLocationEnv(process.env) }); cleanup(sib); });
      fs.mkdirSync(path.join(sib, '.planning', 'phases', '441-held'), { recursive: true });
      const r = runGsdTools(['phase', 'add', 'anything'], a, leak(b));
      assert.ok(r.success, r.error);
      assert.equal(JSON.parse(r.output).phase_number, 442, 'sibling worktree holds 441; a leaked GIT_DIR hides it');
    });

    test('gsd-workflow-guard.js currentBranch', () => {
      const a = repo('worktree-agent-test'); const b = otherRepo();
      fs.mkdirSync(path.join(a, '.planning'));
      fs.writeFileSync(path.join(a, '.planning', 'config.json'), JSON.stringify({ hooks: { workflow_guard: true } }));
      const r = runHook(hookPath('gsd-workflow-guard.js'), [], {
        input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git add -f secrets.env' }, cwd: a }),
        env: { ...process.env, ...leak(b) },
        timeoutMs: STAGED_HOOK_SCRIPT_TIMEOUT_MS,
      });
      assert.equal(r.exitCode, 2, r.stderr);
    });

    test('gsd-worktree-path-guard.js blocks a write into another repo', () => {
      const m = repo('main'); const c = repo('gamma');
      const w = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-5548-wt-'));
      gitOrThrow(['worktree', 'add', '-b', 'agent-x', w], { cwd: m });
      cleanups.push(() => { runGit(['worktree', 'remove', '--force', w], { cwd: m, env: proj.scrubGitLocationEnv(process.env) }); cleanup(w); });
      const b = otherRepo();
      const r = runHook(hookPath('gsd-worktree-path-guard.js'), [], {
        input: JSON.stringify({ tool_name: 'Write', tool_input: { file_path: path.join(c, 'f.txt') }, cwd: w }),
        env: { ...process.env, GIT_DIR: gitDirOf(b), GIT_WORK_TREE: b },
        timeoutMs: STAGED_HOOK_SCRIPT_TIMEOUT_MS,
      });
      assert.equal(r.exitCode, 2, r.stderr);
    });

    test('gsd-windsurf-pre-write.js blocks a write into another repo', () => {
      const a = repo('alpha'); const c = repo('gamma'); const b = otherRepo();
      const r = runHook(hookPath('gsd-windsurf-pre-write.js'), [], {
        input: JSON.stringify({ tool_info: { file_path: path.join(c, 'f.txt') } }),
        cwd: a,
        env: { ...process.env, GIT_DIR: gitDirOf(b), GIT_WORK_TREE: b },
        timeoutMs: STAGED_HOOK_SCRIPT_TIMEOUT_MS,
      });
      assert.equal(r.exitCode, 2, r.stderr);
    });

    test('workflows/pr-branch.md sub-repo dirty scan', () => {
      // Run the workflow's real bash block (unset … through DIRTY_REPOS=…), not a copy.
      const md = fs.readFileSync(path.join(ROOT, 'gsd-core', 'workflows', 'pr-branch.md'), 'utf8').split('\r').join('');
      const endMark = 'DIRTY_REPOS=$(cat "$DIRTY_FILE")';
      const start = md.indexOf('unset GIT_ALTERNATE_OBJECT_DIRECTORIES');
      const end = md.indexOf(endMark, start);
      assert.ok(start >= 0 && end > start, 'sub-repo dirty-scan block not found');
      const block = md.slice(start, end + endMark.length);
      const a = repo('alpha');
      const sub = path.join(a, 'sub');
      fs.mkdirSync(sub);
      gitOrThrow(['init', '-b', 'alpha'], { cwd: sub });
      gitOrThrow(['config', 'user.email', 't@t'], { cwd: sub });
      gitOrThrow(['config', 'user.name', 't'], { cwd: sub });
      fs.writeFileSync(path.join(sub, 'g.txt'), '1\n');
      gitOrThrow(['add', '-A'], { cwd: sub });
      gitOrThrow(['commit', '-m', 'init'], { cwd: sub });
      const b = otherRepo();
      const r = runHook('-c', [`SUB_REPOS_JSON='["sub"]'\n${block}\nprintf '[%s]%s' "$DIRTY_REPOS" "$ROOT"`], {
        interpreter: 'bash', cwd: a, env: { ...process.env, ...leak(b), GIT_WORK_TREE: b }, timeoutMs: HOOK_FANOUT_TIMEOUT_MS,
      });
      const last = r.stdout.trim().split('\n').pop();
      assert.ok(last.startsWith('[]'), 'sub is clean; a leaked GIT_DIR must not make it look dirty');
      assert.equal(fs.realpathSync.native(last.slice(2)), fs.realpathSync.native(a), 'ROOT must be the cwd repo, not the leaked GIT_DIR repo');
    });

    test('pr-branch.md inline scrub lists every location var', () => {
      const md = fs.readFileSync(path.join(ROOT, 'gsd-core', 'workflows', 'pr-branch.md'), 'utf8');
      const m = md.match(/!\/\^GIT_\(([^)]{0,300})\)\$\/i/);
      assert.ok(m, 'inline scrub regex not found');
      assert.deepEqual(m[1].split('|').sort(), proj.GIT_LOCATION_ENV_VARS.map((v) => v.slice(4)).sort());
    });

    test('hooks/gsd-graphify-update.sh (bash hook) resolves the branch from cwd', async (t) => {
      if (process.platform === 'win32') return t.skip('POSIX-only: bash hook');
      const a = repo('main'); const b = otherRepo();
      fs.mkdirSync(path.join(a, '.planning'));
      fs.writeFileSync(path.join(a, '.planning', 'config.json'), JSON.stringify({ graphify: { enabled: true, auto_update: true } }));
      const bin = path.join(a, '.mock-bin');
      fs.mkdirSync(bin);
      fs.writeFileSync(path.join(bin, 'graphify'), '#!/usr/bin/env bash\nmkdir -p graphify-out\necho {} > graphify-out/graph.json\n', { mode: 0o755 });
      const lock = path.join(a, '.planning', 'graphs', '.rebuild.lock');
      const r = runHook(hookPath('gsd-graphify-update.sh'), [], {
        interpreter: 'bash', cwd: a,
        input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git commit -m x' } }),
        env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, CI: '', ...leak(b) },
        timeoutMs: HOOK_FANOUT_TIMEOUT_MS,
      });
      assert.equal(r.exitCode, 0);
      const status = path.join(a, '.planning', 'graphs', '.last-build-status.json');
      assert.ok(fs.existsSync(status), 'default-branch gate must see repo A (main), not the leaked repo B (beta)');
      for (let i = 0; i < 600 && fs.existsSync(lock); i++) await delay(25);
    });
  });
});
