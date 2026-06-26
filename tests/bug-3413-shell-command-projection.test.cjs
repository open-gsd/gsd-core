'use strict';

process.env.GSD_TEST_MODE = '1';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const projection = require(path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'shell-command-projection.cjs'));
const install = require(path.join(__dirname, '..', 'bin', 'install.js'));

const {
  hookCommandNeedsPowerShellCallOperator,
  formatHookCommandForRuntime,
  isManagedHookBasename,
  isManagedHookCommand,
  projectLocalHookPrefix,
  projectLegacySettingsHookCommand,
  projectPortableHookBaseDir,
} = projection;
const { buildHookCommand, rewriteLegacyManagedNodeHookCommands } = install;

describe('bug #3413: Shell Command Projection Module uses runtime-aware hook policy', () => {
  test('Gemini on Windows requires PowerShell call operator', () => {
    assert.equal(
      hookCommandNeedsPowerShellCallOperator({ platform: 'win32', runtime: 'gemini' }),
      true,
    );
    assert.equal(
      formatHookCommandForRuntime('"C:/node.exe" "C:/hook.js"', { platform: 'win32', runtime: 'gemini' }),
      '& "C:/node.exe" "C:/hook.js"',
    );
  });

  test('Claude on Windows stays shell-neutral', () => {
    assert.equal(
      hookCommandNeedsPowerShellCallOperator({ platform: 'win32', runtime: 'claude' }),
      false,
    );
    assert.equal(
      formatHookCommandForRuntime('"C:/node.exe" "C:/hook.js"', { platform: 'win32', runtime: 'claude' }),
      '"C:/node.exe" "C:/hook.js"',
    );
  });

  test('runtime omitted stays conservative (no PowerShell prefix)', () => {
    assert.equal(
      formatHookCommandForRuntime('"C:/node.exe" "C:/hook.js"', { platform: 'win32' }),
      '"C:/node.exe" "C:/hook.js"',
    );
  });
});

describe('bug #3413: installer hook surfaces consume runtime-aware projection', () => {
  test('buildHookCommand emits shell-neutral Claude hook command on Windows', () => {
    const cmd = buildHookCommand('C:/Users/me/.claude', 'gsd-check-update.js', {
      platform: 'win32',
      runtime: 'claude',
    });
    assert.equal(cmd.startsWith('& '), false, `Claude hook command must not use PowerShell prefix: ${cmd}`);
  });

  test('rewriteLegacyManagedNodeHookCommands removes stale PowerShell prefix for Claude on Windows', () => {
    const settings = {
      hooks: {
        SessionStart: [{
          hooks: [{ type: 'command', command: '& "/usr/local/bin/node" "C:/Users/me/.claude/hooks/gsd-check-update.js"' }],
        }],
      },
    };
    const changed = rewriteLegacyManagedNodeHookCommands(settings, '"/usr/local/bin/node"', {
      platform: 'win32',
      runtime: 'claude',
    });
    assert.equal(changed, true);
    assert.equal(
      settings.hooks.SessionStart[0].hooks[0].command,
      '"/usr/local/bin/node" "C:/Users/me/.claude/hooks/gsd-check-update.js"',
    );
  });
});

describe('bug #3439: shell projection module owns managed-hook policy and legacy rewrite projection', () => {
  test('isManagedHookBasename is surface-aware', () => {
    assert.equal(isManagedHookBasename('/x/hooks/gsd-check-update.js', { surface: 'settings-json' }), true);
    assert.equal(isManagedHookBasename('/x/hooks/gsd-statusline.js', { surface: 'settings-json' }), true);
    assert.equal(isManagedHookBasename('/x/hooks/gsd-statusline.js', { surface: 'codex-toml' }), false);
    assert.equal(isManagedHookBasename('/x/hooks/custom-hook.js', { surface: 'settings-json' }), false);
  });

  test('projectLegacySettingsHookCommand preserves non-Windows script token shape', () => {
    const command = projectLegacySettingsHookCommand({
      absoluteRunner: '"/usr/local/bin/node"',
      scriptPath: '/x/hooks/gsd-statusline.js',
      scriptToken: "'/x/hooks/gsd-statusline.js'",
      platform: 'linux',
      runtime: 'claude',
    });
    assert.equal(command, `"/usr/local/bin/node" '/x/hooks/gsd-statusline.js'`);
  });

  test('projectLegacySettingsHookCommand normalizes Windows managed paths and runtime wrapper policy', () => {
    const command = projectLegacySettingsHookCommand({
      absoluteRunner: '"C:/nvm4w/nodejs/node.exe"',
      scriptPath: 'C:\\Users\\me\\.gemini\\hooks\\gsd-prompt-guard.js',
      scriptToken: "'C:\\Users\\me\\.gemini\\hooks\\gsd-prompt-guard.js'",
      platform: 'win32',
      runtime: 'gemini',
    });
    assert.equal(command, '& "C:/nvm4w/nodejs/node.exe" "C:/Users/me/.gemini/hooks/gsd-prompt-guard.js"');
  });

  test('projectLocalHookPrefix centralizes runtime-specific project-dir interpolation policy', () => {
    assert.equal(projectLocalHookPrefix({ runtime: 'gemini', dirName: '.gemini' }), '.gemini');
    assert.equal(projectLocalHookPrefix({ runtime: 'antigravity', dirName: '.agents' }), '.agents');
    assert.equal(
      projectLocalHookPrefix({ runtime: 'claude', dirName: '.claude' }),
      '"$CLAUDE_PROJECT_DIR"/.claude',
    );
  });

  test('projectPortableHookBaseDir centralizes $HOME interpolation policy', () => {
    assert.equal(
      projectPortableHookBaseDir({
        configDir: '/Users/me/.claude',
        homeDir: '/Users/me',
      }),
      '$HOME/.claude',
    );
    assert.equal(
      projectPortableHookBaseDir({
        configDir: 'C:\\Users\\me\\.claude',
        homeDir: 'C:\\Users\\me',
      }),
      '$HOME/.claude',
    );
    assert.equal(
      projectPortableHookBaseDir({
        configDir: '/opt/custom/.claude',
        homeDir: '/Users/me',
      }),
      '/opt/custom/.claude',
    );
  });

  test('isManagedHookCommand classifies managed settings hooks and leaves user commands untouched', () => {
    assert.equal(
      isManagedHookCommand('"/usr/local/bin/node" "/Users/me/.claude/hooks/gsd-statusline.js"', {
        surface: 'settings-json',
      }),
      true,
    );
    assert.equal(
      isManagedHookCommand('"C:/Program Files/Git/bin/bash.exe" "C:/Users/me/.claude/hooks/gsd-session-state.sh"', {
        surface: 'settings-json',
      }),
      true,
    );
    assert.equal(
      isManagedHookCommand('bash /Users/me/.claude/hooks/custom-lint.sh', {
        surface: 'settings-json',
      }),
      false,
    );
  });

  test('isManagedHookCommand supports codex surfaces and optional legacy alias matching', () => {
    const command = '"/usr/local/bin/node" "/Users/me/.codex/hooks/gsd-check-update.js"';
    assert.equal(
      isManagedHookCommand(command, {
        surface: 'codex-toml',
      }),
      true,
    );
    assert.equal(
      isManagedHookCommand('"/usr/local/bin/node" "/Users/me/.codex/hooks/gsd-update-check.js"', {
        surface: 'codex-toml',
      }),
      false,
    );
    assert.equal(
      isManagedHookCommand('"/usr/local/bin/node" "/Users/me/.codex/hooks/gsd-update-check.js"', {
        surface: 'codex-toml',
        includeLegacyAliases: true,
      }),
      true,
    );
  });
});

describe('#1693 regression: Windows legacy-node rewrite must not double-quote a "$CLAUDE_PROJECT_DIR"-anchored local hook path', () => {
  const winRunner = '"C:/Program Files/nodejs/node.exe"';

  // WHY: a local-install hook path already carries a `"$CLAUDE_PROJECT_DIR"`
  // anchored prefix (only the variable quoted, rest bare). On Windows the legacy
  // rewrite previously JSON.stringify'd the whole token, yielding
  // `"\"$CLAUDE_PROJECT_DIR\"/..."`. node then received an argument starting with
  // a literal `"`, treated it as relative, and died with MODULE_NOT_FOUND —
  // breaking every node managed hook at once (self-locking deadlock).
  test('projectLegacySettingsHookCommand emits the anchored path verbatim, not re-quoted', () => {
    const anchored = '"$CLAUDE_PROJECT_DIR"/.claude/hooks/gsd-context-monitor.js';
    const command = projectLegacySettingsHookCommand({
      absoluteRunner: winRunner,
      scriptPath: anchored,
      scriptToken: anchored,
      platform: 'win32',
      runtime: 'claude',
    });
    assert.equal(
      command,
      '"C:/Program Files/nodejs/node.exe" "$CLAUDE_PROJECT_DIR"/.claude/hooks/gsd-context-monitor.js',
    );
    assert.ok(!command.includes('\\"'), 'must not contain escaped double-quotes');
  });

  // WHY: the fix must be surgical — a BARE absolute Windows path (no anchored
  // prefix) can contain spaces ("Program Files") and still REQUIRES quoting.
  test('projectLegacySettingsHookCommand still quotes a bare absolute Windows path', () => {
    const abs = 'C:/Program Files App/.claude/hooks/gsd-context-monitor.js';
    const command = projectLegacySettingsHookCommand({
      absoluteRunner: winRunner,
      scriptPath: abs,
      scriptToken: JSON.stringify(abs),
      platform: 'win32',
      runtime: 'claude',
    });
    assert.equal(
      command,
      '"C:/Program Files/nodejs/node.exe" "C:/Program Files App/.claude/hooks/gsd-context-monitor.js"',
    );
  });

  // WHY: the anchored short-circuit is scoped to win32. On POSIX the rewrite
  // already preserved the caller's original `scriptToken` and never had the
  // double-quote bug, so that behavior must be left byte-identical. scriptPath
  // is anchored but scriptToken is a DISTINCT single-quoted value: if the
  // win32 gate were removed, the anchored short-circuit would emit scriptPath
  // and this assertion would fail — that is what pins the gate.
  test('projectLegacySettingsHookCommand preserves the original scriptToken for anchored paths on POSIX', () => {
    const command = projectLegacySettingsHookCommand({
      absoluteRunner: '"/usr/local/bin/node"',
      scriptPath: '"$CLAUDE_PROJECT_DIR"/.claude/hooks/gsd-statusline.js',
      scriptToken: "'/x/hooks/gsd-statusline.js'",
      platform: 'linux',
      runtime: 'claude',
    });
    assert.equal(command, `"/usr/local/bin/node" '/x/hooks/gsd-statusline.js'`);
  });

  // WHY: end-to-end through the installer rewrite — the actual #2979 path that
  // ran during the user's 1.5.0 -> 1.6.0 local update. Managed node hooks get
  // the absolute runner + clean anchored path; a non-node-prefixed managed .sh
  // hook (already correct) is left untouched.
  test('rewriteLegacyManagedNodeHookCommands produces clean anchored node commands on Windows', () => {
    const settings = {
      hooks: {
        PostToolUse: [
          {
            hooks: [
              { command: 'node "$CLAUDE_PROJECT_DIR"/.claude/hooks/gsd-context-monitor.js' },
            ],
          },
        ],
      },
    };
    const changed = rewriteLegacyManagedNodeHookCommands(settings, winRunner, {
      platform: 'win32',
      runtime: 'claude',
    });
    assert.equal(changed, true);
    const rewritten = settings.hooks.PostToolUse[0].hooks[0].command;
    assert.equal(
      rewritten,
      '"C:/Program Files/nodejs/node.exe" "$CLAUDE_PROJECT_DIR"/.claude/hooks/gsd-context-monitor.js',
    );
    assert.ok(!rewritten.includes('\\"'), 'rewritten command must not contain escaped double-quotes');
  });
});
