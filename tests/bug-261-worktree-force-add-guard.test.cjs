'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const { cleanup } = require('./helpers.cjs');

const HOOK_PATH = path.join(__dirname, '..', 'hooks', 'gsd-workflow-guard.js');

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function makeRepo(branch) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-bug-261-'));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test User']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(dir, 'README.md'), '# test\n');
  git(dir, ['add', 'README.md']);
  git(dir, ['commit', '-q', '-m', 'chore: init']);
  git(dir, ['checkout', '-q', '-b', branch]);
  return dir;
}

function setWorkflowGuard(dir, enabled) {
  const planningDir = path.join(dir, '.planning');
  fs.mkdirSync(planningDir, { recursive: true });
  fs.writeFileSync(
    path.join(planningDir, 'config.json'),
    JSON.stringify({ hooks: { workflow_guard: enabled } }, null, 2)
  );
}

function runHookInput(cwd, input) {
  return spawnSync(process.execPath, [HOOK_PATH], {
    cwd,
    encoding: 'utf8',
    input: JSON.stringify({ cwd, ...input }),
  });
}

function runBashHook(cwd, command) {
  return runHookInput(cwd, {
    tool_name: 'Bash',
    tool_input: { command },
  });
}

describe('bug #261: workflow guard blocks forced git add on worktree-agent branches', () => {
  test('blocks git add -f on worktree-agent branch when workflow guard is enabled', () => {
    const dir = makeRepo('worktree-agent-a1');
    try {
      setWorkflowGuard(dir, true);
      const result = runBashHook(dir, 'git add -f .planning/phases/01/01-01-SUMMARY.md');
      assert.strictEqual(result.status, 2);
      const envelope = JSON.parse(result.stdout);
      assert.strictEqual(envelope.decision, 'block');
      assert.strictEqual(envelope.code, 'WORKTREE_AGENT_FORCE_ADD_FORBIDDEN');
    } finally {
      cleanup(dir);
    }
  });

  test('blocks git add --force with git global options on worktree-agent branch', () => {
    const dir = makeRepo('worktree-agent-b2');
    try {
      setWorkflowGuard(dir, true);
      const result = runBashHook(dir, `git -C "${dir}" add --force .planning/SUMMARY.md`);
      assert.strictEqual(result.status, 2);
      assert.strictEqual(JSON.parse(result.stdout).code, 'WORKTREE_AGENT_FORCE_ADD_FORBIDDEN');
    } finally {
      cleanup(dir);
    }
  });

  test('allows ordinary git add on worktree-agent branch', () => {
    const dir = makeRepo('worktree-agent-c3');
    try {
      setWorkflowGuard(dir, true);
      const result = runBashHook(dir, 'git add .planning/SUMMARY.md');
      assert.strictEqual(result.status, 0);
      assert.strictEqual(result.stdout, '');
    } finally {
      cleanup(dir);
    }
  });

  test('allows pathspecs named like force flags after git add -- terminator', () => {
    const dir = makeRepo('worktree-agent-d4');
    try {
      setWorkflowGuard(dir, true);
      const result = runBashHook(dir, 'git add -- -f');
      assert.strictEqual(result.status, 0);
      assert.strictEqual(result.stdout, '');
    } finally {
      cleanup(dir);
    }
  });

  test('allows git add -f outside worktree-agent branches', () => {
    const dir = makeRepo('feature-docs');
    try {
      setWorkflowGuard(dir, true);
      const result = runBashHook(dir, 'git add -f .planning/SUMMARY.md');
      assert.strictEqual(result.status, 0);
      assert.strictEqual(result.stdout, '');
    } finally {
      cleanup(dir);
    }
  });

  test('allows git add -f on worktree-agent branch when workflow guard is disabled', () => {
    const dir = makeRepo('worktree-agent-e5');
    try {
      setWorkflowGuard(dir, false);
      const result = runBashHook(dir, 'git add -f .planning/SUMMARY.md');
      assert.strictEqual(result.status, 0);
      assert.strictEqual(result.stdout, '');
    } finally {
      cleanup(dir);
    }
  });

  test('allows git add -f on worktree-agent branch when no GSD config exists', () => {
    const dir = makeRepo('worktree-agent-f6');
    try {
      const result = runBashHook(dir, 'git add -f .planning/SUMMARY.md');
      assert.strictEqual(result.status, 0);
      assert.strictEqual(result.stdout, '');
    } finally {
      cleanup(dir);
    }
  });

  test('applies the advisory path to MultiEdit when workflow guard is enabled', () => {
    const dir = makeRepo('feature-multiedit');
    try {
      setWorkflowGuard(dir, true);
      const result = runHookInput(dir, {
        tool_name: 'MultiEdit',
        tool_input: {
          file_path: path.join(dir, 'src.js'),
          edits: [],
        },
      });
      assert.strictEqual(result.status, 0);
      const envelope = JSON.parse(result.stdout);
      assert.match(
        envelope.hookSpecificOutput.additionalContext,
        /WORKFLOW ADVISORY/
      );
    } finally {
      cleanup(dir);
    }
  });
});
