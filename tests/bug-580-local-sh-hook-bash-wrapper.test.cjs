'use strict';

/**
 * Regression test for bug #580.
 *
 * LOCAL install under Claude Code on Windows: managed `.sh` hooks were emitted
 * wrapped with an absolute `bash.exe` path via the `localShellCmd` arrow.
 * Since Claude Code runs hook command strings INSIDE Git Bash, bash tries to
 * exec bash → "cannot execute binary file".
 *
 * The GLOBAL path (`buildHookCommand`) already guarded win32+claude+.sh (#166).
 * The LOCAL path (`localShellCmd`) did not. Fix: add `buildLocalShellHookCommand`
 * and `shellHookOmitsBashRunner` to shell-command-projection.cjs, and use
 * `buildLocalShellHookCommand` from install.js local-install path.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const projection = require(path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'shell-command-projection.cjs'));
const { buildLocalShellHookCommand, shellHookOmitsBashRunner, projectLocalHookPrefix } = projection;

describe('bug #580: local .sh hooks on Claude/Windows must NOT wrap with bash.exe', () => {
  test('local .sh hook on Claude/Windows omits the bash.exe wrapper (#580)', () => {
    const localPrefix = projectLocalHookPrefix({ runtime: 'claude', dirName: '.claude' });
    const result = buildLocalShellHookCommand({
      localPrefix,
      hookFile: 'gsd-session-state.sh',
      bashRunner: '"C:/Program Files/Git/bin/bash.exe"',
      runtime: 'claude',
      platform: 'win32',
    });
    assert.equal(result, '"$CLAUDE_PROJECT_DIR"/.claude/hooks/gsd-session-state.sh');
    assert.ok(!result.includes('bash.exe'), `result must not contain bash.exe, got: ${result}`);
  });

  test('local .sh hook on Claude/Windows still emits script path when bash.exe is unresolved', () => {
    const localPrefix = projectLocalHookPrefix({ runtime: 'claude', dirName: '.claude' });
    const result = buildLocalShellHookCommand({
      localPrefix,
      hookFile: 'gsd-session-state.sh',
      bashRunner: null,
      runtime: 'claude',
      platform: 'win32',
    });
    assert.equal(result, '"$CLAUDE_PROJECT_DIR"/.claude/hooks/gsd-session-state.sh');
  });

  test('local .sh hook on POSIX keeps the bash runner', () => {
    const localPrefix = projectLocalHookPrefix({ runtime: 'claude', dirName: '.claude' });
    const result = buildLocalShellHookCommand({
      localPrefix,
      hookFile: 'gsd-session-state.sh',
      bashRunner: 'bash',
      runtime: 'claude',
      platform: 'linux',
    });
    assert.equal(result, 'bash "$CLAUDE_PROJECT_DIR"/.claude/hooks/gsd-session-state.sh');
  });

  test('local .sh hook on Windows non-Claude runtime keeps the bash runner', () => {
    const localPrefix = projectLocalHookPrefix({ runtime: 'codex', dirName: '.claude' });
    const result = buildLocalShellHookCommand({
      localPrefix,
      hookFile: 'gsd-session-state.sh',
      bashRunner: '"C:/Program Files/Git/bin/bash.exe"',
      runtime: 'codex',
      platform: 'win32',
    });
    assert.ok(result.includes('bash.exe'), `result must contain bash.exe, got: ${result}`);
    assert.ok(result.startsWith('"C:/Program Files/Git/bin/bash.exe"'), `result must start with bash.exe token, got: ${result}`);
  });

  test('all four managed local .sh hooks drop the wrapper on Claude/Windows', () => {
    const localPrefix = projectLocalHookPrefix({ runtime: 'claude', dirName: '.claude' });
    const hooks = [
      'gsd-session-state.sh',
      'gsd-validate-commit.sh',
      'gsd-graphify-update.sh',
      'gsd-phase-boundary.sh',
    ];
    for (const f of hooks) {
      const result = buildLocalShellHookCommand({
        localPrefix,
        hookFile: f,
        bashRunner: '"C:/Program Files/Git/bin/bash.exe"',
        runtime: 'claude',
        platform: 'win32',
      });
      assert.equal(
        result,
        `"$CLAUDE_PROJECT_DIR"/.claude/hooks/${f}`,
        `expected script-only path for ${f}, got: ${result}`,
      );
      assert.ok(!result.includes('bash.exe'), `result for ${f} must not contain bash.exe, got: ${result}`);
    }
  });

  test('shellHookOmitsBashRunner truth table', () => {
    // true only for win32 + claude + isShellHook:true
    assert.equal(shellHookOmitsBashRunner({ platform: 'win32', runtime: 'claude', isShellHook: true }), true);

    // false for win32 + claude + isShellHook:false
    assert.equal(shellHookOmitsBashRunner({ platform: 'win32', runtime: 'claude', isShellHook: false }), false);

    // false for win32 + codex + isShellHook:true
    assert.equal(shellHookOmitsBashRunner({ platform: 'win32', runtime: 'codex', isShellHook: true }), false);

    // false for linux + claude + isShellHook:true
    assert.equal(shellHookOmitsBashRunner({ platform: 'linux', runtime: 'claude', isShellHook: true }), false);

    // false for default args (no win32, no claude)
    assert.equal(shellHookOmitsBashRunner(), false);
  });
});
