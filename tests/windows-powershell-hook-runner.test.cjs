'use strict';

// #5850 — on Windows with no discoverable Git Bash, Claude Code runs shell-form
// hook commands in PowerShell. The POSIX `$(for ... done)` node-runner chain does
// not parse there, and because gsd-secret-read-guard is a blocking PreToolUse
// guard, every Read/Grep/Bash call is blocked. These tests pin the PowerShell
// form and the settings.json `shell` projection.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');

const hooksSurface = require('../gsd-core/bin/lib/runtime-hooks-surface.cjs');
const shellCmdProjection = require('../gsd-core/bin/lib/shell-command-projection.cjs');

const CONFIG_DIR = 'C:/Users/u/.claude';
const GUARD = 'gsd-secret-read-guard.js';
const NO_BASH = { platform: 'win32', runtime: 'claude', env: {}, existsSync: () => false, execPath: 'D:/Program Files/nodejs/node.exe' };
const WITH_BASH = {
  platform: 'win32',
  runtime: 'claude',
  env: { ProgramFiles: 'C:\\Program Files' },
  existsSync: (p) => /bash\.exe$/i.test(String(p)),
  execPath: 'D:/Program Files/nodejs/node.exe',
};
// Hook budget in seconds recorded on the fixture entries (not a wall-clock assertion).
const HOOK_TIMEOUT_S = 10;
const POSIX_ONLY = /\$\(|command -v|\[ -x|printf '%s'|; do |; done/;

function settingsWith(commands) {
  return { hooks: { PreToolUse: commands.map((command) => ({ matcher: 'Read|Grep|Bash', hooks: [{ type: 'command', command, timeout: HOOK_TIMEOUT_S }] })) } };
}

describe('#5850 win32 hook runner without Git Bash', () => {
  test('no-bash win32 claude emits a PowerShell runner with no POSIX-only syntax', () => {
    const cmd = hooksSurface.buildHookCommand(CONFIG_DIR, GUARD, NO_BASH);
    assert.ok(typeof cmd === 'string' && cmd.startsWith('& '), cmd);
    assert.doesNotMatch(cmd, POSIX_ONLY);
    assert.ok(cmd.includes("'D:/Program Files/nodejs/node.exe'"), 'baked node path is tried first');
    assert.ok(cmd.includes('Get-Command node'), 'PATH fallback is resolved in PowerShell');
    assert.ok(cmd.endsWith(`'C:/Users/u/.claude/hooks/${GUARD}'`), cmd);
  });

  test('every managed JS hook emits the PowerShell form', () => {
    for (const hook of ['gsd-statusline.js', 'gsd-check-update.js', 'gsd-prompt-guard.js', 'gsd-read-guard.js', 'gsd-workflow-guard.js']) {
      const cmd = hooksSurface.buildHookCommand(CONFIG_DIR, hook, NO_BASH);
      assert.doesNotMatch(cmd, POSIX_ONLY, hook);
    }
  });

  test('a single quote in the node path is doubled', () => {
    const cmd = hooksSurface.buildHookCommand(CONFIG_DIR, GUARD, { ...NO_BASH, execPath: "D:/it's/node.exe" });
    assert.ok(cmd.includes("'D:/it''s/node.exe'"), cmd);
  });

  test('Git Bash present keeps the POSIX chain', () => {
    const cmd = hooksSurface.buildHookCommand(CONFIG_DIR, GUARD, WITH_BASH);
    assert.ok(cmd.startsWith('"$(for n in '), cmd);
  });

  test('non-win32 output is the POSIX chain', () => {
    for (const platform of ['linux', 'darwin']) {
      const cmd = hooksSurface.buildHookCommand('/home/u/.claude', GUARD, { platform, runtime: 'claude', execPath: '/usr/bin/node' });
      assert.ok(cmd.startsWith('"$(for n in '), cmd);
    }
  });

  test('a non-claude runtime keeps the POSIX chain', () => {
    const cmd = hooksSurface.buildHookCommand(CONFIG_DIR, GUARD, { ...NO_BASH, runtime: 'gemini' });
    assert.ok(cmd.startsWith('"$(for n in '), cmd);
  });

  test('the PowerShell command is recognized as a managed hook command', () => {
    const cmd = hooksSurface.buildHookCommand(CONFIG_DIR, GUARD, NO_BASH);
    assert.equal(shellCmdProjection.isManagedHookCommand(cmd, { surface: 'settings-json', configDir: CONFIG_DIR }), true);
  });

  test('usesPowerShellHookShell reflects Git Bash discovery', () => {
    assert.equal(hooksSurface.usesPowerShellHookShell(NO_BASH), true);
    assert.equal(hooksSurface.usesPowerShellHookShell(WITH_BASH), false);
    assert.equal(hooksSurface.usesPowerShellHookShell({ ...NO_BASH, platform: 'linux' }), false);
    assert.equal(hooksSurface.usesPowerShellHookShell({ ...NO_BASH, runtime: 'codex' }), false);
  });
});

describe('#5850 rewriter and settings projection', () => {
  const oldChain = '"$(for n in "D:/Program Files/nodejs/node.exe" "$(command -v node)" /usr/local/bin/node /usr/bin/node; do [ -x "$n" ] && { [ "${n#/}" != "$n" ] || [ "${n#?:}" != "$n" ]; } && printf \'%s\' "$n" && break; done)" "C:/Users/u/.claude/hooks/' + GUARD + '"';

  test('an old chain entry converts to the PowerShell form and the second run is a no-op', () => {
    const settings = settingsWith([oldChain]);
    const opts = { ...NO_BASH };
    assert.equal(hooksSurface.rewriteLegacyManagedNodeHookCommands(settings, hooksSurface.buildNodeRunnerChainToken(), opts), true);
    const cmd = settings.hooks.PreToolUse[0].hooks[0].command;
    assert.ok(cmd.startsWith('& '), cmd);
    assert.doesNotMatch(cmd, POSIX_ONLY);
    assert.ok(cmd.endsWith(`'C:/Users/u/.claude/hooks/${GUARD}'`), cmd);
    assert.equal(hooksSurface.rewriteLegacyManagedNodeHookCommands(settings, hooksSurface.buildNodeRunnerChainToken(), opts), false);
  });

  test('a PowerShell entry is left alone when Git Bash is present', () => {
    const ps = hooksSurface.buildHookCommand(CONFIG_DIR, GUARD, NO_BASH);
    const settings = settingsWith([ps]);
    assert.equal(hooksSurface.rewriteLegacyManagedNodeHookCommands(settings, hooksSurface.buildNodeRunnerChainToken(), { ...WITH_BASH }), false);
    assert.equal(settings.hooks.PreToolUse[0].hooks[0].command, ps);
  });

  test('an old chain entry is untouched where the chain is correct', () => {
    const settings = settingsWith([oldChain]);
    assert.equal(hooksSurface.rewriteLegacyManagedNodeHookCommands(settings, hooksSurface.buildNodeRunnerChainToken(), { ...WITH_BASH }), false);
    assert.equal(settings.hooks.PreToolUse[0].hooks[0].command, oldChain);
  });

  test('projectPowerShellHookShell sets shell only on PowerShell commands and is idempotent', () => {
    const ps = hooksSurface.buildHookCommand(CONFIG_DIR, GUARD, NO_BASH);
    const settings = settingsWith([ps, oldChain]);
    assert.equal(hooksSurface.projectPowerShellHookShell(settings), true);
    assert.equal(settings.hooks.PreToolUse[0].hooks[0].shell, 'powershell');
    assert.equal('shell' in settings.hooks.PreToolUse[1].hooks[0], false);
    assert.equal(hooksSurface.projectPowerShellHookShell(settings), false);
  });

  test('the local-install token uses $env:CLAUDE_PROJECT_DIR', () => {
    const cmd = hooksSurface.buildPowerShellLocalHookCommand({
      localPrefix: '"$CLAUDE_PROJECT_DIR"/.claude', hookFile: GUARD, platform: 'win32', runtime: 'claude', execPath: 'D:/Program Files/nodejs/node.exe',
    });
    assert.ok(cmd.startsWith('& '), cmd);
    assert.ok(cmd.endsWith(`"$env:CLAUDE_PROJECT_DIR/.claude/hooks/${GUARD}"`), cmd);
    assert.doesNotMatch(cmd, POSIX_ONLY);
  });

  test('a chain built by the installer under Git Bash converts when Git Bash is gone', () => {
    const chain = hooksSurface.buildHookCommand(CONFIG_DIR, GUARD, WITH_BASH);
    assert.ok(chain.startsWith('"$(for n in '), chain);
    const settings = settingsWith([chain]);
    assert.equal(hooksSurface.rewriteLegacyManagedNodeHookCommands(settings, hooksSurface.buildNodeRunnerChainToken(), { ...NO_BASH }), true);
    assert.ok(settings.hooks.PreToolUse[0].hooks[0].command.endsWith(`'C:/Users/u/.claude/hooks/${GUARD}'`));
  });

  test('a local-install chain converts to the $env:CLAUDE_PROJECT_DIR form', () => {
    const local = shellCmdProjection.projectShellCommandText({
      runnerToken: hooksSurface.buildNodeRunnerChainToken({ execPath: NO_BASH.execPath }),
      argTokens: [`"$CLAUDE_PROJECT_DIR"/.claude/hooks/${GUARD}`],
      runtime: 'claude',
      platform: 'win32',
    });
    const settings = settingsWith([local]);
    assert.equal(hooksSurface.rewriteLegacyManagedNodeHookCommands(settings, hooksSurface.buildNodeRunnerChainToken(), { ...NO_BASH }), true);
    const cmd = settings.hooks.PreToolUse[0].hooks[0].command;
    assert.ok(cmd.endsWith(`"$env:CLAUDE_PROJECT_DIR/.claude/hooks/${GUARD}"`), cmd);
  });

  test('the bash resolver shape converts when its script is a plain path and is kept for $HOME paths', () => {
    const plain = `bash "C:/Users/u/.claude/hooks/gsd-node-runner.sh" "/usr/bin/node" "C:/Users/u/.claude/hooks/${GUARD}"`;
    const portable = `bash "$HOME/.claude/hooks/gsd-node-runner.sh" "/usr/bin/node" "$HOME/.claude/hooks/${GUARD}"`;
    const settings = settingsWith([plain, portable]);
    assert.equal(hooksSurface.rewriteLegacyManagedNodeHookCommands(settings, hooksSurface.buildNodeRunnerChainToken(), { ...NO_BASH }), true);
    assert.ok(settings.hooks.PreToolUse[0].hooks[0].command.startsWith('& '));
    assert.equal(settings.hooks.PreToolUse[1].hooks[0].command, portable);
  });

  test('a managed statusLine chain converts and the second run is a no-op', () => {
    const settings = { hooks: {}, statusLine: { type: 'command', command: oldChain.replace(GUARD, 'gsd-statusline.js') } };
    assert.equal(hooksSurface.rewriteLegacyManagedNodeHookCommands(settings, hooksSurface.buildNodeRunnerChainToken(), { ...NO_BASH }), true);
    assert.ok(settings.statusLine.command.startsWith('& '));
    assert.equal(hooksSurface.rewriteLegacyManagedNodeHookCommands(settings, hooksSurface.buildNodeRunnerChainToken(), { ...NO_BASH }), false);
  });

  test('curly quotes are PowerShell quote delimiters and are doubled', () => {
    const cmd = hooksSurface.buildHookCommand('C:/Users/O\u2019Brien \u2018x\u2019/.claude', GUARD, NO_BASH);
    assert.ok(cmd.includes('O\u2019\u2019Brien \u2018\u2018x\u2019\u2019'), cmd);
  });

  test('an anchored local token with special characters stays one expression', () => {
    const plain = hooksSurface.buildPowerShellLocalHookCommand({ localPrefix: '"$CLAUDE_PROJECT_DIR"/.claude', hookFile: GUARD, execPath: NO_BASH.execPath });
    assert.ok(plain.endsWith(`"$env:CLAUDE_PROJECT_DIR/.claude/hooks/${GUARD}"`), plain);
    for (const dir of ['.cl$aude', '.cl`aude', '.cl\u201Caude']) {
      const cmd = hooksSurface.buildPowerShellLocalHookCommand({ localPrefix: `"$CLAUDE_PROJECT_DIR"/${dir}`, hookFile: GUARD, execPath: NO_BASH.execPath });
      assert.ok(cmd.includes(`($env:CLAUDE_PROJECT_DIR + '/${dir}/hooks/${GUARD}')`), cmd);
    }
  });

  test('property: the script token round-trips any path', () => {
    const dirChars = fc.constantFrom(...'abcXYZ019 \'$"`&;()%._-{}\u2018\u2019\u201A\u201B\u201C\u201D'.split(''));
    fc.assert(fc.property(fc.array(dirChars, { minLength: 1, maxLength: 20 }).map((a) => a.join('')), (dir) => {
      const cmd = hooksSurface.buildHookCommand(`C:/cfg/${dir}`, GUARD, NO_BASH);
      const m = cmd.match(/\) '(.*)'$/);
      assert.ok(m, cmd);
      const body = m[1];
      // Every quote delimiter inside the literal must appear doubled.
      assert.doesNotMatch(body.replace(/(['\u2018\u2019\u201A\u201B])\1/g, ''), /['\u2018\u2019\u201A\u201B]/);
      assert.equal(body.replace(/(['\u2018\u2019\u201A\u201B])\1/g, '$1'), `C:/cfg/${dir}/hooks/${GUARD}`);
    }), { numRuns: 100 });
  });
});
