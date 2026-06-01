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

const HOOK_PATH = path.join(__dirname, '..', 'hooks', 'gsd-worktree-path-guard.js');
const INSTALL_SRC = path.join(__dirname, '..', 'bin', 'install.js');

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
 */
function makeWorktree(mainRepo) {
  const wtDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-260-wt-'));
  fs.rmdirSync(wtDir); // git worktree add creates the dir itself
  git(mainRepo, ['worktree', 'add', '-q', '-b', 'wt-test-branch', wtDir]);
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
  try { fs.rmSync(mainRepo, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(worktreeDir, { recursive: true, force: true }); } catch { /* ignore */ }
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

  // 6. Sibling directory path is BLOCKED (validates the '/' boundary check)
  describe('sibling path is blocked', () => {
    test('path that shares prefix with worktree root but is a sibling exits 2', () => {
      // e.g. worktreeDir = /tmp/gsd-260-wt-XXXXX
      // sibling       = /tmp/gsd-260-wt-XXXXXsibling/file.ts
      // This would pass a naive startsWith(wtRoot) check without the '/' suffix.
      const siblingPath = worktreeDir + '-sibling/file.ts';
      const payload = {
        cwd: worktreeDir,
        tool_name: 'Edit',
        tool_input: { file_path: siblingPath },
      };
      const result = runHook(worktreeDir, payload);
      assert.strictEqual(result.status, 2,
        `Sibling path "${siblingPath}" must be blocked (exit 2), got ${result.status}. ` +
        `This validates the '/' boundary check in startsWith(wtRoot + '/'). stderr: ${result.stderr}`
      );
      const parsed = JSON.parse(result.stdout);
      assert.strictEqual(parsed.decision, 'block');
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
      // /worktree/src/../../../main-repo/file.ts resolves outside the worktree
      const traversalPath = path.join(worktreeDir, 'src', '..', '..', '..', mainRepo.replace(/^\//, ''), 'file.ts');
      const payload = {
        cwd: worktreeDir,
        tool_name: 'Edit',
        tool_input: { file_path: traversalPath },
      };
      const result = runHook(worktreeDir, payload);
      // After path.resolve, the path should equal something outside the worktree
      const resolved = path.resolve(traversalPath);
      if (resolved.startsWith(worktreeDir + path.sep) || resolved === worktreeDir) {
        // The traversal happened to stay inside — skip this assertion
        assert.ok(true, 'traversal resolved inside worktree (environment-dependent)');
      } else {
        assert.strictEqual(result.status, 2,
          `Traversal path "${traversalPath}" resolves to "${resolved}" which is outside the worktree. ` +
          `Must be blocked. Got exit ${result.status}. stderr: ${result.stderr}`
        );
        const parsed = JSON.parse(result.stdout);
        assert.strictEqual(parsed.decision, 'block');
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
// Static analysis: install.js guard
// ---------------------------------------------------------------------------

describe('install.js guard for gsd-worktree-path-guard.js', () => {
  let src;

  before(() => {
    src = fs.readFileSync(INSTALL_SRC, 'utf-8');
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
