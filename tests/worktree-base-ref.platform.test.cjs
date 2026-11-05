'use strict';

/**
 * Platform-sensitive tests for the harness fork-probe default cache writer (#5757).
 *
 * scripts/gen-platform-conformance-tier.cjs selects whole files for the real-OS
 * (Windows/macOS) conformance tier. These tests create real symlinks and spawn
 * real git, so they live here; tests/worktree-base-ref.test.cjs stays signal-free.
 *
 * Tests and why each needs a real OS:
 * - "#5757: a symlinked .gsd is never written through" - creates a real directory symlink (symlink-keyword)
 * - "#5757: a symlinked cache file is never written through" - creates a real file symlink (symlink-keyword)
 * - "#5757: confirmed probe ... ignores .gsd in git" and the .gitignore rows - spawn a real git repo with a linked worktree (raw-child-process)
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { cleanup } = require('./helpers.cjs');
const { GIT_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

const { splitLines } = require(
  path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'text-lines.cjs'),
);

const { observeHarnessForkFromHead } = require(
  path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'worktree-base-ref.cjs'),
);

describe('observeHarnessForkFromHead default cache writer (#5757)', () => {
  function git(cwd, args) {
    return execFileSync('git', [
      '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false',
      ...args,
    ], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: GIT_TIMEOUT_MS }).trim();
  }

  /** Fresh git repo with one commit and a linked harness worktree at HEAD. */
  function makeProject() {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-5757-probe-')));
    git(root, ['init', '-q']);
    fs.writeFileSync(path.join(root, 'README.md'), 'x\n');
    git(root, ['add', 'README.md']);
    git(root, ['commit', '-q', '-m', 'init']);
    fs.mkdirSync(path.join(root, '.claude', 'worktrees'), { recursive: true });
    git(root, ['worktree', 'add', '-q', '--detach', path.join(root, '.claude', 'worktrees', 'agent-a'), 'HEAD']);
    return { root, head: git(root, ['rev-parse', 'HEAD']) };
  }

  function gsdStatusLines(root) {
    return git(root, ['status', '--porcelain']).split('\n').filter((l) => l.includes('.gsd'));
  }

  test('#5757: confirmed probe in a fresh repo ignores .gsd in git (case 1)', (t) => {
    const { root, head } = makeProject();
    t.after(() => cleanup(root));
    const result = observeHarnessForkFromHead({ cwd: root, headSha: head });
    assert.strictEqual(result.confirmed, true);
    assert.strictEqual(result.source, 'probe');
    assert.ok(fs.existsSync(path.join(root, '.gsd', 'harness-fork-probe.json')));
    assert.ok(fs.existsSync(path.join(root, '.gsd', '.gitignore')));
    assert.deepStrictEqual(gsdStatusLines(root), []);
  });

  test('#5757: a symlinked .gsd is never written through; the verdict still returns (case 2)', (t) => {
    const { root, head } = makeProject();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-5757-outside-'));
    t.after(() => cleanup(root));
    t.after(() => cleanup(outside));
    fs.symlinkSync(outside, path.join(root, '.gsd'), 'dir');
    const result = observeHarnessForkFromHead({ cwd: root, headSha: head });
    assert.strictEqual(result.confirmed, true);
    assert.deepStrictEqual(fs.readdirSync(outside), []);
  });

  test('#5757: a symlinked cache file is never written through (case 3)', (t) => {
    const { root, head } = makeProject();
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-5757-outside-'));
    t.after(() => cleanup(root));
    t.after(() => cleanup(outsideDir));
    const victim = path.join(outsideDir, 'victim.txt');
    fs.writeFileSync(victim, 'original');
    fs.mkdirSync(path.join(root, '.gsd'));
    fs.symlinkSync(victim, path.join(root, '.gsd', 'harness-fork-probe.json'));
    const result = observeHarnessForkFromHead({ cwd: root, headSha: head });
    assert.strictEqual(result.confirmed, true);
    assert.strictEqual(fs.readFileSync(victim, 'utf8'), 'original');
  });

  test('#5757: an existing user .gitignore without a catch-all keeps its rules and gains the probe rules once (case 4)', (t) => {
    const { root, head } = makeProject();
    t.after(() => cleanup(root));
    const ignorePath = path.join(root, '.gsd', '.gitignore');
    fs.mkdirSync(path.join(root, '.gsd'));
    const userRules = '# mine\nkeep-me.txt\n!also-mine\n';
    fs.writeFileSync(ignorePath, userRules);
    observeHarnessForkFromHead({ cwd: root, headSha: head });
    const after = fs.readFileSync(ignorePath, 'utf8');
    assert.ok(after.startsWith(userRules), 'user lines stay a verbatim prefix');
    assert.ok(splitLines(after).includes('/harness-fork-probe.json'));
    // Probe again with the cache removed: the block is not duplicated.
    cleanup(path.join(root, '.gsd', 'harness-fork-probe.json'));
    observeHarnessForkFromHead({ cwd: root, headSha: head });
    assert.strictEqual(fs.readFileSync(ignorePath, 'utf8'), after);
    assert.deepStrictEqual(gsdStatusLines(root), []);
  });

  test('#5757: an existing catch-all .gitignore is left byte-for-byte unchanged (case 5)', (t) => {
    const { root, head } = makeProject();
    t.after(() => cleanup(root));
    const ignorePath = path.join(root, '.gsd', '.gitignore');
    fs.mkdirSync(path.join(root, '.gsd'));
    fs.writeFileSync(ignorePath, '*\n');
    observeHarnessForkFromHead({ cwd: root, headSha: head });
    assert.strictEqual(fs.readFileSync(ignorePath, 'utf8'), '*\n');
    assert.ok(fs.existsSync(path.join(root, '.gsd', 'harness-fork-probe.json')));
  });

  test('#5757: injected stateRead/stateWrite are called with the cache path and nothing hits disk (case 6)', (t) => {
    const { root, head } = makeProject();
    t.after(() => cleanup(root));
    const reads = [];
    const writes = [];
    const result = observeHarnessForkFromHead({
      cwd: root,
      headSha: head,
      stateRead: (file) => { reads.push(file); return null; },
      stateWrite: (file, content) => { writes.push([file, content]); },
    });
    const cacheFile = path.join(root, '.gsd', 'harness-fork-probe.json');
    assert.strictEqual(result.confirmed, true);
    assert.deepStrictEqual(reads, [cacheFile]);
    assert.strictEqual(writes.length, 1);
    assert.strictEqual(writes[0][0], cacheFile);
    assert.strictEqual(JSON.parse(writes[0][1]).headSha, head);
    assert.strictEqual(fs.existsSync(path.join(root, '.gsd')), false);
  });
});
