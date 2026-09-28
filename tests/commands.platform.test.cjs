'use strict';

/**
 * Platform-sensitive tests split out of tests/commands.test.cjs (#5074).
 *
 * scripts/gen-platform-conformance-tier.cjs selects whole files for the real-OS
 * (Windows/macOS) conformance tier. The tests below carry the platform signal, so
 * they live here; tests/commands.test.cjs stays signal-free and runs on Linux only.
 * Linux lanes run both files. Add a new platform-sensitive test HERE, not in the
 * base file — the generator fails if a split base regains a platform signal.
 *
 * Moved tests and why each needs a real OS:
 * - "[#4652] a symlink inside pending/ whose target is a real file outside the todos root is rejected — the outside target is untouched" — creates a real symlink via fs.symlinkSync (symlink-keyword)
 * - "F2 (#3588): a staged .planning/ file with a quote character in its name is detected and blocked" — skips on win32 because `"` is an illegal NTFS filename character (win32-darwin-literal, process-platform)
 * - "C7 (#3588, flipped): a staged .planning/ file whose name contains a backslash character is detected and blocked" — skips on win32 because `\` is an illegal Windows filename character (win32-darwin-literal, process-platform)
 * - "#3901: the suite isolates children from the host git config (global core.hooksPath)" — spawns a raw `git config` child to probe host isolation (raw-child-process)
 * - "A3: hook file is executable after enable" — asserts the POSIX executable bit on the installed hook file (process-platform, chmod-mode-bit)
 * - "A4: hook exits zero when the guard allows" — runs the installed pre-commit hook through a real bash interpreter (shell-interpreter-spawn)
 * - "A5: hook exits non-zero and names the staged files when the guard blocks" — same real-interpreter hook execution, opposite branch (shell-interpreter-spawn)
 * - "B1: enable writes an executable hook and reports success" — asserts the hook's mode bits after enable (process-platform, chmod-mode-bit)
 * - "B2: enable refuses to clobber an existing foreign pre-commit hook" — sets mode bits (chmodSync) to simulate a foreign hook (chmod-mode-bit)
 * - "B5: disable refuses to remove a foreign hook" — same chmod-based foreign-hook fixture (chmod-mode-bit)
 * - "pr-subrepo push failure: branch+commit survive when push is rejected (no data loss)" — chmods a hook script executable to simulate a rejecting remote (chmod-mode-bit)
 * - "dirty-scan rejects traversal, newline, and symlink entries before invoking git (security)" — creates a real symlink escape fixture via fs.symlinkSync (symlink-keyword)
 * - "PATH-NORMALIZATION: resolved under project root via realpath → no false positive" — exercises realpath-style symlink path normalization (symlink-keyword)
 * - "home-default effort config gap: applies home-level effort when project config has no effort section" — overrides HOME/USERPROFILE to test home-directory config resolution (windows-env-var)
 * - "B12 (negative proof): symlinked .toml — skipped, target byte-identical after" — creates a real symlink via fs.symlinkSync (symlink-keyword)
 * - "a mode-only change to an assume-unchanged path is still committed" — chmods a tracked file to pin the executable-bit-only diff case (chmod-mode-bit)
 * - "AC1: empty diff + rejecting pre-commit hook reports nothing_to_commit, not the hook rejection" — runs a real executable pre-commit hook installed with a POSIX mode bit (chmod-mode-bit)
 * - "AC2: empty diff + passing hook still reports nothing_to_commit" — runs a real executable pre-commit hook installed with a POSIX mode bit (chmod-mode-bit)
 * - "AC3: every named path missing from disk still reports nothing_to_commit" — runs a real executable pre-commit hook installed with a POSIX mode bit (chmod-mode-bit)
 * - "AC3: all named paths missing does not consult unrelated staged work" — runs a real executable pre-commit hook installed with a POSIX mode bit (chmod-mode-bit)
 * - "AC4: a real diff rejected by the hook still reports commit_failed with the hook message" — runs a real executable pre-commit hook installed with a POSIX mode bit (chmod-mode-bit)
 * - "AC5: --amend remains exempt from the empty-diff guard" — runs a real executable pre-commit hook installed with a POSIX mode bit (chmod-mode-bit)
 * - "a cherry-pick in progress keeps its pre-existing outcome" — runs a real executable pre-commit hook installed with a POSIX mode bit (chmod-mode-bit)
 * - "a revert in progress still reports nothing_to_commit, not the hook rejection" — runs a real executable pre-commit hook installed with a POSIX mode bit (chmod-mode-bit)
 */

const { test, describe, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  runGsdTools,
  createTempProject,
  createTempDir,
  cleanup,
  captureFdSync,
  TEST_ENV_BASE,
} = require('./helpers.cjs');
const { runNode, runHook } = require('./helpers/process-seam.cjs');
const { gitOrThrow, throwIfFailed } = require('./helpers/git-fixture.cjs');
const { GIT_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

// ─────────────────────────────────────────────────────────────────────────────
// todo complete — containment boundary (#4327)
// ─────────────────────────────────────────────────────────────────────────────

describe('todo complete — containment boundary (#4327)', () => {
  let tmpDir;
  let pendingDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    pendingDir = path.join(tmpDir, '.planning', 'todos', 'pending');
    fs.mkdirSync(pendingDir, { recursive: true });
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('[#4652] a symlink inside pending/ whose target is a real file outside the todos root is rejected — the outside target is untouched', (t) => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-todo-outside-'));
    const linkPath = path.join(pendingDir, 'linked.md');
    try {
      const outsideFile = path.join(outsideDir, 'real-target.md');
      const sentinel = '---\nstatus: pending\n---\nSENTINEL-SYMLINK\n';
      fs.writeFileSync(outsideFile, sentinel);
      try {
        fs.symlinkSync(outsideFile, linkPath, 'file');
      } catch (e) {
        if (e.code === 'EPERM') {
          t.skip('symlink creation is not permitted on this platform (EPERM)');
          return;
        }
        throw e;
      }

      const result = runGsdTools(['todo', 'complete', 'linked.md'], tmpDir);

      assert.strictEqual(result.success, false, 'a symlink pointing outside the todos root must be rejected');
      assert.ok(fs.existsSync(outsideFile), 'the outside symlink target must still exist');
      assert.strictEqual(
        fs.readFileSync(outsideFile, 'utf-8'),
        sentinel,
        'the outside symlink target content must be byte-for-byte untouched',
      );
    } finally {
      cleanup(outsideDir);
      try { fs.unlinkSync(linkPath); } catch { /* not created, or already gone */ }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// check-commit command
// ─────────────────────────────────────────────────────────────────────────────

describe('check-commit command', () => {
  const { createTempGitProject } = require('./helpers.cjs');
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempGitProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('F2 (#3588): a staged .planning/ file with a quote character in its name is detected and blocked', (t) => {
    // `"` is a reserved NTFS character — a file named `with"quote.md` cannot
    // exist on Windows at all, so the fixture itself is unrepresentable
    // there. This is not a gap in the guard's Windows behavior; it is an
    // input that Windows filesystems reject outright. Do not re-enable this
    // on win32 — see #3588.
    if (process.platform === 'win32') {
      t.skip('a `"` filename is illegal on Windows filesystems (#3588); fixture cannot be created');
      return;
    }
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ commit_docs: false })
    );
    const quotedName = '.planning/with"quote.md';
    fs.writeFileSync(path.join(tmpDir, quotedName), '# State');
    gitOrThrow(['add', quotedName], { cwd: tmpDir });

    const result = runGsdTools('check-commit', tmpDir);
    assert.ok(!result.success, 'a staged .planning/ file with a quote character in its name must be detected and block the commit');
    assert.ok(result.error.includes('quote.md'), result.error);
  });

  // #3588 C7 (flipped): the earlier pass's C7 test pinned a synthetic
  // top-level filename (`.planning\STATE.md`, backslash as a literal
  // character in a single path component, not a real nested directory — git
  // never uses backslash as a tree separator, on any platform) as evidence
  // that `f.startsWith('.planning\\')` was unreachable, and left the assertion
  // at "currently allowed" pending a fix. That branch is now removed as dead
  // code (git's plumbing output is always `/`-normalized, so a real Windows
  // `.planning\<file>` path never reaches this filter as a `.planning\`
  // prefix). This replaces it with the REAL analog of the same class of bug:
  // a genuine `.planning/` file whose name merely CONTAINS a literal
  // backslash character. Without `-z` that name is also C-style-quoted
  // (`".planning/back\\slash.md"`) and missed; with `-z` it is read as raw,
  // unquoted bytes and correctly detected via the plain `.planning/` prefix
  // check alone — no backslash-specific branch needed.
  test('C7 (#3588, flipped): a staged .planning/ file whose name contains a backslash character is detected and blocked', (t) => {
    // `\` is the Windows path separator, not a legal character inside a
    // single filename component — a file literally named `back\slash.md`
    // cannot be created on Windows filesystems, so the fixture itself is
    // unrepresentable there. This is not a gap in the guard's Windows
    // behavior; it is an input Windows rejects outright. Do not re-enable
    // this on win32 — see #3588.
    if (process.platform === 'win32') {
      t.skip('a `\\` filename is illegal on Windows filesystems (#3588); fixture cannot be created');
      return;
    }
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ commit_docs: false })
    );
    const backslashInName = '.planning/back\\slash.md';
    fs.writeFileSync(path.join(tmpDir, backslashInName), '# State');
    gitOrThrow(['add', backslashInName], { cwd: tmpDir });

    const result = runGsdTools('check-commit', tmpDir);
    assert.ok(
      !result.success,
      'a staged .planning/ file whose name contains a backslash character must be detected and block the commit',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// commit-docs-guard: opt-in pre-commit hook (#3588)
// ─────────────────────────────────────────────────────────────────────────────

// #3901: a developer's GLOBAL core.hooksPath (~/.gitconfig) applies to every
// fresh repo — the guard correctly refuses to install a hook git would never
// run, which used to fail the guard suites' beforeEach on machines that
// centralize commit hooks. Pin GIT_CONFIG_GLOBAL to an empty file (runGsdTools
// and the git helpers propagate process.env to every child), making the
// fixtures independent of the host's git configuration. Ref-counted because
// this sibling file's two guard describes below both call it; each returned
// restorer is idempotent, so an extra call cannot release someone else's hold.
// This is a SEPARATE, file-scoped ref count from tests/commands.test.cjs's own
// copy — the two files never share module state.
let _gitConfigIsolation = null;

function isolateGlobalGitConfig() {
  if (_gitConfigIsolation) {
    _gitConfigIsolation.refs += 1;
  } else {
    const dir = createTempDir('gsd-3901-gitconfig-');
    const file = path.join(dir, 'global.gitconfig');
    fs.writeFileSync(file, '');
    const cleanupOnExit = () => cleanup(dir);
    _gitConfigIsolation = {
      dir,
      file,
      prev: process.env.GIT_CONFIG_GLOBAL,
      refs: 1,
      cleanupOnExit,
    };
    process.once('exit', cleanupOnExit);
    process.env.GIT_CONFIG_GLOBAL = file;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (!_gitConfigIsolation) return;
    _gitConfigIsolation.refs -= 1;
    if (_gitConfigIsolation.refs > 0) return;
    const { prev, dir, cleanupOnExit } = _gitConfigIsolation;
    _gitConfigIsolation = null;
    if (prev === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = prev;
    cleanup(dir);
    process.removeListener('exit', cleanupOnExit);
  };
}

describe('commit-docs-guard hook script (#3588 A1-A5)', () => {
  const { createTempGitProject } = require('./helpers.cjs');
  const REPO_ROOT = path.join(__dirname, '..');
  let tmpDir;
  let hookPath;

  // #3901: see isolateGlobalGitConfig — shared by this sibling's two guard suites.
  const restoreGitConfig = isolateGlobalGitConfig();
  after(restoreGitConfig);

  beforeEach(() => {
    tmpDir = createTempGitProject();
    const enableResult = runGsdTools('commit-docs-guard enable --raw', tmpDir);
    assert.ok(enableResult.success, `enable failed: ${enableResult.error}`);
    hookPath = path.join(tmpDir, '.git', 'hooks', 'pre-commit');
  });

  test('#3901: the suite isolates children from the host git config (global core.hooksPath)', () => {
    // The developer-machine scenario this suite must survive: a hostile
    // ~/.gitconfig with core.hooksPath set. The before() hook pins
    // GIT_CONFIG_GLOBAL to an empty file; this pins the seam is actually
    // armed and reaching children — a child git sees NO hooksPath from the
    // host, so the guard never refuses and the 18 tests never fail. (A child
    // given an explicitly hostile GIT_CONFIG_GLOBAL still refuses — that is
    // the guard being correct, and it is covered where the refusal is
    // asserted.)
    assert.ok(
      process.env.GIT_CONFIG_GLOBAL && fs.existsSync(process.env.GIT_CONFIG_GLOBAL),
      'the isolation file is armed for this suite',
    );
    assert.equal(fs.readFileSync(process.env.GIT_CONFIG_GLOBAL, 'utf-8'), '',
      'the isolation file is empty — children inherit no host config');
    const { spawnSync } = require('node:child_process');
    const probe = spawnSync('git', ['config', '--get', 'core.hooksPath'], {
      cwd: tmpDir,
      encoding: 'utf-8',
      timeout: GIT_TIMEOUT_MS,
    });
    assert.notEqual(probe.status, 0, `a child git must not see a host core.hooksPath; got: ${probe.stdout}`);
    assert.ok(fs.existsSync(hookPath), 'the beforeEach enable installed the hook at the repo-local default path');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('A3: hook file is executable after enable', () => {
    if (process.platform === 'win32') return; // exec bit is not the Windows-relevant assertion
    const mode = fs.statSync(hookPath).mode;
    assert.ok((mode & 0o111) !== 0, 'pre-commit hook must carry the executable bit');
  });

  test('A4: hook exits zero when the guard allows', () => {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'config.json'), JSON.stringify({ commit_docs: true }));
    const result = runHook(hookPath, [], {
      interpreter: 'bash',
      cwd: tmpDir,
      env: { ...process.env, ...TEST_ENV_BASE, RUNTIME_DIR: REPO_ROOT },
    });
    assert.strictEqual(result.exitCode, 0, `stdout=${result.stdout} stderr=${result.stderr}`);
  });

  test('A5: hook exits non-zero and names the staged files when the guard blocks', () => {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'config.json'), JSON.stringify({ commit_docs: false }));
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), '# State');
    gitOrThrow(['add', '.planning/STATE.md'], { cwd: tmpDir });
    const result = runHook(hookPath, [], {
      interpreter: 'bash',
      cwd: tmpDir,
      env: { ...process.env, ...TEST_ENV_BASE, RUNTIME_DIR: REPO_ROOT },
    });
    assert.notStrictEqual(result.exitCode, 0, 'hook must exit non-zero when the guard blocks');
    assert.ok(result.stderr.includes('.planning/STATE.md'), result.stderr);
  });
});

describe('commit-docs-guard enable/disable (#3588 B1-B15)', () => {
  const { createTempGitProject } = require('./helpers.cjs');
  let tmpDir;

  // #3901: this suite also runs `enable` against fresh repos — the same
  // hostile-global exposure as the A suite (review finding).
  const restoreGitConfigB = isolateGlobalGitConfig();
  after(restoreGitConfigB);

  afterEach(() => {
    if (tmpDir) cleanup(tmpDir);
    tmpDir = undefined;
  });

  test('B1: enable writes an executable hook and reports success', () => {
    tmpDir = createTempGitProject();
    const result = runGsdTools('commit-docs-guard enable --raw', tmpDir);
    assert.ok(result.success, result.error);
    const hookPath = path.join(tmpDir, '.git', 'hooks', 'pre-commit');
    assert.ok(fs.existsSync(hookPath));
    if (process.platform !== 'win32') {
      assert.ok((fs.statSync(hookPath).mode & 0o111) !== 0);
    }
  });

  test('B2: enable refuses to clobber an existing foreign pre-commit hook', () => {
    tmpDir = createTempGitProject();
    const hookPath = path.join(tmpDir, '.git', 'hooks', 'pre-commit');
    const foreignContent = '#!/bin/sh\necho foreign\n';
    fs.writeFileSync(hookPath, foreignContent);
    fs.chmodSync(hookPath, 0o755);
    const result = runGsdTools('commit-docs-guard enable --raw', tmpDir);
    assert.ok(!result.success, 'enable must refuse to overwrite a foreign hook');
    assert.ok(result.error.includes(hookPath), result.error);
    assert.strictEqual(fs.readFileSync(hookPath, 'utf8'), foreignContent, 'foreign hook must be byte-unchanged');
  });

  test('B5: disable refuses to remove a foreign hook', () => {
    tmpDir = createTempGitProject();
    const hookPath = path.join(tmpDir, '.git', 'hooks', 'pre-commit');
    const foreignContent = '#!/bin/sh\necho foreign\n';
    fs.writeFileSync(hookPath, foreignContent);
    fs.chmodSync(hookPath, 0o755);
    const result = runGsdTools('commit-docs-guard disable --raw', tmpDir);
    assert.ok(!result.success, 'disable must refuse to remove a foreign hook');
    assert.strictEqual(fs.readFileSync(hookPath, 'utf8'), foreignContent, 'foreign hook must be byte-unchanged');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// pr-subrepo — regressions (#666) + workflow source invariants
// ─────────────────────────────────────────────────────────────────────────────

describe('pr-subrepo', () => {
  function initPrSubrepo(dir) {
    fs.mkdirSync(dir, { recursive: true });
    gitOrThrow(['init'], { cwd: dir });
    gitOrThrow(['config', 'user.email', 'test@example.com'], { cwd: dir });
    gitOrThrow(['config', 'user.name', 'Test'], { cwd: dir });
    fs.writeFileSync(path.join(dir, '.gitkeep'), '');
    fs.writeFileSync(path.join(dir, 'feature.js'), '// initial\n');
    fs.writeFileSync(path.join(dir, 'a.js'), '// initial\n');
    fs.writeFileSync(path.join(dir, 'b.js'), '// initial\n');
    gitOrThrow(['add', '.gitkeep', 'feature.js', 'a.js', 'b.js'], { cwd: dir });
    gitOrThrow(['commit', '-m', 'chore: initial commit'], { cwd: dir });
  }

  function wirePrSubrepoRemote(repoDir, bareDir) {
    fs.mkdirSync(bareDir, { recursive: true });
    gitOrThrow(['init', '--bare'], { cwd: bareDir });
    gitOrThrow(['remote', 'add', 'origin', bareDir], { cwd: repoDir });
    const branch = gitOrThrow(['branch', '--show-current'], { cwd: repoDir }).trim();
    gitOrThrow(['push', 'origin', branch], { cwd: repoDir });
  }

  function writePrSubrepoConfig(dir, obj) {
    const planningDir = path.join(dir, '.planning');
    fs.mkdirSync(planningDir, { recursive: true });
    fs.writeFileSync(path.join(planningDir, 'config.json'), JSON.stringify(obj, null, 2));
  }

  describe('regressions (#666 — cmdPrSubrepo seam)', () => {
    let rootDir;
    let subDir;
    let bareDir;

    beforeEach(() => {
      rootDir = createTempDir('gsd-666-root-');
      subDir  = path.join(rootDir, 'backend');
      bareDir = path.join(rootDir, '_bare-backend.git');
      writePrSubrepoConfig(rootDir, { planning: { sub_repos: ['backend'] } });
      initPrSubrepo(subDir);
      wirePrSubrepoRemote(subDir, bareDir);
    });

    afterEach(() => {
      cleanup(rootDir);
    });

    test('pr-subrepo push failure: branch+commit survive when push is rejected (no data loss)', () => {
      // Reproduce the data-loss scenario flagged in review: a rejecting remote must leave
      // the local branch+commit intact so the user can retry git push manually.
      const branch = 'fix-666-push-fail-pr';

      // Wire a bare remote with a pre-receive hook that rejects all pushes.
      const rejectingBare = path.join(rootDir, '_rejecting-bare.git');
      fs.mkdirSync(rejectingBare, { recursive: true });
      gitOrThrow(['init', '--bare'], { cwd: rejectingBare });
      const hookPath = path.join(rejectingBare, 'hooks', 'pre-receive');
      fs.writeFileSync(hookPath, '#!/bin/sh\nexit 1\n');
      fs.chmodSync(hookPath, 0o755);

      // Point origin at the rejecting bare (overwrite the working one wired in beforeEach).
      gitOrThrow(['remote', 'set-url', 'origin', rejectingBare], { cwd: subDir });

      fs.writeFileSync(path.join(subDir, 'feature.js'), 'IMPORTANT USER WORK\n');

      const res = runGsdTools(
        ['query', 'pr-subrepo', 'fix(backend): push-fail test',
         '--repo', 'backend', '--branch', branch],
        rootDir
      );

      // Command must fail because push was rejected.
      assert.ok(!res.success, `Expected failure on rejected push, got success: ${res.output}`);

      // The local branch must still exist — work must not be lost.
      const branches = gitOrThrow(['branch', '--list', branch], { cwd: subDir });
      assert.ok(branches.trim().length > 0, `Branch ${branch} was deleted after push failure — user work lost`);

      // The commit on that branch must contain the user's changes.
      const log = gitOrThrow(['log', branch, '--oneline', '-1'], { cwd: subDir });
      assert.ok(log.trim().length > 0, `No commit on ${branch} — staged work was lost`);
    });
  });

  describe('workflow source invariants (#666 — pr-branch.md)', () => {
    // allow-test-rule: source-text-is-the-product see #666
    // pr-branch.md is a workflow file whose deployed text IS the runtime contract.
    const workflowPath = path.resolve(__dirname, '..', 'gsd-core', 'workflows', 'pr-branch.md');
    let wfContent;

    test('dirty-scan rejects traversal, newline, and symlink entries before invoking git (security)', () => {
      // Extracts and executes the ACTUAL node -e script shipped in pr-branch.md — not a
      // mirror — so this test fails if the real script regresses, not just a copy of it.
      wfContent = wfContent || fs.readFileSync(workflowPath, 'utf-8');
      const match = wfContent.match(/node -e "([\s\S]*?)"\s+"\$SUB_REPOS_JSON" "\$ROOT" "\$DIRTY_FILE"/);
      assert.ok(match, 'could not extract dirty-scan node script from pr-branch.md');
      const script = match[1];

      // Helper: init a git repo with a TRACKED dirty change. An untracked file would be
      // filtered by the ?? exclusion and the repo would look clean even without the guard,
      // making the assertions vacuous. A tracked modification ensures that WITHOUT the
      // guard the repo WOULD be reported dirty, so the test genuinely fails-first.
      const initDirtyRepo = (dir, file) => {
        gitOrThrow(['init'], { cwd: dir });
        gitOrThrow(['config', 'user.email', 'test@example.com'], { cwd: dir });
        gitOrThrow(['config', 'user.name', 'Test'], { cwd: dir });
        fs.writeFileSync(path.join(dir, file), 'committed\n');
        gitOrThrow(['add', file], { cwd: dir });
        gitOrThrow(['-c', 'commit.gpgsign=false', 'commit', '-m', 'init'], { cwd: dir });
        fs.writeFileSync(path.join(dir, file), 'modified\n');
      };

      const scanRoot = createTempDir('gsd-666-scan-root-');
      const outsideDir = createTempDir('gsd-666-scan-outside-');
      initDirtyRepo(outsideDir, 'secret.txt');

      // Positive control: a legit dirty sub-repo INSIDE the workspace must still be reported,
      // so the test can't pass by a guard that simply rejects everything.
      const backendDir = path.join(scanRoot, 'backend');
      fs.mkdirSync(backendDir, { recursive: true });
      initDirtyRepo(backendDir, 'app.js');

      // Symlink escape: an in-tree name with no ".." and no "/" that points outside root.
      // path.resolve would keep it "inside"; only realpathSync catches it. Symlink
      // creation needs privileges on Windows — skip just this vector if it throws.
      let symlinked = true;
      try { fs.symlinkSync(outsideDir, path.join(scanRoot, 'evil')); } catch { symlinked = false; }

      const traversalEntry = path.relative(scanRoot, outsideDir); // e.g. "../gsd-666-scan-outside-XXXX"
      const newlineEntry = 'good\nbad'; // record-separator injection attempt
      const dirtyFile = path.join(scanRoot, '_dirty');
      const entries = symlinked
        ? ['evil', traversalEntry, newlineEntry, 'backend']
        : [traversalEntry, newlineEntry, 'backend'];
      const subReposJson = JSON.stringify(entries);

      try {
        const scanResult = runNode(['-e', script, subReposJson, scanRoot, dirtyFile]);
        throwIfFailed(scanResult, 'node -e <dirty-scan script from pr-branch.md>');
        const dirty = fs.existsSync(dirtyFile) ? fs.readFileSync(dirtyFile, 'utf-8') : '';
        const lines = dirty.split('\n').filter(Boolean);
        assert.ok(
          !dirty.includes(path.basename(outsideDir)),
          `Path traversal reached git outside the workspace: ${JSON.stringify(dirty)}`
        );
        if (symlinked) {
          assert.ok(
            !lines.includes('evil'),
            `Symlink entry reached git outside the workspace: ${JSON.stringify(dirty)}`
          );
        }
        assert.ok(
          !lines.includes('bad'),
          `Embedded-newline entry injected a spurious record: ${JSON.stringify(dirty)}`
        );
        assert.deepStrictEqual(
          lines, ['backend'],
          `Positive control failed — expected only 'backend', got: ${JSON.stringify(lines)}`
        );
      } finally {
        cleanup(scanRoot);
        cleanup(outsideDir);
      }
    });
  });
});

// ────────────────────────────────────────────────────────────────────────
// Folded from tests/feat-1754-cli-skew-detection.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────

{
  const { checkCliSkew } = require('../gsd-core/bin/lib/cli-skew-check.cjs');

  describe('#1754: checkCliSkew — pure path-comparison skew detection', () => {
    test('PATH-NORMALIZATION: resolved under project root via realpath → no false positive', () => {
      // Even if the resolved path differs in symlink resolution, if it's under the
      // project root, it's not a skew. The caller normalizes paths before calling.
      const warning = checkCliSkew({
        resolvedPath: path.resolve('/home/user/my-project/.claude/gsd-core/bin/gsd-tools.cjs'),
        projectRoot: path.resolve('/home/user/my-project'),
        projectLocalExists: true,
      });
      assert.strictEqual(warning, null, 'No warning when resolved path is under project root (even with realpath normalization)');
    });
  });
}

// ────────────────────────────────────────────────────────────────────────
// Folded from tests/feat-488-effort-sync.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────

{
  function makeTmpDir(prefix) {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  }

  // output() in core.cjs uses fs.writeSync(1, data) — intercept fd=1 writes.
  // Pass raw=false so output() emits JSON (raw=true emits the plain rawValue string).
  function captureOutput(fn) {
    return JSON.parse(captureFdSync(1, fn));
  }

  function makeAgentsDir(tmpDir) {
    const agentsDir = path.join(tmpDir, 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    return agentsDir;
  }

  const AGENT_WITH_EFFORT = `---
name: gsd-planner
description: Plans phases for GSD milestones
effort: medium
---
Body of the agent.
`;

  describe('feat-488: effort sync command', () => {
    test('home-default effort config gap: applies home-level effort when project config has no effort section', () => {
      // The key #488 scenario: user changed ~/.gsd/defaults.json effort settings
      // after install, but the project .planning/config.json has no effort section.
      // cmdEffortSync must pick up the home config (via readGsdEffectiveEffortConfig),
      // not fall back to 'high' (which loadConfig would return).
      //
      // readGsdEffectiveEffortConfig calls os.homedir() directly, and os.homedir()
      // is live (respects process.env.HOME).  We redirect HOME to an isolated
      // tmpHome so the test is hermetic and can assert the real outcome.
      const tmpHome = makeTmpDir('effort-sync-homecfg-');
      const tmpDir = makeTmpDir('effort-sync-project-');
      const agentsDir = makeAgentsDir(tmpDir);
      const agentPath = path.join(agentsDir, 'gsd-planner.md');
      fs.writeFileSync(agentPath, AGENT_WITH_EFFORT); // current: effort: medium

      // Project has .planning/config.json with NO effort section
      const planningDir = path.join(tmpDir, '.planning');
      fs.mkdirSync(planningDir, { recursive: true });
      fs.writeFileSync(path.join(planningDir, 'config.json'), JSON.stringify({ model_profile: 'balanced' }));

      // Home defaults set the heavy tier effort to low. (#3531: a bare home
      // effort.default would no longer reach gsd-planner — the merged tier
      // ladder answers for tiered agents — so the home fixture pins the tier,
      // which is what this test's claim actually exercises: home-level effort
      // applies when the project config has no effort section.)
      const gsdDir = path.join(tmpHome, '.gsd');
      fs.mkdirSync(gsdDir, { recursive: true });
      fs.writeFileSync(path.join(gsdDir, 'defaults.json'), JSON.stringify({ effort: { routing_tier_defaults: { heavy: 'low' } } }));

      // Isolate HOME (and USERPROFILE for Windows parity) so
      // readGsdEffectiveEffortConfig reads our fixture, not the
      // developer's real ~/.gsd/defaults.json.
      const origHome = process.env.HOME;
      const origUserProfile = process.env.USERPROFILE;
      process.env.HOME = tmpHome;
      process.env.USERPROFILE = tmpHome;

      const { cmdEffortSync } = require('../gsd-core/bin/lib/commands.cjs');
      let result;
      try {
        result = captureOutput(() =>
          cmdEffortSync(tmpDir, false, { dryRun: false, configDir: tmpDir, runtime: 'claude' })
        );
      } finally {
        if (origHome === undefined) {
          delete process.env.HOME;
        } else {
          process.env.HOME = origHome;
        }
        if (origUserProfile === undefined) {
          delete process.env.USERPROFILE;
        } else {
          process.env.USERPROFILE = origUserProfile;
        }
      }

      // With home heavy-tier effort 'low' and the agent currently at 'medium',
      // cmdEffortSync must sync exactly 1 agent and set it to 'low'.
      assert.equal(result.synced, 1, 'should sync 1 agent whose effort differs from home default');
      assert.equal(result.changes[0].agent, 'gsd-planner');
      assert.equal(result.changes[0].from, 'medium');
      assert.equal(result.changes[0].to, 'low', 'effort must be updated to the home-default value');
      assert.ok(
        fs.readFileSync(agentPath, 'utf8').includes('effort: low'),
        'agent file must be rewritten with the home-default effort value'
      );

      cleanup(tmpHome);
      cleanup(tmpDir);
    });
  });

  describe('#3243 (ADR-2313 D7): Codex .toml effort sync', () => {
    function syncCodex(tmpDir, dryRun) {
      const { cmdEffortSync } = require('../gsd-core/bin/lib/commands.cjs');
      return captureOutput(() =>
        cmdEffortSync(tmpDir, false, { dryRun, configDir: tmpDir, runtime: 'codex' })
      );
    }

    test('B12 (negative proof): symlinked .toml — skipped, target byte-identical after', (t) => {
      const tmpDir = makeTmpDir('codex-sync-b12-');
      const agentsDir = makeAgentsDir(tmpDir);
      const targetPath = path.join(tmpDir, 'outside-target.toml');
      const targetContent = 'model = "sonnet"\n';
      fs.writeFileSync(targetPath, targetContent);
      const symlinkPath = path.join(agentsDir, 'gsd-linked.toml');
      try {
        fs.symlinkSync(targetPath, symlinkPath, 'file');
      } catch (error) {
        if (error && ['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
          t.skip('symlink creation is not available on this platform');
          cleanup(tmpDir);
          return;
        }
        throw error;
      }

      const result = syncCodex(tmpDir, false);

      assert.equal(result.synced, 0);
      assert.ok(
        !result.changes.some(c => c.agent === 'gsd-linked'),
        'a symlinked agent must never be reported as synced',
      );
      assert.equal(fs.readFileSync(targetPath, 'utf8'), targetContent, 'the symlink target must never be written through');

      cleanup(tmpDir);
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// #3776: query commit --files reports an empty diff as nothing_to_commit
// ─────────────────────────────────────────────────────────────────────────────

describe('#3776: query commit --files reports an empty diff as nothing_to_commit', () => {
  const { createTempGitProject } = require('./helpers.cjs');
  // runGit (never gitOrThrow) for the conflicting merge below — that merge is
  // MEANT to exit non-zero, and the throwing wrapper would fail the fixture.
  const { runGit } = require('./helpers/process-seam.cjs');
  let tmpDir;

  const REJECTING_HOOK = '#!/bin/sh\necho "gate: BACKLOG.md is stale" >&2\nexit 1\n';
  const PASSING_HOOK = '#!/bin/sh\nexit 0\n';

  // Writes .git/hooks/pre-commit. Every arm below drives the real hook, not a
  // stub of it: the defect lives in git's own hook-before-empty-diff ordering,
  // so a faked rejection would not exercise the mechanism under test.
  function installHook(body) {
    const hookPath = path.join(tmpDir, '.git', 'hooks', 'pre-commit');
    fs.writeFileSync(hookPath, body);
    fs.chmodSync(hookPath, 0o755);
  }

  // A tracked, committed, unmodified file — `git add` on it succeeds and
  // contributes no diff. This is the exact shape the guard used to miss.
  function commitFixtureFile(name = 'doc.md', body = 'hello\n') {
    const rel = path.posix.join('.planning', name);
    fs.writeFileSync(path.join(tmpDir, '.planning', name), body);
    gitOrThrow(['add', '--', rel], { cwd: tmpDir });
    gitOrThrow(['commit', '-m', 'fixture: ' + name], { cwd: tmpDir });
    return rel;
  }

  // The command emits its JSON payload on either stream depending on outcome;
  // read whichever carries it rather than assuming success.
  function commitFiles(rel, extra = '') {
    const result = runGsdTools('commit "m"' + extra + ' --files ' + rel, tmpDir);
    const payload = (result.output && result.output.trim()) ? result.output : result.error;
    return JSON.parse(payload);
  }

  beforeEach(() => {
    tmpDir = createTempGitProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // AC1 — the defect. Pre-fix this returned commit_failed + the hook's message.
  test('AC1: empty diff + rejecting pre-commit hook reports nothing_to_commit, not the hook rejection', () => {
    const rel = commitFixtureFile();
    installHook(REJECTING_HOOK);

    const output = commitFiles(rel);
    assert.strictEqual(output.committed, false);
    assert.strictEqual(output.reason, 'nothing_to_commit',
      'an empty-diff --files call must not be reported as a failed commit');
    assert.ok(!output.error,
      'no hook message may be surfaced for a call that had nothing to gate');
  });

  test('AC2: empty diff + passing hook still reports nothing_to_commit', () => {
    const rel = commitFixtureFile();
    installHook(PASSING_HOOK);

    const output = commitFiles(rel);
    assert.strictEqual(output.committed, false);
    assert.strictEqual(output.reason, 'nothing_to_commit');
  });

  // AC3 — the all-missing short-circuit must not regress.
  test('AC3: every named path missing from disk still reports nothing_to_commit', () => {
    const rel = commitFixtureFile();
    fs.unlinkSync(path.join(tmpDir, rel));
    installHook(REJECTING_HOOK);

    const output = commitFiles(rel);
    assert.strictEqual(output.committed, false);
    assert.strictEqual(output.reason, 'nothing_to_commit');
  });

  // AC3, sharp edge: the `stagedPaths.length === 0` short-circuit is
  // load-bearing, not defensive noise. Without it an all-missing call spreads
  // an empty array into the pathspec, and a pathspec-less `git diff HEAD`
  // tests the WHOLE tree — so unrelated work would suppress the guard and turn
  // this arm into a commit of somebody else's changes.
  test('AC3: all named paths missing does not consult unrelated staged work', () => {
    const rel = commitFixtureFile();
    fs.unlinkSync(path.join(tmpDir, rel));
    const unrelated = path.posix.join('.planning', 'unrelated.md');
    fs.writeFileSync(path.join(tmpDir, unrelated), 'staged by the caller\n');
    gitOrThrow(['add', '--', unrelated], { cwd: tmpDir });
    installHook(REJECTING_HOOK);

    const output = commitFiles(rel);
    assert.strictEqual(output.committed, false);
    assert.strictEqual(output.reason, 'nothing_to_commit');

    const staged = gitOrThrow(['diff', '--cached', '--name-only'], { cwd: tmpDir });
    assert.match(staged, /unrelated\.md/,
      "the caller's own staged work must be left in the index, not swept into a commit");
  });

  // AC4 — a genuine rejection must still be reported. The goal is to stop
  // reporting a rejection for a call that never had anything to gate, not to
  // stop reporting rejections.
  test('AC4: a real diff rejected by the hook still reports commit_failed with the hook message', () => {
    const rel = commitFixtureFile();
    fs.writeFileSync(path.join(tmpDir, rel), 'hello\nmodified\n');
    installHook(REJECTING_HOOK);

    const output = commitFiles(rel);
    assert.strictEqual(output.committed, false);
    assert.strictEqual(output.reason, 'commit_failed');
    assert.match(String(output.error), /BACKLOG\.md is stale/,
      "the hook's own message must still reach the caller");
  });

  // AC5 — amending has a different empty-diff meaning; the guard stays exempt.
  test('AC5: --amend remains exempt from the empty-diff guard', () => {
    const rel = commitFixtureFile();
    installHook(REJECTING_HOOK);

    const output = commitFiles(rel, ' --amend');
    assert.strictEqual(output.committed, false);
    assert.strictEqual(output.reason, 'commit_failed',
      '--amend must still reach git, where the hook governs the rewrite');
  });

  // Beyond the brief's ACs: during a merge git refuses a partial commit, so the
  // commit runs WITHOUT the pathspec and the named paths describe nothing about
  // what would land. Deciding "nothing to commit" from them would abandon the
  // merge — which is why the empty-diff probe is gated on !isMergeInProgress.
  // Sets up a conflicted history and leaves the caller mid-sequence. `rel` (the
  // file the commit call names) is never touched by the conflict, so it always
  // contributes no diff of its own — which is what puts these arms on the
  // empty-diff branch under test.
  function conflictedSequence(kind) {
    const shared = path.posix.join('.planning', 'shared.md');
    fs.writeFileSync(path.join(tmpDir, shared), 'base\n');
    gitOrThrow(['add', '--', shared], { cwd: tmpDir });
    gitOrThrow(['commit', '-m', 'shared base'], { cwd: tmpDir });
    const trunk = gitOrThrow(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: tmpDir }).trim();

    if (kind === 'revert') {
      fs.writeFileSync(path.join(tmpDir, shared), 'second\n');
      gitOrThrow(['commit', '-am', 'second'], { cwd: tmpDir });
      fs.writeFileSync(path.join(tmpDir, shared), 'third\n');
      gitOrThrow(['commit', '-am', 'third'], { cwd: tmpDir });
      runGit(['revert', '--no-edit', 'HEAD~1'], { cwd: tmpDir });
    } else {
      gitOrThrow(['checkout', '-b', 'side'], { cwd: tmpDir });
      fs.writeFileSync(path.join(tmpDir, shared), 'side\n');
      gitOrThrow(['commit', '-am', 'side edit'], { cwd: tmpDir });
      gitOrThrow(['checkout', trunk], { cwd: tmpDir });
      fs.writeFileSync(path.join(tmpDir, shared), 'trunk\n');
      gitOrThrow(['commit', '-am', 'trunk edit'], { cwd: tmpDir });
      runGit([kind === 'merge' ? 'merge' : 'cherry-pick', 'side'], { cwd: tmpDir });
    }
    fs.writeFileSync(path.join(tmpDir, shared), 'resolved\n');
    gitOrThrow(['add', '--', shared], { cwd: tmpDir });
  }

  // THREE ARMS PINNING WHY THE PROBE ASKS GIT RATHER THAN RECONSTRUCTING ITS
  // ANSWER. Each one reds if the dry run is replaced by a
  // `hash-object` vs `HEAD:<path>` blob comparison, and each is a silent drop
  // of content the caller named — the exact class this whole guard is careful
  // about.

  // A mode-only change leaves the blob identical, so a content comparison sees
  // nothing — while `git commit -- <path>` records the new mode.
  test('a mode-only change to an assume-unchanged path is still committed', (t) => {
    const rel = commitFixtureFile('exec.md');
    // Windows, and any checkout with `core.filemode=false`, cannot represent
    // the bit — `chmodSync` would then be a no-op and this arm would pass while
    // pinning nothing. Assert the precondition and skip loudly instead.
    gitOrThrow(['config', 'core.filemode', 'true'], { cwd: tmpDir });
    gitOrThrow(['update-index', '--assume-unchanged', '--', rel], { cwd: tmpDir });
    fs.chmodSync(path.join(tmpDir, rel), 0o755);
    if (!/^100755 /.test(gitOrThrow(['ls-files', '-s', '--', rel], { cwd: tmpDir }))
      && (fs.statSync(path.join(tmpDir, rel)).mode & 0o111) === 0) {
      t.skip('filesystem cannot represent the executable bit — nothing to pin here');
      return;
    }

    assert.strictEqual(commitFiles(rel).committed, true,
      'the mode moved and git would record it, so the guard must not report nothing_to_commit');
    assert.match(
      gitOrThrow(['ls-tree', 'HEAD', '--', rel], { cwd: tmpDir }), /^100755 /,
      'and the recorded mode must actually be the executable one');
  });

  // git refuses a partial commit during a cherry-pick exactly as it does during
  // a merge, so the guard must stay out of the way there too — this arm pins
  // that the pre-fix outcome is preserved rather than turned into a silent
  // no-op. Driven, not assumed: the three sequencer states disagree.
  test('a cherry-pick in progress keeps its pre-existing outcome', () => {
    const rel = commitFixtureFile();
    conflictedSequence('cherry-pick');
    assert.ok(fs.existsSync(path.join(tmpDir, '.git', 'CHERRY_PICK_HEAD')),
      'fixture must leave a cherry-pick in progress');
    installHook(REJECTING_HOOK);

    const output = commitFiles(rel);
    assert.strictEqual(output.committed, false);
    assert.strictEqual(output.reason, 'commit_failed',
      'git refuses the partial commit here; that must not become a silent nothing_to_commit');
    assert.match(String(output.error), /partial commit/,
      "git's own refusal must reach the caller");
  });

  // REVERT_HEAD is deliberately NOT in the refusal set: a revert permits partial
  // commits, so the fix must still apply there. Including it would suppress the
  // fix during a revert and reintroduce the misreport.
  test('a revert in progress still reports nothing_to_commit, not the hook rejection', () => {
    const rel = commitFixtureFile();
    conflictedSequence('revert');
    assert.ok(fs.existsSync(path.join(tmpDir, '.git', 'REVERT_HEAD')),
      'fixture must leave a revert in progress');
    installHook(REJECTING_HOOK);

    const output = commitFiles(rel);
    assert.strictEqual(output.committed, false);
    assert.strictEqual(output.reason, 'nothing_to_commit',
      'a revert permits partial commits, so the empty-diff guard must still apply');
  });
});
