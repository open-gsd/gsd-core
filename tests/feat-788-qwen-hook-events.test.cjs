// allow-test-rule: source-text-is-the-product
// The hook .sh files are deployed verbatim — their text IS what the runtime
// executes. Asserting that text carries the correct hookEventName and opt-in
// guard tests the deployed contract at the source level.

/**
 * Feature #788 — Expanded Qwen Code hook-event coverage.
 *
 * Qwen Code (and Claude Code) support 15 hook events. Before #788, gsd only
 * registered SessionStart and PostToolUse. This test suite guards the 4 newly
 * added events:
 *
 *   PreCompact       → gsd-pre-compact.sh
 *   SubagentStop     → gsd-subagent-state.sh
 *   Stop             → gsd-stop-state.sh
 *   UserPromptSubmit → gsd-user-prompt-submit.sh
 *
 * Covers:
 *   - Hook script source carries the correct hookEventName string
 *   - Hook script source contains the opt-in community guard
 *   - Hook files are present in hooks/dist/ after build
 *   - managed-hooks-registry.cjs includes all 4 new hooks
 *   - GSD_UNINSTALL_HOOKS exported from install.js includes all 4 new hook files
 *   - Uninstall event list in install.js covers the 4 new event names
 *   - Qwen settings.json gets PreCompact, SubagentStop, Stop, UserPromptSubmit keys
 *     after a simulated install (unit-level: calls install() directly)
 *   - Claude settings.json also gets the same 4 keys (same code path)
 */

'use strict';

process.env.GSD_TEST_MODE = '1';

const { describe, test, before, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { createTempDir, cleanup } = require('./helpers.cjs');
const {
  install,
  GSD_UNINSTALL_HOOKS,
} = require('../bin/install.js');

const BUILD_SCRIPT = path.join(__dirname, '..', 'scripts', 'build-hooks.js');
const HOOKS_SRC = path.join(__dirname, '..', 'hooks');
const HOOKS_DIST = path.join(HOOKS_SRC, 'dist');
const REPO_ROOT = path.join(__dirname, '..');

// ─── Constants ────────────────────────────────────────────────────────────────

const NEW_HOOK_FILES = [
  'gsd-pre-compact.sh',
  'gsd-stop-state.sh',
  'gsd-subagent-state.sh',
  'gsd-user-prompt-submit.sh',
];

const NEW_HOOK_EVENTS = ['PreCompact', 'SubagentStop', 'Stop', 'UserPromptSubmit'];

const HOOK_EVENT_MAP = {
  'gsd-pre-compact.sh':       'PreCompact',
  'gsd-stop-state.sh':        'Stop',
  'gsd-subagent-state.sh':    'SubagentStop',
  'gsd-user-prompt-submit.sh':'UserPromptSubmit',
};

// ─── Section 1: Hook source contract ─────────────────────────────────────────

describe('#788: new hook scripts carry correct hookEventName string', () => {
  for (const [hookFile, eventName] of Object.entries(HOOK_EVENT_MAP)) {
    test(`${hookFile} contains hookEventName: "${eventName}"`, () => {
      const src = path.join(HOOKS_SRC, hookFile);
      assert.ok(fs.existsSync(src), `Source file must exist: ${src}`);
      const content = fs.readFileSync(src, 'utf8');
      assert.ok(
        content.includes(`hookEventName: "${eventName}"`),
        `${hookFile} must contain hookEventName: "${eventName}" — the runtime uses this for routing`
      );
    });
  }
});

describe('#788: new hook scripts carry opt-in community guard', () => {
  for (const hookFile of NEW_HOOK_FILES) {
    test(`${hookFile} checks hooks.community opt-in before acting`, () => {
      const src = path.join(HOOKS_SRC, hookFile);
      assert.ok(fs.existsSync(src), `Source file must exist: ${src}`);
      const content = fs.readFileSync(src, 'utf8');
      assert.ok(
        content.includes('hooks?.community') || content.includes('hooks.community'),
        `${hookFile} must check hooks.community opt-in — community hooks must be no-ops by default`
      );
    });
  }
});

describe('#788: new hook scripts carry gsd-hook-version stamp', () => {
  for (const hookFile of NEW_HOOK_FILES) {
    test(`${hookFile} has gsd-hook-version header`, () => {
      const src = path.join(HOOKS_SRC, hookFile);
      const content = fs.readFileSync(src, 'utf8');
      assert.ok(
        content.includes('gsd-hook-version:'),
        `${hookFile} must have a gsd-hook-version stamp (required for stale-hook detection)`
      );
    });
  }
});

// ─── Section 2: Build output ──────────────────────────────────────────────────

before(() => {
  execFileSync(process.execPath, [BUILD_SCRIPT], { encoding: 'utf-8', stdio: 'pipe' });
});

describe('#788: new hook files are present in hooks/dist/ after build', () => {
  for (const hookFile of NEW_HOOK_FILES) {
    test(`hooks/dist/${hookFile} exists after build`, () => {
      assert.ok(
        fs.existsSync(path.join(HOOKS_DIST, hookFile)),
        `${hookFile} must be in hooks/dist/ — add it to HOOKS_TO_COPY in scripts/build-hooks.js`
      );
    });
  }
});

describe('#788: new hook files in hooks/dist/ are executable', {
  skip: process.platform === 'win32' ? 'Windows has no POSIX file permissions' : false,
}, () => {
  for (const hookFile of NEW_HOOK_FILES) {
    test(`hooks/dist/${hookFile} is executable`, () => {
      const fullPath = path.join(HOOKS_DIST, hookFile);
      assert.ok(fs.existsSync(fullPath), `${hookFile} must exist in dist`);
      const stat = fs.statSync(fullPath);
      assert.ok(
        (stat.mode & 0o111) !== 0,
        `${hookFile} must have execute permission — missing +x causes hook invocation failures`
      );
    });
  }
});

// ─── Section 3: Registry consistency ─────────────────────────────────────────

describe('#788: managed-hooks-registry.cjs includes all 4 new hooks', () => {
  const { MANAGED_HOOKS } = require('../hooks/managed-hooks-registry.cjs');

  for (const hookFile of NEW_HOOK_FILES) {
    test(`MANAGED_HOOKS includes ${hookFile}`, () => {
      assert.ok(
        MANAGED_HOOKS.includes(hookFile),
        `${hookFile} must be in MANAGED_HOOKS — it drives stale-hook detection and the update-check worker`
      );
    });
  }
});

describe('#788: GSD_UNINSTALL_HOOKS includes all 4 new hook files', () => {
  for (const hookFile of NEW_HOOK_FILES) {
    test(`GSD_UNINSTALL_HOOKS includes ${hookFile}`, () => {
      assert.ok(
        GSD_UNINSTALL_HOOKS.includes(hookFile),
        `${hookFile} must be in GSD_UNINSTALL_HOOKS — otherwise uninstall leaves stale hook files`
      );
    });
  }
});

describe('#788: install.js uninstall event list covers all 4 new event names', () => {
  // Source-text assertion: the uninstall loop must include each new event name.
  // This guards against the common mistake of registering a hook under a new
  // event but forgetting to add that event to the cleanup list.
  const installSrc = fs.readFileSync(path.join(REPO_ROOT, 'bin', 'install.js'), 'utf8');

  for (const eventName of NEW_HOOK_EVENTS) {
    test(`uninstall loop in install.js includes '${eventName}'`, () => {
      // The uninstall loop iterates an array literal containing event names.
      // Assert each new event name appears in the source in that context.
      assert.ok(
        installSrc.includes(`'${eventName}'`),
        `install.js must include '${eventName}' in the uninstall event list (line ~7324) — ` +
          `otherwise hooks registered under ${eventName} are never cleaned up on uninstall`
      );
    });
  }
});

// ─── Section 3b: isManagedHookCommand recognises new basenames ────────────────
// Guards the adversarial finding: if new hook basenames are missing from
// MANAGED_HOOK_COMMAND_BASENAMES_BY_SURFACE['settings-json'], uninstall silently
// leaves stale settings.json entries pointing at missing files.

describe('#788: isManagedHookCommand recognises new hook basenames for uninstall', () => {
  const { isManagedHookCommand } = require('../gsd-core/bin/lib/shell-command-projection.cjs');

  for (const hookFile of NEW_HOOK_FILES) {
    test(`isManagedHookCommand returns true for ${hookFile} in settings-json surface`, () => {
      const cmd = `/home/user/.qwen/hooks/${hookFile}`;
      assert.ok(
        isManagedHookCommand(cmd, { surface: 'settings-json' }),
        `isManagedHookCommand must recognise ${hookFile} on settings-json surface — ` +
          `if missing, uninstall leaves stale settings.json entries after removing the hook file`
      );
    });
  }

  test('isManagedHookCommand still returns false for user-authored hooks', () => {
    const { isManagedHookCommand: fn } = require('../gsd-core/bin/lib/shell-command-projection.cjs');
    assert.equal(fn('bash /home/user/.qwen/hooks/my-custom-hook.sh', { surface: 'settings-json' }), false);
  });
});

// ─── Section 4: Install output — settings.json keys ──────────────────────────
// Unit-level: calls install() directly (GSD_TEST_MODE skips real file writes
// for hooks, so we pre-seed the hooks dir to let the file-existence guards pass)

describe('#788: Qwen install registers PreCompact, SubagentStop, Stop, UserPromptSubmit', () => {
  let tmpDir;
  let previousCwd;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-788-qwen-hooks-');
    previousCwd = process.cwd();
    process.chdir(tmpDir);

    // Pre-seed hooks/ so file-existence guards in install.js pass
    const hooksDir = path.join(tmpDir, '.qwen', 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    for (const hookFile of NEW_HOOK_FILES) {
      fs.writeFileSync(path.join(hooksDir, hookFile), '#!/usr/bin/env bash\n');
    }
  });

  afterEach(() => {
    process.chdir(previousCwd);
    cleanup(tmpDir);
  });

  test('Qwen settings.json contains all 4 new hook event keys', () => {
    const result = install(true, 'qwen');
    assert.ok(result.settings, 'install must return settings');
    assert.ok(result.settings.hooks, 'settings must have hooks');

    for (const eventName of NEW_HOOK_EVENTS) {
      assert.ok(
        Array.isArray(result.settings.hooks[eventName]),
        `settings.hooks.${eventName} must be an array after Qwen install (#788)`
      );
      assert.ok(
        result.settings.hooks[eventName].length > 0,
        `settings.hooks.${eventName} must have at least one entry after Qwen install (#788)`
      );
    }
  });

  test('Qwen PreCompact hook entry references gsd-pre-compact.sh', () => {
    const result = install(true, 'qwen');
    const preCompactEntries = result.settings.hooks.PreCompact || [];
    const hasHook = preCompactEntries.some(entry =>
      entry.hooks && entry.hooks.some(h => h.command && h.command.includes('gsd-pre-compact'))
    );
    assert.ok(hasHook, 'PreCompact hook entry must reference gsd-pre-compact.sh');
  });

  test('Qwen SubagentStop hook entry references gsd-subagent-state.sh', () => {
    const result = install(true, 'qwen');
    const entries = result.settings.hooks.SubagentStop || [];
    const hasHook = entries.some(entry =>
      entry.hooks && entry.hooks.some(h => h.command && h.command.includes('gsd-subagent-state'))
    );
    assert.ok(hasHook, 'SubagentStop hook entry must reference gsd-subagent-state.sh');
  });

  test('Qwen Stop hook entry references gsd-stop-state.sh', () => {
    const result = install(true, 'qwen');
    const entries = result.settings.hooks.Stop || [];
    const hasHook = entries.some(entry =>
      entry.hooks && entry.hooks.some(h => h.command && h.command.includes('gsd-stop-state'))
    );
    assert.ok(hasHook, 'Stop hook entry must reference gsd-stop-state.sh');
  });

  test('Qwen UserPromptSubmit hook entry references gsd-user-prompt-submit.sh', () => {
    const result = install(true, 'qwen');
    const entries = result.settings.hooks.UserPromptSubmit || [];
    const hasHook = entries.some(entry =>
      entry.hooks && entry.hooks.some(h => h.command && h.command.includes('gsd-user-prompt-submit'))
    );
    assert.ok(hasHook, 'UserPromptSubmit hook entry must reference gsd-user-prompt-submit.sh');
  });
});

describe('#788: Claude install also registers the 4 new hook events (shared code path)', () => {
  let tmpDir;
  let previousCwd;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-788-claude-hooks-');
    previousCwd = process.cwd();
    process.chdir(tmpDir);

    // Pre-seed hooks/ so file-existence guards pass
    const hooksDir = path.join(tmpDir, '.claude', 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    for (const hookFile of NEW_HOOK_FILES) {
      fs.writeFileSync(path.join(hooksDir, hookFile), '#!/usr/bin/env bash\n');
    }
  });

  afterEach(() => {
    process.chdir(previousCwd);
    cleanup(tmpDir);
  });

  test('Claude global settings.json contains all 4 new hook event keys', () => {
    const result = install(true, 'claude');
    assert.ok(result.settings && result.settings.hooks, 'install must return settings with hooks');

    for (const eventName of NEW_HOOK_EVENTS) {
      assert.ok(
        Array.isArray(result.settings.hooks[eventName]),
        `settings.hooks.${eventName} must be an array after Claude global install (#788)`
      );
    }
  });
});

describe('#788: new hooks are idempotent (re-install does not duplicate entries)', () => {
  let tmpDir;
  let previousCwd;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-788-idempotent-');
    previousCwd = process.cwd();
    process.chdir(tmpDir);

    const hooksDir = path.join(tmpDir, '.qwen', 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    for (const hookFile of NEW_HOOK_FILES) {
      fs.writeFileSync(path.join(hooksDir, hookFile), '#!/usr/bin/env bash\n');
    }
  });

  afterEach(() => {
    process.chdir(previousCwd);
    cleanup(tmpDir);
  });

  test('re-installing Qwen does not duplicate PreCompact, SubagentStop, Stop, UserPromptSubmit entries', () => {
    // First install
    const first = install(true, 'qwen');
    const settingsPath = first.settingsPath;
    // Write result back so second install reads it
    const { writeSettings } = require('../bin/install.js');
    writeSettings(settingsPath, first.settings);

    // Second install
    const second = install(true, 'qwen');

    for (const eventName of NEW_HOOK_EVENTS) {
      const entries = second.settings.hooks[eventName] || [];
      const gsdEntries = entries.filter(entry =>
        entry.hooks && entry.hooks.some(h => h.command && (
          h.command.includes('gsd-pre-compact') ||
          h.command.includes('gsd-subagent-state') ||
          h.command.includes('gsd-stop-state') ||
          h.command.includes('gsd-user-prompt-submit')
        ))
      );
      assert.strictEqual(
        gsdEntries.length <= 1,
        true,
        `${eventName} must not have duplicate GSD hook entries after re-install — found ${gsdEntries.length}`
      );
    }
  });
});
