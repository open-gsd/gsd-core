'use strict';

// #5850 — Claude Code on Windows can host a hook command in PowerShell (it does
// whenever Git Bash is not found). The POSIX `$(for ... done)` node-runner chain
// does not parse there, and because gsd-secret-read-guard is a blocking
// PreToolUse guard, every Read/Grep/Bash call is blocked. Owner ruling: every
// win32 Claude JS hook command is the PowerShell form carrying an explicit
// `shell: "powershell"`, whether or not Git Bash is discoverable. These tests pin
// that form and the settings.json `shell` projection.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const helpers = require('./helpers.cjs');
const { runNode } = require('./helpers/process-seam.cjs');
const { INSTALL_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

const hooksSurface = require('../gsd-core/bin/lib/runtime-hooks-surface.cjs');
const shellCmdProjection = require('../gsd-core/bin/lib/shell-command-projection.cjs');

const CONFIG_DIR = 'C:/Users/u/.claude';
const GUARD = 'gsd-secret-read-guard.js';
const EXEC_PATH = 'D:/Program Files/nodejs/node.exe';
// Git Bash discovery must not matter: every case runs both with and without it.
const GIT_BASH_VARIANTS = [
  ['without Git Bash', { env: {}, existsSync: () => false }],
  [
    'with Git Bash',
    {
      env: { ProgramFiles: 'C:\\Program Files' },
      existsSync: (p) => /bash\.exe$/i.test(String(p)),
    },
  ],
];
const win = (extra) => ({ platform: 'win32', runtime: 'claude', execPath: EXEC_PATH, ...extra });
// Exit-code propagation: `powershell -Command` maps a native exit 2 (a blocking guard's deny) to 1 unless the command exits with it;
// a runner that never started leaves $LASTEXITCODE null and must exit 1, not 0.
const EXIT = '; exit $(if ($null -ne $LASTEXITCODE) { $LASTEXITCODE } else { 1 })';
const POSIX_ONLY = /\$\(for n in|command -v|\[ -x|printf '%s'|; do |; done/;

function settingsWith(commands) {
  return { hooks: { PreToolUse: commands.map((command) => ({ matcher: 'Read|Grep|Bash', hooks: [{ type: 'command', command }] })) } };
}

const oldChain = '"$(for n in "D:/Program Files/nodejs/node.exe" "$(command -v node)" /usr/local/bin/node /usr/bin/node; do [ -x "$n" ] && { [ "${n#/}" != "$n" ] || [ "${n#?:}" != "$n" ]; } && printf \'%s\' "$n" && break; done)" "C:/Users/u/.claude/hooks/' + GUARD + '"';

for (const [label, bash] of GIT_BASH_VARIANTS) {
  describe(`#5850 win32 claude hook runner ${label}`, () => {
    test('emits a PowerShell runner with no POSIX-only syntax', () => {
      const cmd = hooksSurface.buildHookCommand(CONFIG_DIR, GUARD, win(bash));
      assert.ok(typeof cmd === 'string' && cmd.startsWith('& '), cmd);
      assert.doesNotMatch(cmd, POSIX_ONLY);
      assert.ok(cmd.includes("'D:/Program Files/nodejs/node.exe'"), 'baked node path is tried first');
      assert.ok(cmd.includes('Get-Command node'), 'PATH fallback is resolved in PowerShell');
      assert.ok(cmd.endsWith(`'C:/Users/u/.claude/hooks/${GUARD}'` + EXIT), cmd);
    });

    test('every managed JS hook emits the PowerShell form', () => {
      for (const hook of ['gsd-statusline.js', 'gsd-check-update.js', 'gsd-prompt-guard.js', 'gsd-read-guard.js', 'gsd-workflow-guard.js']) {
        const cmd = hooksSurface.buildHookCommand(CONFIG_DIR, hook, win(bash));
        assert.doesNotMatch(cmd, POSIX_ONLY, hook);
        assert.ok(cmd.startsWith('& '), hook);
      }
    });

    test('the PowerShell command is recognized as a managed hook command', () => {
      const cmd = hooksSurface.buildHookCommand(CONFIG_DIR, GUARD, win(bash));
      assert.equal(shellCmdProjection.isManagedHookCommand(cmd, { surface: 'settings-json', configDir: CONFIG_DIR }), true);
    });

    test('the command exits with the guard\'s exit code so a blocking exit 2 survives powershell -Command', () => {
      const cmd = hooksSurface.buildHookCommand(CONFIG_DIR, GUARD, win(bash));
      assert.ok(cmd.endsWith(EXIT), cmd);
    });

    test('usesPowerShellHookShell is true for claude on win32', () => {
      assert.equal(hooksSurface.usesPowerShellHookShell(win(bash)), true);
    });

    test('a chain built by the installer converts to the PowerShell runner and the second run is a no-op', () => {
      const chain = hooksSurface.buildHookCommand(CONFIG_DIR, GUARD, win({ ...bash, hookShell: 'bash' }));
      assert.ok(chain.startsWith('"$(for n in '), chain);
      const settings = settingsWith([chain, oldChain]);
      const runner = hooksSurface.buildNodeRunnerChainToken();
      assert.equal(hooksSurface.rewriteLegacyManagedNodeHookCommands(settings, runner, win(bash)), true);
      for (const entry of settings.hooks.PreToolUse) {
        const cmd = entry.hooks[0].command;
        assert.ok(cmd.startsWith('& '), cmd);
        assert.doesNotMatch(cmd, POSIX_ONLY);
        assert.ok(cmd.endsWith(`'C:/Users/u/.claude/hooks/${GUARD}'` + EXIT), cmd);
      }
      assert.equal(hooksSurface.rewriteLegacyManagedNodeHookCommands(settings, runner, win(bash)), false);
    });

    test('a PowerShell entry is left alone', () => {
      const ps = hooksSurface.buildHookCommand(CONFIG_DIR, GUARD, win(bash));
      const settings = settingsWith([ps]);
      assert.equal(hooksSurface.rewriteLegacyManagedNodeHookCommands(settings, hooksSurface.buildNodeRunnerChainToken(), win(bash)), false);
      assert.equal(settings.hooks.PreToolUse[0].hooks[0].command, ps);
    });
  });
}

describe('#5850 unchanged surfaces', () => {
  test('non-win32 output is the POSIX chain', () => {
    for (const platform of ['linux', 'darwin']) {
      const cmd = hooksSurface.buildHookCommand('/home/u/.claude', GUARD, { platform, runtime: 'claude', execPath: '/usr/bin/node' });
      assert.ok(cmd.startsWith('"$(for n in '), cmd);
    }
  });

  test('a non-claude runtime keeps the POSIX chain on win32', () => {
    const cmd = hooksSurface.buildHookCommand(CONFIG_DIR, GUARD, win({ runtime: 'gemini' }));
    assert.ok(cmd.startsWith('"$(for n in '), cmd);
  });

  test('an explicit hookShell bash selects the chain', () => {
    const cmd = hooksSurface.buildHookCommand(CONFIG_DIR, GUARD, win({ hookShell: 'bash' }));
    assert.ok(cmd.startsWith('"$(for n in '), cmd);
  });

  test('usesPowerShellHookShell is false off win32, for other runtimes and for hookShell bash', () => {
    assert.equal(hooksSurface.usesPowerShellHookShell(win({ platform: 'linux' })), false);
    assert.equal(hooksSurface.usesPowerShellHookShell(win({ runtime: 'codex' })), false);
    assert.equal(hooksSurface.usesPowerShellHookShell(win({ hookShell: 'bash' })), false);
  });

  test('portable hooks on win32 claude are the PowerShell runner with a $HOME-relative script, with and without Git Bash', () => {
    const os = require('node:os');
    const home = os.homedir().replace(/\\/g, '/');
    for (const [, bash] of GIT_BASH_VARIANTS) {
      const cmd = hooksSurface.buildHookCommand(`${home}/.claude`, GUARD, win({ ...bash, portableHooks: true }));
      assert.ok(typeof cmd === 'string' && cmd.startsWith('& '), cmd);
      assert.doesNotMatch(cmd, POSIX_ONLY);
      assert.ok(cmd.includes(`"$HOME/.claude/hooks/${GUARD}"`), cmd);
      assert.ok(cmd.endsWith(EXIT), cmd);
    }
  });

  test('portable PowerShell hooks register no bash resolver entrypoint', () => {
    const os = require('node:os');
    const entrypoints = [];
    const cmd = hooksSurface.buildHookCommand(`${os.homedir().replace(/\\/g, '/')}/.claude`, GUARD, win({ portableHooks: true, env: {}, existsSync: () => false, configuredEntrypoints: entrypoints }));
    assert.ok(cmd);
    assert.equal(entrypoints.length, 1);
    assert.ok(!entrypoints[0].scriptPath.endsWith('gsd-node-runner.sh'));
  });

  test('portable hooks keep the bash resolver off win32 and for non-claude runtimes', () => {
    const os = require('node:os');
    const home = os.homedir().replace(/\\/g, '/');
    const linux = hooksSurface.buildHookCommand(`${home}/.claude`, GUARD, { platform: 'linux', runtime: 'claude', portableHooks: true, execPath: '/usr/bin/node' });
    assert.match(linux, /gsd-node-runner\.sh/);
    const other = hooksSurface.buildHookCommand(`${home}/.claude`, GUARD, win({ runtime: 'antigravity', portableHooks: true, env: { ProgramFiles: 'C:\\Program Files' }, existsSync: (p) => /bash\.exe$/i.test(String(p)) }));
    assert.match(other, /gsd-node-runner\.sh/);
  });
});

describe('#5850 quoting', () => {
  test('a single quote in the node path is doubled', () => {
    const cmd = hooksSurface.buildHookCommand(CONFIG_DIR, GUARD, win({ execPath: "D:/it's/node.exe" }));
    assert.ok(cmd.includes("'D:/it''s/node.exe'"), cmd);
  });

  test('curly quotes are PowerShell quote delimiters and are doubled', () => {
    const cmd = hooksSurface.buildHookCommand('C:/Users/O\u2019Brien \u2018x\u2019/.claude', GUARD, win());
    assert.ok(cmd.includes('O\u2019\u2019Brien \u2018\u2018x\u2019\u2019'), cmd);
  });

  test('the local-install token uses $env:CLAUDE_PROJECT_DIR', () => {
    const cmd = hooksSurface.buildPowerShellLocalHookCommand({ localPrefix: '"$CLAUDE_PROJECT_DIR"/.claude', hookFile: GUARD, execPath: EXEC_PATH });
    assert.ok(cmd.startsWith('& '), cmd);
    assert.ok(cmd.endsWith(`"$env:CLAUDE_PROJECT_DIR/.claude/hooks/${GUARD}"` + EXIT), cmd);
    assert.doesNotMatch(cmd, POSIX_ONLY);
  });

  test('an anchored local token with special characters stays one expression', () => {
    for (const dir of ['.cl$aude', '.cl`aude', '.cl\u201Caude']) {
      const cmd = hooksSurface.buildPowerShellLocalHookCommand({ localPrefix: `"$CLAUDE_PROJECT_DIR"/${dir}`, hookFile: GUARD, execPath: EXEC_PATH });
      assert.ok(cmd.includes(`($env:CLAUDE_PROJECT_DIR + '/${dir}/hooks/${GUARD}')`), cmd);
    }
  });

  test('property: the script token round-trips any path', () => {
    const dirChars = fc.constantFrom(...'abcXYZ019 \'$"`&;()%._-{}\u2018\u2019\u201A\u201B\u201C\u201D'.split(''));
    fc.assert(fc.property(fc.array(dirChars, { minLength: 1, maxLength: 20 }).map((a) => a.join('')), (dir) => {
      const cmd = hooksSurface.buildHookCommand(`C:/cfg/${dir}`, GUARD, win());
      const m = cmd.match(/\) '(.*)'; exit \$\(if \(\$null -ne \$LASTEXITCODE\) \{ \$LASTEXITCODE \} else \{ 1 \}\)$/);
      assert.ok(m, cmd);
      const body = m[1];
      // Every quote delimiter inside the literal must appear doubled.
      assert.doesNotMatch(body.replace(/(['\u2018\u2019\u201A\u201B])\1/g, ''), /['\u2018\u2019\u201A\u201B]/);
      assert.equal(body.replace(/(['\u2018\u2019\u201A\u201B])\1/g, '$1'), `C:/cfg/${dir}/hooks/${GUARD}`);
    }), { numRuns: 100 });
  });
});

describe('#5850 rewriter and settings projection', () => {
  test('a local-install chain converts to the $env:CLAUDE_PROJECT_DIR form', () => {
    const local = shellCmdProjection.projectShellCommandText({
      runnerToken: hooksSurface.buildNodeRunnerChainToken({ execPath: EXEC_PATH }),
      argTokens: [`"$CLAUDE_PROJECT_DIR"/.claude/hooks/${GUARD}`],
      runtime: 'claude',
      platform: 'win32',
    });
    const settings = settingsWith([local]);
    assert.equal(hooksSurface.rewriteLegacyManagedNodeHookCommands(settings, hooksSurface.buildNodeRunnerChainToken(), win()), true);
    const cmd = settings.hooks.PreToolUse[0].hooks[0].command;
    assert.ok(cmd.endsWith(`"$env:CLAUDE_PROJECT_DIR/.claude/hooks/${GUARD}"` + EXIT), cmd);
  });

  test('legacy bare-node and foreign-absolute entries convert to the PowerShell runner', () => {
    const settings = settingsWith([
      `node "C:/Users/u/.claude/hooks/${GUARD}"`,
      `"/usr/local/bin/node" "C:/Users/u/.claude/hooks/${GUARD}"`,
      `& "/usr/local/bin/node" "C:/Users/u/.claude/hooks/${GUARD}"`,
    ]);
    assert.equal(hooksSurface.rewriteLegacyManagedNodeHookCommands(settings, hooksSurface.buildNodeRunnerChainToken(), win()), true);
    for (const entry of settings.hooks.PreToolUse) {
      assert.ok(entry.hooks[0].command.startsWith('& ((@('), entry.hooks[0].command);
      assert.ok(entry.hooks[0].command.endsWith(`'C:/Users/u/.claude/hooks/${GUARD}'` + EXIT), entry.hooks[0].command);
    }
  });

  test('a user-authored hook is untouched', () => {
    const settings = settingsWith(['node /home/me/my-custom-hook.js']);
    assert.equal(hooksSurface.rewriteLegacyManagedNodeHookCommands(settings, hooksSurface.buildNodeRunnerChainToken(), win()), false);
    assert.equal(settings.hooks.PreToolUse[0].hooks[0].command, 'node /home/me/my-custom-hook.js');
  });

  test('the bash resolver shape converts for plain and $HOME-relative scripts', () => {
    const plain = `bash "C:/Users/u/.claude/hooks/gsd-node-runner.sh" "/usr/bin/node" "C:/Users/u/.claude/hooks/${GUARD}"`;
    const portable = `bash "$HOME/.claude/hooks/gsd-node-runner.sh" "/usr/bin/node" "$HOME/.claude/hooks/${GUARD}"`;
    const settings = settingsWith([plain, portable]);
    assert.equal(hooksSurface.rewriteLegacyManagedNodeHookCommands(settings, hooksSurface.buildNodeRunnerChainToken(), win()), true);
    assert.ok(settings.hooks.PreToolUse[0].hooks[0].command.startsWith('& '));
    assert.ok(settings.hooks.PreToolUse[1].hooks[0].command.endsWith(`"$HOME/.claude/hooks/${GUARD}"${EXIT}`), settings.hooks.PreToolUse[1].hooks[0].command);
  });

  test('a managed statusLine chain converts to the shell-neutral PowerShell spelling and the second run is a no-op', () => {
    const settings = { hooks: {}, statusLine: { type: 'command', command: oldChain.replace(GUARD, 'gsd-statusline.js') } };
    assert.equal(hooksSurface.rewriteLegacyManagedNodeHookCommands(settings, hooksSurface.buildNodeRunnerChainToken(), win()), true);
    const cmd = settings.statusLine.command;
    assert.ok(cmd.startsWith('powershell -NoProfile -Command "if (Test-Path -LiteralPath '), cmd);
    assert.ok(cmd.includes("& node 'C:/Users/u/.claude/hooks/gsd-statusline.js'"), cmd);
    assert.equal(hooksSurface.rewriteLegacyManagedNodeHookCommands(settings, hooksSurface.buildNodeRunnerChainToken(), win()), false);
  });

  test('on a non-Windows host a chain entry is left alone', () => {
    const settings = settingsWith([oldChain]);
    assert.equal(hooksSurface.rewriteLegacyManagedNodeHookCommands(settings, hooksSurface.buildNodeRunnerChainToken(), { platform: 'linux', runtime: 'claude' }), false);
    assert.equal(settings.hooks.PreToolUse[0].hooks[0].command, oldChain);
  });

  test('projectPowerShellHookShell sets shell only on PowerShell commands and is idempotent', () => {
    const ps = hooksSurface.buildHookCommand(CONFIG_DIR, GUARD, win());
    const settings = settingsWith([ps, oldChain]);
    assert.equal(hooksSurface.projectPowerShellHookShell(settings), true);
    assert.equal(settings.hooks.PreToolUse[0].hooks[0].shell, 'powershell');
    assert.equal('shell' in settings.hooks.PreToolUse[1].hooks[0], false);
    assert.equal(hooksSurface.projectPowerShellHookShell(settings), false);
  });
});

describe('#5850 stamping and recognition end to end', () => {
  test('a PowerShell-shaped command for a user-authored script is not stamped', () => {
    const settings = settingsWith([hooksSurface.buildHookCommand(CONFIG_DIR, 'my-own-hook.js', win())]);
    assert.equal(hooksSurface.projectPowerShellHookShell(settings), false);
    assert.equal('shell' in settings.hooks.PreToolUse[0].hooks[0], false);
  });

  test('isManagedHookCommand with a configDir holding a quote delimiter still recognizes the PowerShell command', () => {
    for (const dir of ['C:/Users/O\u2019Brien/.claude', "C:/Users/O'Brien/.claude"]) {
      const cmd = hooksSurface.buildHookCommand(dir, GUARD, win());
      assert.equal(shellCmdProjection.isManagedHookCommand(cmd, { surface: 'settings-json', configDir: dir }), true, cmd);
    }
  });

  test('every JS hook the installer registers on win32 claude is stamped shell powershell', () => {
    const scenarios = require('./fixtures/hook-registration/run-scenarios.cjs');
    const rt = scenarios.settingsJsonRuntimes().find((r) => r.id === 'claude');
    const out = scenarios.runOne(rt, scenarios.scenarioSpecs(rt)['global/win32-all-present']);
    assert.equal(hooksSurface.projectPowerShellHookShell(out.settings), true);
    let js = 0;
    for (const entries of Object.values(out.settings.hooks)) {
      for (const entry of entries) {
        for (const h of entry.hooks) {
          if (!/\.js'/.test(h.command)) continue;
          js += 1;
          assert.equal(h.shell, 'powershell', h.command);
          assert.ok(h.command.startsWith('& '), h.command);
          assert.doesNotMatch(h.command, POSIX_ONLY);
        }
      }
    }
    assert.ok(js > 0, 'the scenario registered no JS hooks');
  });

  test('uninstall recognizes both the PowerShell and the chain shape', () => {
    const ps = hooksSurface.buildHookCommand(CONFIG_DIR, GUARD, win());
    const chain = hooksSurface.buildHookCommand(CONFIG_DIR, GUARD, win({ hookShell: 'bash' }));
    for (const cmd of [ps, chain]) {
      assert.equal(shellCmdProjection.isManagedHookCommand(cmd, { surface: 'settings-json', configDir: CONFIG_DIR }), true, cmd);
    }
  });
});

describe('#5850 statusLine spelling', () => {
  test('buildHookCommand with statusLine emits a spelling both Git Bash and PowerShell run', () => {
    const cmd = hooksSurface.buildHookCommand(CONFIG_DIR, 'gsd-statusline.js', win({ statusLine: true }));
    assert.ok(cmd.startsWith('powershell -NoProfile -Command "if (Test-Path -LiteralPath '), cmd);
    // Inside bash double quotes `$`, backtick and backslash are special: the body carries none.
    assert.doesNotMatch(cmd, /[`$\\]/);
    assert.doesNotMatch(cmd, POSIX_ONLY);
    assert.equal(shellCmdProjection.isManagedHookCommand(cmd, { surface: 'settings-json' }), true);
  });

  test('a statusLine path bash would expand is skipped, not written broken', () => {
    for (const dir of ['C:/Users/$x/.claude', 'C:/Users/a`b/.claude', 'C:/Users/a"b/.claude']) {
      assert.equal(hooksSurface.buildHookCommand(dir, 'gsd-statusline.js', win({ statusLine: true })), null, dir);
    }
  });

  test('a portable install still gets an absolute-path statusLine', () => {
    const home = os.homedir().replace(/\\/g, '/');
    const cmd = hooksSurface.buildHookCommand(`${home}/.claude`, 'gsd-statusline.js', win({ portableHooks: true, statusLine: true }));
    assert.ok(typeof cmd === 'string' && cmd.startsWith('powershell -NoProfile -Command "'), cmd);
    assert.ok(cmd.includes(`'${home}/.claude/hooks/gsd-statusline.js'`), cmd);
    const entrypoints = [];
    hooksSurface.buildHookCommand(`${home}/.claude`, 'gsd-statusline.js', win({ portableHooks: true, statusLine: true, configuredEntrypoints: entrypoints }));
    assert.equal(entrypoints.length, 1);
    assert.equal(entrypoints[0].scriptPath, path.join(`${home}/.claude`, 'hooks', 'gsd-statusline.js'));
    assert.doesNotMatch(cmd, /[`$\\]/);
  });

  test('statusLine is ignored off win32 and for other runtimes', () => {
    const linux = hooksSurface.buildHookCommand('/home/u/.claude', 'gsd-statusline.js', { platform: 'linux', runtime: 'claude', execPath: '/usr/bin/node', statusLine: true });
    assert.ok(linux.startsWith('"$(for n in '), linux);
  });
});

describe('#5850 a PowerShell entry reaching a POSIX host converges back', () => {
  const linux = { platform: 'linux', runtime: 'claude' };

  test('a PowerShell runner entry (and its shell key) becomes the POSIX chain', () => {
    const ps = hooksSurface.buildHookCommand(CONFIG_DIR, GUARD, win());
    const settings = settingsWith([ps]);
    settings.hooks.PreToolUse[0].hooks[0].shell = 'powershell';
    const runner = hooksSurface.buildNodeRunnerChainToken({ execPath: '/usr/bin/node' });
    assert.equal(hooksSurface.rewriteLegacyManagedNodeHookCommands(settings, runner, linux), true);
    const hook = settings.hooks.PreToolUse[0].hooks[0];
    assert.ok(hook.command.startsWith('"$(for n in '), hook.command);
    assert.ok(hook.command.endsWith(`"C:/Users/u/.claude/hooks/${GUARD}"`), hook.command);
    assert.equal('shell' in hook, false);
    assert.equal(hooksSurface.rewriteLegacyManagedNodeHookCommands(settings, runner, linux), false);
  });

  test('local and portable PowerShell spellings convert back to their POSIX anchors', () => {
    const local = hooksSurface.buildPowerShellLocalHookCommand({ localPrefix: '"$CLAUDE_PROJECT_DIR"/.claude', hookFile: GUARD, execPath: EXEC_PATH });
    const home = os.homedir().replace(/\\/g, '/');
    const portable = hooksSurface.buildHookCommand(`${home}/.claude`, GUARD, win({ portableHooks: true }));
    const settings = settingsWith([local, portable]);
    const runner = hooksSurface.buildNodeRunnerChainToken({ execPath: '/usr/bin/node' });
    assert.equal(hooksSurface.rewriteLegacyManagedNodeHookCommands(settings, runner, linux), true);
    const [localHook, portableHook] = settings.hooks.PreToolUse.map((e) => e.hooks[0].command);
    assert.ok(localHook.endsWith(`"$CLAUDE_PROJECT_DIR"/.claude/hooks/${GUARD}`), localHook);
    assert.ok(portableHook.endsWith(`"$HOME/.claude/hooks/${GUARD}"`), portableHook);
  });

  test('a PowerShell statusLine becomes the POSIX chain again', () => {
    const status = hooksSurface.buildHookCommand(CONFIG_DIR, 'gsd-statusline.js', win({ statusLine: true }));
    const settings = { hooks: {}, statusLine: { type: 'command', command: status } };
    const runner = hooksSurface.buildNodeRunnerChainToken({ execPath: '/usr/bin/node' });
    assert.equal(hooksSurface.rewriteLegacyManagedNodeHookCommands(settings, runner, linux), true);
    assert.ok(settings.statusLine.command.startsWith('"$(for n in '), settings.statusLine.command);
  });

  test('a PowerShell entry whose path bash would expand is left alone, not mis-converted', () => {
    for (const dir of ['C:/Users/a$b/.claude', 'C:/Users/a`b/.claude']) {
      const ps = hooksSurface.buildHookCommand(dir, GUARD, win());
      const settings = settingsWith([ps]);
      const runner = hooksSurface.buildNodeRunnerChainToken({ execPath: '/usr/bin/node' });
      assert.equal(hooksSurface.rewriteLegacyManagedNodeHookCommands(settings, runner, linux), false, dir);
      assert.equal(settings.hooks.PreToolUse[0].hooks[0].command, ps);
    }
  });

  test('refusals cover the portable $HOME, $env:CLAUDE_PROJECT_DIR and statusLine spellings', () => {
    const home = os.homedir().replace(/\\/g, '/');
    const runner = hooksSurface.buildNodeRunnerChainToken({ execPath: '/usr/bin/node' });
    const entries = [
      hooksSurface.buildHookCommand(`${home}/my$dir/.claude`, GUARD, win({ portableHooks: true })),
      hooksSurface.buildHookCommand(`${home}/my"dir/.claude`, GUARD, win({ portableHooks: true })),
      hooksSurface.buildHookCommand(`${home}/my\`dir/.claude`, GUARD, win({ portableHooks: true })),
      hooksSurface.buildPowerShellLocalHookCommand({ localPrefix: '"$CLAUDE_PROJECT_DIR"/.cl$aude', hookFile: GUARD, execPath: EXEC_PATH }),
    ];
    for (const ps of entries) {
      assert.ok(ps.startsWith('& '), ps);
      const settings = settingsWith([ps]);
      assert.equal(hooksSurface.rewriteLegacyManagedNodeHookCommands(settings, runner, linux), false, ps);
      assert.equal(settings.hooks.PreToolUse[0].hooks[0].command, ps);
    }
    const status = `powershell -NoProfile -Command "if (Test-Path -LiteralPath 'D:/n.exe') { & 'D:/n.exe' 'C:/a$b/hooks/gsd-statusline.js' } else { & node 'C:/a$b/hooks/gsd-statusline.js' }"`;
    const settings = { hooks: {}, statusLine: { type: 'command', command: status } };
    assert.equal(hooksSurface.rewriteLegacyManagedNodeHookCommands(settings, runner, linux), false);
    assert.equal(settings.statusLine.command, status);
  });

  test('a PowerShell entry is left alone on win32 for a runtime that never writes it', () => {
    const ps = hooksSurface.buildHookCommand(CONFIG_DIR, GUARD, win());
    const settings = settingsWith([ps]);
    assert.equal(hooksSurface.rewriteLegacyManagedNodeHookCommands(settings, hooksSurface.buildNodeRunnerChainToken(), { platform: 'win32', runtime: 'gemini' }), false);
  });
});

describe('#5850 token edge cases', () => {
  test('a legacy token carrying an unexpanded shell variable is left alone', () => {
    const cmd = `node "$CLAUDE_PROJECT_DIR/.claude/hooks/${GUARD}"`;
    const settings = settingsWith([cmd]);
    assert.equal(hooksSurface.rewriteLegacyManagedNodeHookCommands(settings, hooksSurface.buildNodeRunnerChainToken(), win()), false);
    assert.equal(settings.hooks.PreToolUse[0].hooks[0].command, cmd);
  });

  test('a real configDir containing a dollar sign is a literal path', () => {
    const cmd = hooksSurface.buildHookCommand('C:/Users/a$b/.claude', GUARD, win());
    assert.ok(cmd.includes(`'C:/Users/a$b/.claude/hooks/${GUARD}'`), cmd);
  });

  test('projectPortableHookBaseDir respects the home boundary', () => {
    assert.equal(shellCmdProjection.projectPortableHookBaseDir({ configDir: '/home/u/.claude', homeDir: '/home/u' }), '$HOME/.claude');
    assert.equal(shellCmdProjection.projectPortableHookBaseDir({ configDir: '/home/ux/.claude', homeDir: '/home/u' }), '/home/ux/.claude');
  });

  test('isManagedHookCommand undoes quote doubling only inside the single-quoted literal', () => {
    const cmd = `& ((@('D:/n.exe') + @()) | Select-Object -First 1) 'C:/Users/O''Brien/.claude/hooks/${GUARD}'`;
    assert.equal(shellCmdProjection.isManagedHookCommand(cmd, { surface: 'settings-json', configDir: "C:/Users/O'Brien/.claude" }), true);
    const outside = `node C:/Users/O''Brien/.claude/hooks/${GUARD}`;
    assert.equal(shellCmdProjection.isManagedHookCommand(outside, { surface: 'settings-json', configDir: "C:/Users/O'Brien/.claude" }), false);
  });

  test('only .exe node results are launched (a .cmd shim would swallow the exit code)', () => {
    assert.ok(hooksSurface.buildHookCommand(CONFIG_DIR, GUARD, win()).includes("Where-Object { $_.Source -like '*.exe' }"));
  });
});

const WIN32_INSTALL_PROBE = `
Object.defineProperty(process, 'platform', { value: 'win32' });
const path = require('node:path');
const fs = require('node:fs');
const { install, finishInstall } = require(path.join(process.env.PROBE_REPO, 'bin', 'install.js'));
const result = install(true, 'claude');
finishInstall(result.settingsPath, result.settings, result.statuslineCommand, true, 'claude', true, result.configDir);
const settings = JSON.parse(fs.readFileSync(result.settingsPath, 'utf8'));
const hooks = [];
for (const entries of Object.values(settings.hooks || {})) {
  for (const entry of entries) for (const h of entry.hooks || []) hooks.push(h);
}
process.stdout.write('PROBE_JSON ' + JSON.stringify({
  total: hooks.length,
  chain: hooks.filter((h) => /\\$\\(for n in/.test(h.command)).length,
  powershell: hooks.filter((h) => h.command.startsWith('& ')).length,
  unstamped: hooks.filter((h) => h.command.startsWith('& ') && h.shell !== 'powershell').length,
  statusLine: settings.statusLine && settings.statusLine.command,
}) + '\\n');
`;

describe('#5850 the installer writes the shell key', () => {
  test('install + finishInstall on a win32 host write PowerShell hooks stamped shell powershell and a neutral statusLine', (t) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-5850-win32-'));
    t.after(() => helpers.cleanup(home));
    const result = runNode(['-e', WIN32_INSTALL_PROBE], {
      cwd: path.join(__dirname, '..'),
      env: helpers.installSpawnEnv({ HOME: home, USERPROFILE: home, PROBE_REPO: path.join(__dirname, '..'), GSD_TEST_MODE: '1' }),
      timeoutMs: INSTALL_TIMEOUT_MS,
    });
    const line = result.stdout.split('\n').find((entry) => entry.startsWith('PROBE_JSON '));
    assert.ok(line, `probe reported nothing: outcome=${result.outcome} exitCode=${result.exitCode} stderr=${result.stderr.slice(-800)}`);
    const probe = JSON.parse(line.slice('PROBE_JSON '.length));
    assert.ok(probe.powershell > 0, JSON.stringify(probe));
    assert.equal(probe.chain, 0, JSON.stringify(probe));
    assert.equal(probe.unstamped, 0, JSON.stringify(probe));
    assert.ok(String(probe.statusLine).startsWith('powershell -NoProfile -Command "if (Test-Path'), JSON.stringify(probe));
  });
});
