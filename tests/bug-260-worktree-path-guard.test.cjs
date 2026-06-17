/**
 * Regression tests for bug #260 — gsd-worktree-path-guard.js
 *
 * Executor agents spawned with isolation="worktree" sometimes issue Edit/Write
 * calls with absolute paths rooted at the MAIN repository instead of the
 * worktree. The prose guard in gsd-executor.md step 0b is skipped under load,
 * so we enforce the constraint at the tooling layer with a PreToolUse hook.
 *
 * This file verifies all guard behaviours:
 *   1. No-op in the main repo (.git is a directory)
 *   2. Relative path always passes
 *   3. Non-Edit/Write tools always pass
 *   4. Absolute path inside worktree root passes
 *   5. Absolute path outside worktree root is BLOCKED (exit 2)
 *   6. Sibling path that merely shares a prefix is BLOCKED (/ boundary check)
 *   7. install.js has an fs.existsSync guard for gsd-worktree-path-guard.js
 */

'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const { cleanup } = require('./helpers.cjs');

const HOOK_PATH = path.join(__dirname, '..', 'hooks', 'gsd-worktree-path-guard.js');
const INSTALL_SRC = path.join(__dirname, '..', 'bin', 'install.js');
// ADR-857 phase 5f-1b: settings-json hook registration moved to runtime-hooks-surface.cts.
const HOOKS_SURFACE_SRC = path.join(__dirname, '..', 'src', 'runtime-hooks-surface.cts');

/**
 * Resolve symlinks in a path so that we compare the same canonical form
 * that `git rev-parse --show-toplevel` returns. On macOS /tmp is a symlink
 * to /private/tmp, which causes path prefix checks to fail without this.
 */
function realp(p) {
  try { return fs.realpathSync(p); } catch { return p; }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * Create a plain git repo (main repo — .git is a directory).
 */
function makeMainRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-260-main-'));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test User']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(dir, 'README.md'), '# test\n');
  git(dir, ['add', 'README.md']);
  git(dir, ['commit', '-q', '-m', 'chore: init']);
  return dir;
}

/**
 * Create a worktree off mainRepo and return its path.
 * In the worktree, .git is a FILE (the gitdir pointer).
 * @param {string} mainRepo - path to the main repo
 * @param {string} [branchName] - branch name to use (default: 'worktree-agent-test')
 */
function makeWorktree(mainRepo, branchName) {
  const branch = branchName || 'worktree-agent-test';
  const wtDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-260-wt-'));
  fs.rmdirSync(wtDir); // git worktree add creates the dir itself
  git(mainRepo, ['worktree', 'add', '-q', '-b', branch, wtDir]);
  return wtDir;
}

/**
 * Run the hook with a given payload, returning the spawnSync result.
 */
function runHook(cwd, payload) {
  return spawnSync(process.execPath, [HOOK_PATH], {
    cwd,
    input: JSON.stringify(payload),
    encoding: 'utf8',
  });
}

// ---------------------------------------------------------------------------
// Fixture lifecycle
// ---------------------------------------------------------------------------

let mainRepo;
let worktreeDir;

before(() => {
  mainRepo = realp(makeMainRepo());
  worktreeDir = realp(makeWorktree(mainRepo));
});

after(() => {
  // Remove worktree registration before deleting the directory
  try { git(mainRepo, ['worktree', 'remove', '--force', worktreeDir]); } catch { /* ignore */ }
  cleanup(mainRepo);
  cleanup(worktreeDir);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('bug #260: gsd-worktree-path-guard.js', () => {

  // 1. No-op in main repo
  describe('no-op in main repo', () => {
    test('Edit call in main repo (.git is a directory) exits 0', () => {
      const payload = {
        cwd: mainRepo,
        tool_name: 'Edit',
        tool_input: { file_path: path.join(mainRepo, 'src', 'foo.ts') },
      };
      const result = runHook(mainRepo, payload);
      assert.strictEqual(result.status, 0, `Expected exit 0 in main repo, got ${result.status}. stderr: ${result.stderr}`);
      assert.strictEqual(result.stdout, '', 'Expected no stdout in main repo no-op');
    });

    test('Write call in main repo exits 0', () => {
      const payload = {
        cwd: mainRepo,
        tool_name: 'Write',
        tool_input: { file_path: path.join(mainRepo, 'out.txt') },
      };
      const result = runHook(mainRepo, payload);
      assert.strictEqual(result.status, 0);
      assert.strictEqual(result.stdout, '');
    });
  });

  // 2. Relative path always passes
  describe('relative path', () => {
    test('Edit with relative file_path exits 0 even in worktree', () => {
      const payload = {
        cwd: worktreeDir,
        tool_name: 'Edit',
        tool_input: { file_path: 'src/foo.ts' },
      };
      const result = runHook(worktreeDir, payload);
      assert.strictEqual(result.status, 0, `Relative path should always pass. stderr: ${result.stderr}`);
      assert.strictEqual(result.stdout, '');
    });

    test('Write with relative file_path exits 0 in worktree', () => {
      const payload = {
        cwd: worktreeDir,
        tool_name: 'Write',
        tool_input: { file_path: 'dist/bundle.js' },
      };
      const result = runHook(worktreeDir, payload);
      assert.strictEqual(result.status, 0);
      assert.strictEqual(result.stdout, '');
    });
  });

  // 3. Non-Edit/Write tools always pass
  describe('non-Edit/Write tools', () => {
    test('Bash tool exits 0', () => {
      const payload = {
        cwd: worktreeDir,
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
      };
      const result = runHook(worktreeDir, payload);
      assert.strictEqual(result.status, 0);
    });

    test('Read tool exits 0', () => {
      const payload = {
        cwd: worktreeDir,
        tool_name: 'Read',
        tool_input: { file_path: path.join(mainRepo, 'README.md') },
      };
      const result = runHook(worktreeDir, payload);
      assert.strictEqual(result.status, 0);
    });

    test('Grep tool exits 0', () => {
      const payload = {
        cwd: worktreeDir,
        tool_name: 'Grep',
        tool_input: { pattern: 'foo', path: mainRepo },
      };
      const result = runHook(worktreeDir, payload);
      assert.strictEqual(result.status, 0);
    });
  });

  // 4. Absolute path inside worktree passes
  describe('path inside worktree', () => {
    test('Edit with absolute path inside worktree root exits 0', () => {
      const payload = {
        cwd: worktreeDir,
        tool_name: 'Edit',
        tool_input: { file_path: path.join(worktreeDir, 'src', 'foo.ts') },
      };
      const result = runHook(worktreeDir, payload);
      assert.strictEqual(result.status, 0, `Path inside worktree should pass. stderr: ${result.stderr}`);
      assert.strictEqual(result.stdout, '');
    });

    test('Edit targeting exactly the worktree root exits 0', () => {
      const payload = {
        cwd: worktreeDir,
        tool_name: 'Edit',
        tool_input: { file_path: worktreeDir },
      };
      const result = runHook(worktreeDir, payload);
      assert.strictEqual(result.status, 0);
    });
  });

  // 5. Absolute path outside worktree is BLOCKED
  describe('path outside worktree is blocked', () => {
    test('Edit targeting main repo root exits 2 with block decision', () => {
      const payload = {
        cwd: worktreeDir,
        tool_name: 'Edit',
        tool_input: { file_path: path.join(mainRepo, 'src', 'index.ts') },
      };
      const result = runHook(worktreeDir, payload);
      assert.strictEqual(result.status, 2, `Expected exit 2 (block), got ${result.status}. stderr: ${result.stderr}`);
      let parsed;
      assert.doesNotThrow(() => { parsed = JSON.parse(result.stdout); }, 'stdout must be valid JSON');
      assert.strictEqual(parsed.decision, 'block', 'Expected decision:"block" in output');
    });

    test('Write targeting main repo root exits 2 with block decision', () => {
      const payload = {
        cwd: worktreeDir,
        tool_name: 'Write',
        tool_input: { file_path: path.join(mainRepo, 'out.txt') },
      };
      const result = runHook(worktreeDir, payload);
      assert.strictEqual(result.status, 2);
      const parsed = JSON.parse(result.stdout);
      assert.strictEqual(parsed.decision, 'block');
    });

    test('block output includes the offending path in reason', () => {
      const offendingPath = path.join(mainRepo, 'src', 'leak.ts');
      const payload = {
        cwd: worktreeDir,
        tool_name: 'Edit',
        tool_input: { file_path: offendingPath },
      };
      const result = runHook(worktreeDir, payload);
      assert.strictEqual(result.status, 2);
      const parsed = JSON.parse(result.stdout);
      assert.ok(
        parsed.reason && parsed.reason.includes(offendingPath),
        `block reason should include the offending path. Got: ${parsed.reason}`
      );
    });
  });

  // 6. Sibling directory path is BLOCKED (validates the '/' boundary check AND prefix-overlap)
  describe('sibling path is blocked', () => {
    test('path that shares prefix with worktree root but is a sibling exits 2', () => {
      // This test exercises BOTH the prefix-overlap boundary check AND the different-git-root block:
      //   worktree  = <base>/wt
      //   sibling   = <base>/wt-sibling   ← shares "wt" prefix with the worktree root
      //   target    = <base>/wt-sibling/file.ts
      //
      // A naive startsWith(wtRoot) check would wrongly classify "<base>/wt-sibling/..." as inside
      // the worktree (it doesn't include the '/' boundary). The hook resolves the sibling's git
      // toplevel (a different repo) so the different-git-root block fires regardless.
      // (#1342: paths outside all git repos now fail open; only different-git-root blocks.)
      const base = realp(fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-260-sib-base-')));
      const wtDir = path.join(base, 'wt');
      const siblingRepoDir = path.join(base, 'wt-sibling');
      // We need a genuine linked worktree at <base>/wt and a separate git repo at <base>/wt-sibling.
      // Create a fresh main repo to host this worktree (the fixture worktree is already allocated).
      const sibMainRepo = realp(makeMainRepo());
      try {
        fs.mkdirSync(base, { recursive: true });
        // Create linked worktree at <base>/wt (using sibMainRepo as its host).
        git(sibMainRepo, ['worktree', 'add', '-q', '-b', 'worktree-agent-sib-test', wtDir]);
        // Create a separate git repo at <base>/wt-sibling (shares "wt" prefix).
        fs.mkdirSync(siblingRepoDir, { recursive: true });
        git(siblingRepoDir, ['init', '-q']);
        git(siblingRepoDir, ['config', 'user.email', 'test@example.com']);
        git(siblingRepoDir, ['config', 'user.name', 'Test User']);
        git(siblingRepoDir, ['config', 'commit.gpgsign', 'false']);
        fs.writeFileSync(path.join(siblingRepoDir, 'README.md'), '# sibling\n');
        git(siblingRepoDir, ['add', 'README.md']);
        git(siblingRepoDir, ['commit', '-q', '-m', 'chore: sibling init']);

        // Confirm prefix-overlap: siblingRepoDir starts with wtDir (without trailing sep).
        assert.ok(
          siblingRepoDir.startsWith(wtDir),
          `Sibling "${siblingRepoDir}" must share a string prefix with worktree "${wtDir}" for this test to be meaningful`
        );
        // Confirm they are genuinely distinct (different toplevel).
        assert.notStrictEqual(
          realp(siblingRepoDir), realp(wtDir),
          'sibling and worktree must be different directories'
        );

        const siblingPath = path.join(realp(siblingRepoDir), 'file.ts');
        const payload = {
          cwd: realp(wtDir),
          tool_name: 'Edit',
          tool_input: { file_path: siblingPath },
        };
        const result = runHook(realp(wtDir), payload);
        assert.strictEqual(result.status, 2,
          `Path inside a prefix-sibling git repo "${siblingPath}" must be blocked (exit 2), got ${result.status}. ` +
          `This validates both the prefix-overlap boundary and the different-git-root block. stderr: ${result.stderr}`
        );
        const parsed = JSON.parse(result.stdout);
        assert.strictEqual(parsed.decision, 'block');
      } finally {
        try { git(sibMainRepo, ['worktree', 'remove', '--force', wtDir]); } catch { /* ignore */ }
        cleanup(sibMainRepo);
        cleanup(base);
      }
    });
  });

  // 7. Adversarial: subdirectory cwd still guards correctly (Codex finding #2)
  describe('subdirectory cwd', () => {
    test('hook fires when cwd is a subdirectory of the worktree, not just its root', () => {
      // The orchestrator may set cwd to a subdirectory. The hook must still
      // detect the worktree context via git rev-parse --git-dir and block.
      const subDir = path.join(worktreeDir, 'src');
      fs.mkdirSync(subDir, { recursive: true });
      const payload = {
        cwd: subDir,
        tool_name: 'Edit',
        tool_input: { file_path: path.join(mainRepo, 'src', 'index.ts') },
      };
      const result = runHook(subDir, payload);
      assert.strictEqual(result.status, 2,
        `Hook must block even when cwd is a subdirectory of the worktree. ` +
        `Got exit ${result.status}. stderr: ${result.stderr}`
      );
      const parsed = JSON.parse(result.stdout);
      assert.strictEqual(parsed.decision, 'block');
    });

    test('path inside worktree passes even when cwd is a subdirectory', () => {
      const subDir = path.join(worktreeDir, 'src');
      fs.mkdirSync(subDir, { recursive: true });
      const payload = {
        cwd: subDir,
        tool_name: 'Edit',
        tool_input: { file_path: path.join(worktreeDir, 'src', 'foo.ts') },
      };
      const result = runHook(subDir, payload);
      assert.strictEqual(result.status, 0,
        `Absolute path inside worktree should pass regardless of cwd. ` +
        `Got exit ${result.status}. stderr: ${result.stderr}`
      );
    });
  });

  // 8. Adversarial: `..` traversal is normalised before the containment check (Codex finding #1)
  describe('dot-dot traversal is blocked', () => {
    test('path with .. that escapes the worktree is blocked', () => {
      // Construct the traversal target inside a SEPARATE git repo that is
      // guaranteed to be outside the worktree on every platform (no symlink
      // ambiguity).  The hook finds the external dir's git toplevel (a different
      // repo → different-git-root block).
      // (#1342: paths outside all git repos now fail open; only different-git-root blocks,
      // so externalDir must be inside a real different git repo to exercise the block.)
      const externalDir = realp(makeMainRepo());
      try {
        // Sanity: the external directory must not be inside the worktree.
        assert.ok(
          !externalDir.startsWith(worktreeDir + path.sep) && externalDir !== worktreeDir,
          `externalDir "${externalDir}" must be outside worktreeDir "${worktreeDir}"`
        );

        // Build a traversal path that uses ../ segments to climb out of the
        // worktree and into externalDir.  path.resolve() will normalise it to
        // externalDir/file.ts, which is outside the worktree by construction.
        // We compute the number of segments needed to reach the filesystem root
        // from worktreeDir so the traversal always lands at the right level
        // regardless of how deep the worktree path is.
        // Build a file_path containing literal `..` segments that climb out of the
        // worktree into externalDir. path.relative() yields a ..-laden relative path
        // between two same-drive absolute paths (both live under os.tmpdir()); we
        // re-anchor it at worktreeDir via STRING CONCAT (NOT path.join, which would
        // normalise the `..` away) so the hook's path.resolve() must collapse it.
        // Windows-safe: avoids the drive-letter doubling that
        // path.join(worktreeDir, '..', absolutePath) produces on win32 (#1342).
        const externalTarget = path.join(externalDir, 'file.ts');
        const traversalPath = worktreeDir + path.sep + path.relative(worktreeDir, externalTarget);

        // Confirm the resolved path is truly outside the worktree (test integrity guard).
        const resolved = path.resolve(traversalPath);
        assert.ok(
          !resolved.startsWith(worktreeDir + path.sep) && resolved !== worktreeDir,
          `Traversal resolved to "${resolved}" which is still inside worktreeDir "${worktreeDir}". ` +
          `This means the test itself is broken, not a production bug.`
        );

        const payload = {
          cwd: worktreeDir,
          tool_name: 'Edit',
          tool_input: { file_path: traversalPath },
        };
        const result = runHook(worktreeDir, payload);
        assert.strictEqual(result.status, 2,
          `Traversal path "${traversalPath}" resolves to "${resolved}" which is outside the worktree. ` +
          `Must be blocked (exit 2). Got exit ${result.status}. stderr: ${result.stderr}`
        );
        const parsed = JSON.parse(result.stdout);
        assert.strictEqual(parsed.decision, 'block',
          `Expected decision:"block", got: ${JSON.stringify(parsed)}`
        );
      } finally {
        cleanup(externalDir);
      }
    });
  });

  // 9. MultiEdit is also guarded (Codex finding #5)
  describe('MultiEdit tool is guarded', () => {
    test('MultiEdit with outside absolute path is blocked', () => {
      const payload = {
        cwd: worktreeDir,
        tool_name: 'MultiEdit',
        tool_input: { file_path: path.join(mainRepo, 'src', 'index.ts') },
      };
      const result = runHook(worktreeDir, payload);
      assert.strictEqual(result.status, 2,
        `MultiEdit targeting outside path must be blocked. Got ${result.status}. stderr: ${result.stderr}`
      );
      const parsed = JSON.parse(result.stdout);
      assert.strictEqual(parsed.decision, 'block');
    });

    test('MultiEdit with inside absolute path passes', () => {
      const payload = {
        cwd: worktreeDir,
        tool_name: 'MultiEdit',
        tool_input: { file_path: path.join(worktreeDir, 'src', 'foo.ts') },
      };
      const result = runHook(worktreeDir, payload);
      assert.strictEqual(result.status, 0,
        `MultiEdit inside worktree should pass. Got ${result.status}. stderr: ${result.stderr}`
      );
    });
  });

});

// ---------------------------------------------------------------------------
// #1342 — GSD-activity gate + fail-open for no-repo targets
// ---------------------------------------------------------------------------

describe('#1342 — GSD-activity gate + fail-open for no-repo targets', () => {
  // Fixtures: one non-agent linked worktree (plain user branch) + one agent worktree
  let mainRepo1342;
  let nonAgentWorktree;   // on branch 'feature-x' — non-GSD
  let agentWorktree;       // on branch 'worktree-agent-foo' — GSD-managed

  before(() => {
    mainRepo1342 = realp(makeMainRepo());
    nonAgentWorktree = realp(makeWorktree(mainRepo1342, 'feature-x'));
    agentWorktree    = realp(makeWorktree(mainRepo1342, 'worktree-agent-foo'));
  });

  after(() => {
    try { git(mainRepo1342, ['worktree', 'remove', '--force', nonAgentWorktree]); } catch { /* ignore */ }
    try { git(mainRepo1342, ['worktree', 'remove', '--force', agentWorktree]); } catch { /* ignore */ }
    cleanup(mainRepo1342);
    cleanup(nonAgentWorktree);
    cleanup(agentWorktree);
  });

  // Test 1 — reporter repro: non-agent worktree writing outside all git repos → exit 0
  test('(1) non-agent linked worktree: Write to a path outside all git repos exits 0 (no block)', () => {
    // Simulates Claude Code plan-mode writing ~/.claude/plans/<slug>.md from a
    // manually-created linked worktree that is NOT on a worktree-agent-* branch.
    const plansDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-1342-plans-'));
    try {
      const targetPath = path.join(plansDir, 'my-plan.md');
      const payload = {
        cwd: nonAgentWorktree,
        tool_name: 'Write',
        tool_input: { file_path: targetPath },
      };
      const result = runHook(nonAgentWorktree, payload);
      assert.strictEqual(result.status, 0,
        `Non-agent linked worktree writing outside git repos must exit 0 (reporter repro). ` +
        `Got exit ${result.status}. stderr: ${result.stderr}`
      );
      assert.strictEqual(result.stdout, '', 'Expected no block output');
    } finally {
      cleanup(plansDir);
    }
  });

  // Test 2 — non-agent linked worktree: Edit targeting MAIN repo root → exit 0 (gate no-op)
  test('(2) non-agent linked worktree: Edit targeting main repo root exits 0 (gate no-op, not #260 block)', () => {
    const payload = {
      cwd: nonAgentWorktree,
      tool_name: 'Edit',
      tool_input: { file_path: path.join(mainRepo1342, 'src', 'index.ts') },
    };
    const result = runHook(nonAgentWorktree, payload);
    assert.strictEqual(result.status, 0,
      `Non-agent linked worktree must exit 0 (GSD-activity gate fires before #260 check). ` +
      `Got exit ${result.status}. stderr: ${result.stderr}`
    );
    assert.strictEqual(result.stdout, '', 'Expected no block output');
  });

  // Test 3 — GSD-managed worktree (worktree-agent-foo): Edit targeting main repo root → exit 2 (block)
  test('(3) GSD-managed worktree: Edit targeting main repo root exits 2 with block decision', () => {
    const payload = {
      cwd: agentWorktree,
      tool_name: 'Edit',
      tool_input: { file_path: path.join(mainRepo1342, 'src', 'index.ts') },
    };
    const result = runHook(agentWorktree, payload);
    assert.strictEqual(result.status, 2,
      `GSD-managed worktree targeting main repo root must be blocked (exit 2). ` +
      `Got exit ${result.status}. stderr: ${result.stderr}`
    );
    let parsed;
    assert.doesNotThrow(() => { parsed = JSON.parse(result.stdout); }, 'stdout must be valid JSON');
    assert.strictEqual(parsed.decision, 'block', 'Expected decision:"block" in output');
  });

  // Test 4 — GSD-managed worktree: absolute target INSIDE the active worktree → exit 0
  test('(4) GSD-managed worktree: absolute target inside the active worktree exits 0', () => {
    const payload = {
      cwd: agentWorktree,
      tool_name: 'Edit',
      tool_input: { file_path: path.join(agentWorktree, 'src', 'foo.ts') },
    };
    const result = runHook(agentWorktree, payload);
    assert.strictEqual(result.status, 0,
      `GSD-managed worktree targeting its own subtree must pass. ` +
      `Got exit ${result.status}. stderr: ${result.stderr}`
    );
    assert.strictEqual(result.stdout, '', 'Expected no block output');
  });

  // Test 5 — GSD-managed worktree: target OUTSIDE all git repos (tmpdir) → exit 0 (fail open)
  test('(5) GSD-managed worktree: target outside all git repos exits 0 (fail open, not #260 vector)', () => {
    // Create a temp dir that is NOT a git repository (no .git).
    // This is the ~/.claude/plans/ scenario — a path that has a real ancestor
    // directory but is outside every git repo.
    // IMPORTANT: this dir must NOT be inside any .git directory — it must be a plain tempdir
    // so the fail-open path (truly outside all repos) is exercised, not the .git-internals block.
    const externalDir = realp(fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-1342-ext-')));
    try {
      const targetPath = path.join(externalDir, 'notes.md');
      const payload = {
        cwd: agentWorktree,
        tool_name: 'Write',
        tool_input: { file_path: targetPath },
      };
      const result = runHook(agentWorktree, payload);
      assert.strictEqual(result.status, 0,
        `GSD-managed worktree writing to a path outside all git repos must fail open (exit 0). ` +
        `Only the different-git-root vector (#260) blocks; no-repo targets are not that vector. ` +
        `Got exit ${result.status}. stderr: ${result.stderr}`
      );
      assert.strictEqual(result.stdout, '', 'Expected no block output');
    } finally {
      cleanup(externalDir);
    }
  });

  // Test 6 — GSD-managed worktree: Write to .git/config of the MAIN repo → exit 2 (block)
  test('(6) blocks absolute writes into the main repo .git internals from a GSD worktree (#1342)', () => {
    // A target like /main-repo/.git/config or /main-repo/.git/hooks/pre-commit causes
    // `git rev-parse --show-toplevel` to FAIL (a .git dir is not a work tree), so the
    // "file not in any git repo" branch fires. Previously that branch failed open — but
    // writing into repository internals via an absolute path is still a #260-class escape
    // (and dangerous, e.g. injecting a git hook). The fix checks --is-inside-git-dir and
    // blocks when true.
    const gitConfigPath = path.join(mainRepo1342, '.git', 'config');
    const payload = {
      cwd: agentWorktree,
      tool_name: 'Write',
      tool_input: { file_path: gitConfigPath },
    };
    const result = runHook(agentWorktree, payload);
    assert.strictEqual(result.status, 2,
      `GSD-managed worktree targeting .git/config of another repo must be blocked (exit 2). ` +
      `Got exit ${result.status}. stderr: ${result.stderr}`
    );
    let parsed;
    assert.doesNotThrow(() => { parsed = JSON.parse(result.stdout); }, 'stdout must be valid JSON');
    assert.strictEqual(parsed.decision, 'block', 'Expected decision:"block" in output');
    assert.ok(
      parsed.reason && parsed.reason.includes('.git'),
      `Block reason should mention .git internals. Got: ${parsed.reason}`
    );
  });
});

// ---------------------------------------------------------------------------
// Static analysis: install.js guard
// ---------------------------------------------------------------------------

describe('install.js guard for gsd-worktree-path-guard.js', () => {
  let src;

  before(() => {
    // ADR-857 phase 5f-1b: hook registration moved to runtime-hooks-surface.cts.
    // Concatenate both sources so structural assertions find patterns in either file.
    const installSrc = fs.readFileSync(INSTALL_SRC, 'utf-8');
    let hooksSurfaceSrc = '';
    try { hooksSurfaceSrc = fs.readFileSync(HOOKS_SURFACE_SRC, 'utf-8'); } catch { /* ok */ }
    src = installSrc + '\n' + hooksSurfaceSrc;
  });

  test('install.js has hasWorktreePathGuardHook variable', () => {
    assert.ok(
      src.includes('hasWorktreePathGuardHook'),
      'hasWorktreePathGuardHook variable not found in install.js'
    );
  });

  test('install.js checks fs.existsSync before registering gsd-worktree-path-guard.js', () => {
    const anchorIdx = src.indexOf('hasWorktreePathGuardHook');
    assert.ok(anchorIdx !== -1, 'hasWorktreePathGuardHook not found in install.js');

    const blockStart = anchorIdx;
    const blockEnd = Math.min(src.length, anchorIdx + 1200);
    const block = src.slice(blockStart, blockEnd);

    assert.ok(
      block.includes('fs.existsSync') || block.includes('existsSync'),
      'install.js must call fs.existsSync on the target path before registering ' +
      'gsd-worktree-path-guard.js in settings.json. Without this guard, the hook ' +
      'is registered even when the .js file was never copied (root cause of #1754).'
    );
  });

  test('install.js emits a skip warning when gsd-worktree-path-guard.js is missing', () => {
    const anchorIdx = src.indexOf('hasWorktreePathGuardHook');
    assert.ok(anchorIdx !== -1, 'hasWorktreePathGuardHook not found in install.js');

    const block = src.slice(anchorIdx, Math.min(src.length, anchorIdx + 1200));

    assert.ok(
      block.includes('Skipped') && block.includes('gsd-worktree-path-guard'),
      'install.js must emit a skip warning mentioning gsd-worktree-path-guard when the file is not found'
    );
  });
});
