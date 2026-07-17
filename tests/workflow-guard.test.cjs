/**
 * Tests for gsd-workflow-guard.js PreToolUse hook.
 *
 * #2304 — Kimi tool vocabulary engages the guard: Kimi CLI registers this
 * guard with matcher 'Shell|WriteFile|StrReplaceFile' and forwards its own
 * tool vocabulary (tool_name 'Shell', possibly module-qualified). kimi-cli's
 * Shell.Params names its field `command` (src/kimi_cli/tools/shell/
 * __init__.py), same as Claude's Bash, so only the tool name needs
 * normalization. Pre-fix the guard's Bash branch never matched on Kimi and
 * the force-add block was silently dormant.
 */

'use strict';

process.env.GSD_TEST_MODE = '1';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, execSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { cleanup } = require('./helpers.cjs');

const HOOK_PATH = path.join(__dirname, '..', 'hooks', 'gsd-workflow-guard.js');

function runHook(payload, timeoutMs = 5000) {
  const input = JSON.stringify(payload);
  try {
    const stdout = execFileSync(process.execPath, [HOOK_PATH], {
      input,
      encoding: 'utf-8',
      timeout: timeoutMs,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { exitCode: 0, stdout: stdout.trim() };
  } catch (err) {
    return {
      exitCode: err.status ?? 1,
      stdout: (err.stdout || '').toString().trim(),
    };
  }
}

describe('#2304: Kimi tool vocabulary engages the workflow guard', () => {
  // A repo on a worktree-agent-* branch with the guard enabled: the one
  // state where the Bash branch produces an observable block, so a dormant
  // guard (silent exit 0) is distinguishable from a working one (exit 2).
  let repoDir;

  before(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-workflow-guard-'));
    execSync(
      'git init -q -b worktree-agent-test && git config user.email t@t && git config user.name t',
      { cwd: repoDir, stdio: 'ignore' }
    );
    fs.mkdirSync(path.join(repoDir, '.planning'));
    fs.writeFileSync(
      path.join(repoDir, '.planning', 'config.json'),
      JSON.stringify({ hooks: { workflow_guard: true } })
    );
  });

  after(() => {
    cleanup(repoDir);
  });

  test('Shell force-add on a worktree-agent branch is blocked like Bash', () => {
    const r = runHook({
      tool_name: 'Shell',
      tool_input: { command: 'git add -f secrets.env' },
      cwd: repoDir,
    });
    assert.equal(r.exitCode, 2, 'Kimi Shell should reach the Bash branch and block');
    assert.ok(
      r.stdout.includes('WORKTREE_AGENT_FORCE_ADD_FORBIDDEN'),
      'block payload should carry the force-add code'
    );
  });

  test('module-qualified kimi_cli.tools.shell:Shell is recognized', () => {
    const r = runHook({
      tool_name: 'kimi_cli.tools.shell:Shell',
      tool_input: { command: 'git add --force secrets.env' },
      cwd: repoDir,
    });
    assert.equal(r.exitCode, 2);
    assert.ok(r.stdout.includes('WORKTREE_AGENT_FORCE_ADD_FORBIDDEN'));
  });

  test('benign Shell command passes through', () => {
    const r = runHook({
      tool_name: 'Shell',
      tool_input: { command: 'git status' },
      cwd: repoDir,
    });
    assert.equal(r.exitCode, 0);
    assert.equal(r.stdout, '');
  });

  test('Bash (Claude vocabulary) still blocks — normalization is additive', () => {
    const r = runHook({
      tool_name: 'Bash',
      tool_input: { command: 'git add -f secrets.env' },
      cwd: repoDir,
    });
    assert.equal(r.exitCode, 2);
    assert.ok(r.stdout.includes('WORKTREE_AGENT_FORCE_ADD_FORBIDDEN'));
  });
});
