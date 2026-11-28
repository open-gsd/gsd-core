'use strict';

/**
 * #6043 (Phase 1 of #4908, ADR-4908 §3): CLI contracts of the project-context
 * seam, driven through the real gsd-tools dispatcher from linked-worktree
 * subdirectories: the commit verb refuses to write outside the worktree, the
 * workspace sub_repos layout resolves to the workspace, and `query
 * project-context` prints the resolved context.
 *
 * Failing-first: RED until the seam, the commit refusal and the verb exist.
 *
 * #6820 (Phase 2a of #6044): the second half of this file, from the block
 * marked `#6820` down, covers the resolver consumers: `uat render-checkpoint`
 * under a symlinked planning store, verification reading `ctx.projectRoot`, and
 * the retired `--project-dir` global.
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

function head(dir) {
  return git(['rev-parse', 'HEAD'], dir);
}

function mkTmp(t) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-6043-cli-')));
  t.after(() => cleanup(dir));
  return dir;
}

function write(file, body = '') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

const COMMIT_DOCS_ON = JSON.stringify({ commit_docs: true });

function mkRepo(dir, { planning = false, gitignore = '' } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  git(['init', '-q', '-b', 'main'], dir);
  write(path.join(dir, 'README.md'), '# fixture\n');
  if (gitignore) write(path.join(dir, '.gitignore'), gitignore);
  if (planning) write(path.join(dir, '.planning', 'config.json'), COMMIT_DOCS_ON);
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', 'init'], dir);
  return dir;
}

function addWorktree(main, wtDir, branch) {
  git(['worktree', 'add', '-q', '-b', branch, wtDir], main);
  return fs.realpathSync.native(wtDir);
}

function run(args, cwd, tmp) {
  return runGsdTools([...args, '--json-errors'], cwd, isolatedEnv({ home: tmp, override: GIT_ENV }));
}

/** The typed result object a verb printed, from stdout or (json-errors) stderr. */
function outcome(res) {
  for (const text of [res.output, res.error]) {
    if (!text) continue;
    for (const candidate of [text, ...text.split('\n').reverse()]) {
      try {
        const value = JSON.parse(candidate);
        if (value && typeof value === 'object') return value;
      } catch {
        // not JSON; try the next candidate
      }
    }
  }
  return null;
}

function assertRefused(res, reason) {
  assert.notEqual(res.exitCode, 0, `refusal must exit non-zero; got ${JSON.stringify(res)}`);
  const o = outcome(res);
  assert.ok(o, `refusal must print a typed result; got ${JSON.stringify(res)}`);
  assert.equal(o.reason, reason);
  if ('committed' in o) assert.equal(o.committed, false);
}

/** Main checkout whose .planning exists ONLY in main (untracked), plus a linked worktree without it. */
function mkMainOnlyPlanning(t, { gitignore = '' } = {}) {
  const tmp = mkTmp(t);
  const main = fs.realpathSync.native(mkRepo(path.join(tmp, 'main'), { gitignore }));
  const wt = addWorktree(main, path.join(tmp, 'wt'), 'feat-a');
  write(path.join(main, '.planning', 'config.json'), COMMIT_DOCS_ON);
  write(path.join(main, '.planning', 'STATE.md'), '# state\n');
  const sub = path.join(wt, 'src', 'deep');
  fs.mkdirSync(sub, { recursive: true });
  return { tmp, main, wt, sub };
}

/** Main checkout with tracked .planning, plus a linked worktree that has its own copy. */
function mkTrackedPlanning(t) {
  const tmp = mkTmp(t);
  const main = fs.realpathSync.native(mkRepo(path.join(tmp, 'main'), { planning: true }));
  const wt = addWorktree(main, path.join(tmp, 'wt'), 'feat-a');
  const sub = path.join(wt, 'src', 'deep');
  fs.mkdirSync(sub, { recursive: true });
  return { tmp, main, wt, sub };
}

describe('project-context CLI: commit refuses to write outside the worktree', () => {
  test('commit: refuses outside_worktree (#4885 contract)', (t) => {
    const { tmp, main, wt, sub } = mkMainOnlyPlanning(t);
    const mainBefore = head(main);
    const wtBefore = head(wt);
    const res = run(['commit', 'docs: planning from worktree', '--files', '.planning/STATE.md'], sub, tmp);
    assertRefused(res, 'outside_worktree');
    assert.equal(head(main), mainBefore, 'main checkout HEAD unchanged');
    assert.equal(head(wt), wtBefore, 'worktree HEAD unchanged');
  });

  test('commit: refuses outside_worktree for the default .planning/ path', (t) => {
    const { tmp, main, wt, sub } = mkMainOnlyPlanning(t);
    const mainBefore = head(main);
    const wtBefore = head(wt);
    const res = run(['commit', 'docs: default planning commit'], sub, tmp);
    assertRefused(res, 'outside_worktree');
    assert.equal(head(main), mainBefore);
    assert.equal(head(wt), wtBefore);
  });

  test('commit: gitignored planning still skips', (t) => {
    const { tmp, main, wt, sub } = mkMainOnlyPlanning(t, { gitignore: '.planning/\n' });
    const mainBefore = head(main);
    const wtBefore = head(wt);
    const res = run(['commit', 'docs: ignored planning', '--files', '.planning/STATE.md'], sub, tmp);
    assert.equal(res.exitCode, 0, `skip is not an error; got ${JSON.stringify(res)}`);
    const o = outcome(res);
    assert.ok(o);
    assert.equal(o.committed, false);
    assert.notEqual(o.reason, 'outside_worktree', 'the refusal is after the commit_docs skip');
    assert.equal(head(main), mainBefore);
    assert.equal(head(wt), wtBefore);
  });

  test('commit: worktree subdirectory commits in worktree (#4885)', (t) => {
    const { tmp, main, wt, sub } = mkTrackedPlanning(t);
    write(path.join(wt, '.planning', 'STATE.md'), '# state in the worktree\n');
    const mainBefore = head(main);
    const wtBefore = head(wt);
    const res = run(['commit', 'docs: state from worktree subdir', '--files', '.planning/STATE.md'], sub, tmp);
    assert.equal(res.exitCode, 0, JSON.stringify(res));
    const o = outcome(res);
    assert.ok(o);
    assert.equal(o.committed, true);
    assert.notEqual(head(wt), wtBefore, 'worktree HEAD advanced');
    assert.equal(head(main), mainBefore, 'main checkout HEAD unchanged');
    assert.match(git(['show', '--name-only', '--format=', 'HEAD'], wt), /\.planning\/STATE\.md/);
    assert.equal(git(['status', '--porcelain'], main), '', 'main checkout untouched');
  });

  test('commit: escaping --files refused', (t) => {
    const { tmp, main, wt } = mkTrackedPlanning(t);
    write(path.join(tmp, 'outside.md'), '# outside\n');
    const mainBefore = head(main);
    const wtBefore = head(wt);
    const res = run(['commit', 'docs: escaping path', '--files', '../outside.md'], wt, tmp);
    assertRefused(res, 'outside_worktree');
    assert.equal(head(main), mainBefore);
    assert.equal(head(wt), wtBefore);
  });

  test('commit: dot-dot staying inside accepted', (t) => {
    const { tmp, wt } = mkTrackedPlanning(t);
    write(path.join(wt, '.planning', 'b.md'), '# b\n');
    const before = head(wt);
    const res = run(['commit', 'docs: dot-dot inside', '--files', '.planning/a/../b.md'], wt, tmp);
    assert.equal(res.exitCode, 0, JSON.stringify(res));
    assert.equal(outcome(res).committed, true);
    assert.notEqual(head(wt), before);
  });

  test('commit: absolute --files path inside the worktree accepted', (t) => {
    const { tmp, wt, sub } = mkTrackedPlanning(t);
    const abs = path.join(wt, '.planning', 'abs.md');
    write(abs, '# abs\n');
    const before = head(wt);
    const res = run(['commit', 'docs: absolute inside', '--files', abs], sub, tmp);
    assert.equal(res.exitCode, 0, JSON.stringify(res));
    assert.equal(outcome(res).committed, true);
    assert.notEqual(head(wt), before);
  });

  test('commit: not a git repo refuses not_git_repo', (t) => {
    const tmp = mkTmp(t);
    const dir = path.join(tmp, 'plain');
    write(path.join(dir, '.planning', 'config.json'), COMMIT_DOCS_ON);
    write(path.join(dir, '.planning', 'STATE.md'), '# state\n');
    const res = run(['commit', 'docs: no repo', '--files', '.planning/STATE.md'], dir, tmp);
    assertRefused(res, 'not_git_repo');
    assert.equal(fs.existsSync(path.join(dir, '.git')), false, 'no repository was created');
  });

  test('commit: refused outside_worktree from a linked worktree inside a planning.sub_repos workspace (ADR-4908 §3)', (t) => {
    const tmp = mkTmp(t);
    const main = fs.realpathSync.native(mkRepo(path.join(tmp, 'main-repo')));
    const ws = path.join(tmp, 'workspace');
    write(path.join(ws, 'README.md'), '# workspace\n');
    git(['init', '-q', '-b', 'main'], ws);
    git(['add', 'README.md'], ws);
    git(['commit', '-q', '-m', 'workspace init'], ws);
    write(
      path.join(ws, '.planning', 'config.json'),
      JSON.stringify({ commit_docs: true, planning: { sub_repos: ['wt-a'] } }),
    );
    write(path.join(ws, '.planning', 'STATE.md'), '# workspace state\n');
    const wt = addWorktree(main, path.join(ws, 'wt-a'), 'feat-ws-commit');
    const sub = path.join(wt, 'src');
    fs.mkdirSync(sub, { recursive: true });
    const wsBefore = head(ws);
    const mainBefore = head(main);
    const wtBefore = head(wt);

    const res = run(['commit', 'docs: workspace planning', '--files', '.planning/STATE.md'], sub, tmp);
    assertRefused(res, 'outside_worktree');
    assert.equal(head(ws), wsBefore, 'workspace repo HEAD unchanged');
    assert.equal(head(main), mainBefore, 'main checkout HEAD unchanged');
    assert.equal(head(wt), wtBefore, 'worktree HEAD unchanged');
  });

  describe('commit: a symlinked path to the worktree is not outside it', () => {
    const skip = process.platform === 'win32' ? 'symlink creation needs privileges on win32' : false;

    function mkLinked(t) {
      const tmp = mkTmp(t);
      const repo = fs.realpathSync.native(mkRepo(path.join(tmp, 'real', 'repo'), { planning: true }));
      const link = path.join(tmp, 'link');
      fs.symlinkSync(path.join(tmp, 'real'), link, 'dir');
      write(path.join(repo, '.planning', 'STATE.md'), '# state\n');
      return { tmp, repo, viaLink: path.join(link, 'repo') };
    }

    test('cwd reached through a symlinked directory is not refused', { skip }, (t) => {
      const { tmp, repo, viaLink } = mkLinked(t);
      const before = head(repo);
      const res = run(['commit', 'docs: via symlinked cwd', '--files', '.planning/STATE.md'], viaLink, tmp);
      assert.equal(res.exitCode, 0, JSON.stringify(res));
      assert.equal(outcome(res).committed, true);
      assert.notEqual(head(repo), before);
    });

    test('absolute in-tree path through the symlinked prefix is not refused', { skip }, (t) => {
      const { tmp, repo, viaLink } = mkLinked(t);
      const before = head(repo);
      const abs = path.join(viaLink, '.planning', 'STATE.md');
      const res = run(['commit', 'docs: via symlinked absolute path', '--files', abs], repo, tmp);
      assert.equal(res.exitCode, 0, JSON.stringify(res));
      assert.equal(outcome(res).committed, true);
      assert.notEqual(head(repo), before);
    });

    test('non-canonical os.tmpdir() absolute path is not refused (macOS /var vs /private/var)', (t) => {
      const raw = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-6043-raw-'));
      t.after(() => cleanup(raw));
      const repo = mkRepo(path.join(raw, 'repo'), { planning: true });
      write(path.join(repo, '.planning', 'STATE.md'), '# state\n');
      const before = head(repo);
      const res = run(['commit', 'docs: raw tmpdir', '--files', path.join(repo, '.planning', 'STATE.md')], repo, raw);
      assert.equal(res.exitCode, 0, JSON.stringify(res));
      assert.equal(outcome(res).committed, true);
      assert.notEqual(head(repo), before);
    });
  });
});

describe('project-context CLI: workspace and verb', () => {
  test('project-context: workspace sub_repos worktree config-path (#4908 comment)', (t) => {
    const tmp = mkTmp(t);
    const main = fs.realpathSync.native(mkRepo(path.join(tmp, 'main-repo')));
    const ws = path.join(tmp, 'workspace');
    write(path.join(ws, '.planning', 'config.json'), JSON.stringify({ planning: { sub_repos: ['wt-a'] } }));
    const wt = addWorktree(main, path.join(ws, 'wt-a'), 'feat-ws');
    const sub = path.join(wt, 'src');
    fs.mkdirSync(sub, { recursive: true });

    const res = run(['config-path', '--raw'], sub, tmp);
    assert.equal(res.exitCode, 0, JSON.stringify(res));
    assert.equal(
      fs.realpathSync.native(res.output.trim()),
      fs.realpathSync.native(path.join(ws, '.planning', 'config.json')),
      'config-path resolves to the workspace, not the main checkout',
    );
  });

  test('project-context verb: JSON of the resolved context', (t) => {
    const { tmp, main, wt, sub } = mkTrackedPlanning(t);
    const res = run(['query', 'project-context'], sub, tmp);
    assert.equal(res.exitCode, 0, JSON.stringify(res));
    const ctx = JSON.parse(res.output);
    assert.equal(ctx.projectRoot, wt);
    assert.equal(ctx.planningRoot, fs.realpathSync.native(path.join(wt, '.planning')));
    assert.equal(ctx.worktreeRoot, wt);
    assert.equal(ctx.repoRoot, main);
    assert.equal(ctx.gitCommonDir, path.join(main, '.git'));
    assert.equal(ctx.isLinkedWorktree, true);
    assert.equal(ctx.provenance.source, 'ancestor');
    assert.equal(ctx.provenance.reason, 'ok');
    assert.equal(ctx.provenance.degraded, false);
    assert.deepEqual(ctx.provenance.warnings, []);
    assert.deepEqual(
      Object.keys(ctx).sort(),
      ['gitCommonDir', 'isLinkedWorktree', 'planningRoot', 'projectRoot', 'provenance', 'repoRoot', 'worktreeRoot'],
    );
  });

  test('project-context verb: --raw prints worktreeRoot', (t) => {
    const { tmp, wt, sub } = mkTrackedPlanning(t);
    const res = run(['query', 'project-context', '--raw'], sub, tmp);
    assert.equal(res.exitCode, 0, JSON.stringify(res));
    assert.equal(res.output.trim(), wt);
  });
});

// ─── #6820 (Phase 2a of #6044): the resolver consumers take the ProjectContext ───
{
  /**
   * #6820 (Phase 2a of #6044 / epic #4908, ADR-4908): the resolver consumers take
   * the ProjectContext. Failing-first suite (matrix: T1-T12).
   *
   * Fixtures are real directories in mkdtemp dirs (realpath'd so macOS
   * /var -> /private/var never skews an equality), cleaned with t.after.
   */

  const { resolveProjectContext, requirePlanningArtifactPath } = require('../gsd-core/bin/lib/project-context.cjs');
  const projectRootModule = require('../gsd-core/bin/lib/project-root.cjs');
  const verification = require('../gsd-core/bin/lib/verification.cjs');

  const UAT_BODY = '---\nstatus: testing\n---\n\n## Current Test\n\nnumber: 1\nname: Login\nexpected: user sees the dashboard\n';
  const PHASE = '01-x';

  /** repo/.planning is a symlink to ../repo-planning, which holds the phase + UAT file. */
  function mkSymlinkedPlanning(t) {
    const base = mkTmp(t);
    const repo = path.join(base, 'repo');
    const store = path.join(base, 'repo-planning');
    fs.mkdirSync(repo, { recursive: true });
    write(path.join(store, 'phases', PHASE, `${PHASE}-UAT.md`), UAT_BODY);
    fs.symlinkSync(store, path.join(repo, '.planning'), 'dir');
    return { base, repo, store };
  }

  describe('uat render-checkpoint containment for planning artifacts (B9)', () => {
    test('renderCheckpointAcceptsUatFileUnderSymlinkedPlanningStore', (t) => {
      const { repo } = mkSymlinkedPlanning(t);
      const r = runGsdTools(['uat', 'render-checkpoint', '--file', `.planning/phases/${PHASE}/${PHASE}-UAT.md`], repo);
      assert.equal(r.success, true, r.error);
      assert.match(r.output, /Login/);
    });

    test('renderCheckpointAcceptsAChildWhoseNameStartsWithTwoDots', (t) => {
      const { repo, store } = mkSymlinkedPlanning(t);
      write(path.join(store, 'phases', PHASE, '..odd-UAT.md'), UAT_BODY);
      const r = runGsdTools(['uat', 'render-checkpoint', '--file', `.planning/phases/${PHASE}/..odd-UAT.md`], repo);
      assert.equal(r.success, true, r.error);
      assert.match(r.output, /Login/);
    });

    test('requirePlanningArtifactPathChoosesTheStoreForPlanningPathsAndTheProjectForTheRest', (t) => {
      const { repo, store } = mkSymlinkedPlanning(t);
      write(path.join(repo, 'src', 'a.txt'), 'alpha\n');
      const ctx = resolveProjectContext(repo);
      const planning = requirePlanningArtifactPath(ctx, `.planning/phases/${PHASE}/${PHASE}-UAT.md`, 'artifact');
      // `resolved` is the real target, spelled by the JS realpath (the old project-root check's spelling), not by
      // ctx.planningRoot's realpathSync.native, which expands Windows 8.3 names that cwd keeps.
      assert.equal(planning.resolved, fs.realpathSync(path.join(repo, '.planning', 'phases', PHASE, `${PHASE}-UAT.md`)));
      // A path given through the store's own location resolves to that location.
      const viaStore = requirePlanningArtifactPath(ctx, path.join(store, 'phases', PHASE, `${PHASE}-UAT.md`), 'artifact');
      assert.equal(viaStore.resolved, path.join(fs.realpathSync.native(store), 'phases', PHASE, `${PHASE}-UAT.md`));
      assert.equal(planning.display, path.join('.planning', 'phases', PHASE, `${PHASE}-UAT.md`));
      const project = requirePlanningArtifactPath(ctx, 'src/a.txt', 'artifact');
      assert.equal(project.resolved, path.join(fs.realpathSync.native(repo), 'src', 'a.txt'));
      assert.equal(project.display, path.join('src', 'a.txt'));
      assert.throws(() => requirePlanningArtifactPath(ctx, '../outside/x.md', 'artifact'), /artifact validation failed: Path escapes allowed directory/);
    });

    test('renderCheckpointStillWorksWithARealPlanningDirectory', (t) => {
      const repo = path.join(mkTmp(t), 'repo');
      write(path.join(repo, '.planning', 'phases', PHASE, `${PHASE}-UAT.md`), UAT_BODY);
      const r = runGsdTools(['uat', 'render-checkpoint', '--file', `.planning/phases/${PHASE}/${PHASE}-UAT.md`], repo);
      assert.equal(r.success, true, r.error);
      assert.match(r.output, /Login/);
    });

    test('renderCheckpointRefusesSiblingDirectorySharingThePlanningStorePrefix', (t) => {
      const { base, repo } = mkSymlinkedPlanning(t);
      const evil = path.join(base, 'repo-planning-evil', 'x-UAT.md');
      write(evil, UAT_BODY);
      const r = runGsdTools(['uat', 'render-checkpoint', '--file', evil], repo);
      assert.equal(r.success, false);
      assert.match(r.error, /UAT file validation failed: Path escapes allowed directory/);
    });

    test('renderCheckpointRefusesTraversalOutOfTheProject', (t) => {
      const { base, repo } = mkSymlinkedPlanning(t);
      write(path.join(base, 'outside', 'UAT.md'), UAT_BODY);
      const r = runGsdTools(['uat', 'render-checkpoint', '--file', '../outside/UAT.md'], repo);
      assert.equal(r.success, false);
      assert.match(r.error, /UAT file validation failed: Path escapes allowed directory/);
    });

    test('renderCheckpointRefusesSymlinkLeavingBothRoots', (t) => {
      const { base, repo, store } = mkSymlinkedPlanning(t);
      const target = path.join(base, 'outside', 'UAT.md');
      write(target, UAT_BODY);
      fs.symlinkSync(target, path.join(store, 'phases', PHASE, 'link-UAT.md'), 'file');
      const r = runGsdTools(['uat', 'render-checkpoint', '--file', `.planning/phases/${PHASE}/link-UAT.md`], repo);
      assert.equal(r.success, false);
      assert.match(r.error, /UAT file validation failed: Path escapes allowed directory/);
    });
  });

  describe('verification takes the context root, not a walk-up from the phase directory (B1-B3)', () => {
    function mkProject(root, withFile) {
      write(path.join(root, '.planning', 'PROJECT.md'), '# p\n');
      if (withFile) write(path.join(root, 'src', 'a.txt'), 'alpha\n');
    }

    /**
     * Project B holds src/a.txt; the phase directory is nested at B/sub, which has its own `.planning`
     * (and, when `aHasFile`, its own src/a.txt), so a walk-up from the phase directory lands on B/sub
     * ("A") while the context can name B. The report's digest is taken over B's files. A v4 digest is
     * only computable for a phase directory inside the root, hence the nesting.
     */
    function mkTwoProjects(t, { aHasFile }) {
      const base = mkTmp(t);
      const b = path.join(base, 'b');
      const a = path.join(b, 'sub');
      mkProject(b, true);
      mkProject(a, aHasFile);
      const phaseDir = path.join(a, '.planning', 'phases', PHASE);
      fs.mkdirSync(phaseDir, { recursive: true }); // the digest enumerates the phase's own artifacts
      const digest = verification.computeCoveredDigest(b, ['src/a.txt'], 4, { phaseDir });
      assert.equal(typeof digest, 'string', 'fixture digest must compute over project B');
      write(
        path.join(phaseDir, `${PHASE}-VERIFICATION.md`),
        `---\nstatus: passed\ncovered_files:\n  - src/a.txt\ncovered_digest: ${digest}\n---\n\n# Verification\n`,
      );
      return { a, b, phaseDir };
    }

    test('verificationReadsTheContextRootNotAWalkUpFromThePhaseDir', (t) => {
      const { b, phaseDir } = mkTwoProjects(t, { aHasFile: false });
      const ctx = resolveProjectContext(b, { explicit: b });
      const result = verification.readVerificationStatus(phaseDir, { ctx });
      assert.equal(result.status, 'passed');
    });

    test('verificationFailsClosedWhenTheContextRootDoesNotHoldTheCoveredFiles', (t) => {
      const { a, phaseDir } = mkTwoProjects(t, { aHasFile: false });
      const ctx = resolveProjectContext(a, { explicit: a });
      const result = verification.readVerificationStatus(phaseDir, { ctx });
      assert.equal(result.status, 'stale');
    });

    test('verificationRefusesToReadWithoutAContext', (t) => {
      const { phaseDir } = mkTwoProjects(t, { aHasFile: true });
      // ADR-4908 section 6: ctx is required; there is no phase-dir walk-up fallback to fall into.
      assert.throws(() => verification.readVerificationStatus(phaseDir), (err) => err instanceof TypeError);
    });

    test('fingerprintHonorsProjectDirFromAnyCwd', (t) => {
      const base = mkTmp(t);
      const p = path.join(base, 'p');
      const elsewhere = path.join(base, 'elsewhere');
      mkProject(p, true);
      fs.mkdirSync(elsewhere, { recursive: true });
      const phaseDir = path.join(p, '.planning', 'phases', PHASE);
      fs.mkdirSync(phaseDir, { recursive: true });
      // `elsewhere` is itself a project holding a DIFFERENT src/a.txt, so a digest taken over the
      // wrong root is distinguishable from one taken over `p`.
      mkProject(elsewhere, false);
      write(path.join(elsewhere, 'src', 'a.txt'), 'different content\n');
      const args = ['verification', 'fingerprint', phaseDir, 'src/a.txt'];
      const fromElsewhere = runGsdTools([...args, '--project-dir', p], elsewhere);
      const fromInside = runGsdTools(args, p);
      assert.equal(fromElsewhere.success, true, fromElsewhere.error);
      assert.equal(fromInside.success, true, fromInside.error);
      const expected = verification.computeCoveredDigest(p, ['src/a.txt'], 4, { phaseDir });
      const wrongRoot = verification.computeCoveredDigest(elsewhere, ['src/a.txt'], 4, { phaseDir });
      assert.notEqual(expected, wrongRoot);
      assert.equal(JSON.parse(fromElsewhere.output).covered_digest, expected);
      assert.equal(JSON.parse(fromInside.output).covered_digest, expected);
    });

    test('explicitSourceLivesOnTheContextAndNeverCarriesToTheNextResolution', (t) => {
      const base = mkTmp(t);
      const p = path.join(base, 'p');
      const q = path.join(base, 'q');
      mkProject(p, false);
      mkProject(q, false);
      const first = resolveProjectContext(q, { explicit: p });
      const second = resolveProjectContext(q);
      assert.equal(first.provenance.source, 'explicit');
      assert.equal(first.projectRoot, p);
      assert.equal(second.provenance.source, 'ancestor');
      assert.equal(second.projectRoot, q);
    });
  });

  describe('the retired root resolvers (B6, B10)', () => {
    test('retiredRootResolversAreNotExported', () => {
      const exported = Object.keys(projectRootModule).sort();
      assert.deepEqual(exported, ['consentProjectRoot']);
      assert.equal(projectRootModule.findProjectRoot, undefined);
      assert.equal(projectRootModule.setExplicitProjectRoot, undefined);
      assert.equal(projectRootModule.resolveProjectRoot, undefined);
    });

    test('consentProjectRootKeyIsStableAcrossSubdirectories', (t) => {
      const repo = path.join(mkTmp(t), 'repo');
      write(path.join(repo, '.planning', 'PROJECT.md'), '# p\n');
      const sub = path.join(repo, 'a', 'b');
      fs.mkdirSync(sub, { recursive: true });
      assert.equal(projectRootModule.consentProjectRoot(sub), fs.realpathSync.native(repo));
      assert.equal(projectRootModule.consentProjectRoot(repo), fs.realpathSync.native(repo));

      const linked = mkSymlinkedPlanning(t);
      assert.equal(projectRootModule.consentProjectRoot(linked.repo), fs.realpathSync.native(linked.repo));

      const bare = mkTmp(t);
      assert.equal(projectRootModule.consentProjectRoot(bare), bare);
    });
  });
}
