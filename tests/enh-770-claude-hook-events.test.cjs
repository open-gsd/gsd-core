'use strict';

process.env.GSD_TEST_MODE = '1';

/**
 * Enhancement #770: Register Claude Code lifecycle hooks (SubagentStop / Stop /
 * PreCompact / FileChanged).
 *
 * Claude Code now supports the same SubagentStop, Stop, and PreCompact events
 * that were wired for Qwen Code in #788.  This suite asserts:
 *
 *   1. Claude Code installs register SubagentStop, Stop, and PreCompact, each
 *      wired to gsd-context-monitor.js (same as Qwen).
 *   2. Claude Code installs register a FileChanged hook for .planning/config.json
 *      wired to gsd-config-reload.js (new hook; hot-reloads gsd config).
 *   3. All four registrations are idempotent (reinstall does not duplicate).
 *   4. Uninstall removes all four event registrations.
 *   5. The gsd-config-reload.js hook script exists in hooks/ and has the
 *      expected structure (reads on stdin, emits additionalContext or exits 0).
 *   6. The hooks/hooks.json plugin manifest includes the new events.
 *
 * Source: https://code.claude.com/docs/en/hooks
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { install, uninstall, validateHookFields } = require('../bin/install.js');
const { createTempDir, cleanup } = require('./helpers.cjs');

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Extract all hook commands registered under `eventName` from settings. */
function hooksForEvent(settings, eventName) {
  if (!settings || !settings.hooks || !Array.isArray(settings.hooks[eventName])) return [];
  return settings.hooks[eventName].flatMap(entry =>
    (entry && Array.isArray(entry.hooks) ? entry.hooks : [])
      .map(h => h && h.command)
      .filter(Boolean)
  );
}

/** Extract all matchers registered under `eventName` from settings. */
function matchersForEvent(settings, eventName) {
  if (!settings || !settings.hooks || !Array.isArray(settings.hooks[eventName])) return [];
  return settings.hooks[eventName]
    .map(entry => entry && entry.matcher)
    .filter(Boolean);
}

const HOOKS_SRC = path.join(__dirname, '..', 'hooks');
// Hooks the installer existsSync-checks before registering; must be present
// in targetDir/hooks/ so the registration guards pass.
const STUB_HOOKS = [
  'gsd-context-monitor.js',
  'gsd-prompt-guard.js',
  'gsd-check-update.js',
  'gsd-config-reload.js',
];

/**
 * Pre-populate targetDir/hooks/ with stub hook files so the installer's
 * fs.existsSync guards pass even when hooks/dist/ is absent (e.g. CI without
 * a build step).  Each test suite passes its own per-test tmpDir/.claude path
 * so stubs are isolated to that test's temp directory — no shared filesystem
 * state, no cross-test races.
 *
 * When hooks/dist/ DOES exist (local dev with npm run build:hooks), the
 * installer copies real files over these stubs during install() — that is
 * fine and correct.
 */
function stubHooksIntoTarget(targetDir) {
  const hooksDest = path.join(targetDir, 'hooks');
  fs.mkdirSync(hooksDest, { recursive: true });
  for (const hookFile of STUB_HOOKS) {
    const src = path.join(HOOKS_SRC, hookFile);
    const dest = path.join(hooksDest, hookFile);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dest);
    } else {
      // Minimal stub so existsSync passes
      fs.writeFileSync(dest, '#!/usr/bin/env node\n// stub\n');
    }
    try { fs.chmodSync(dest, 0o755); } catch { /* Windows */ }
  }
}

function persistSettings(settingsPath, settings) {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(validateHookFields(settings), null, 2) + '\n', 'utf8');
}

// ─── Suite 1: Claude — new context monitor events are registered ──────────────

describe('enh-770: Claude install registers SubagentStop / Stop / PreCompact context hooks', () => {
  let tmpDir;
  let previousCwd;
  let settings;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-770-claude-ctx-');
    previousCwd = process.cwd();
    process.chdir(tmpDir);
    stubHooksIntoTarget(path.join(tmpDir, '.claude'));

    const result = install(false, 'claude', { installerMigrations: [] });
    settings = result && result.settings;
  });

  afterEach(() => {
    process.chdir(previousCwd);
    cleanup(tmpDir);
  });

  test('install returns a settings object (not null)', () => {
    assert.ok(settings !== null && typeof settings === 'object',
      'Claude install must return a non-null settings object');
  });

  test('SubagentStop event is registered with at least one hook', () => {
    const cmds = hooksForEvent(settings, 'SubagentStop');
    assert.ok(cmds.length > 0,
      `Expected SubagentStop hooks; got hooks: ${JSON.stringify(settings && settings.hooks)}`);
  });

  test('Stop event is registered with at least one hook', () => {
    const cmds = hooksForEvent(settings, 'Stop');
    assert.ok(cmds.length > 0,
      `Expected Stop hooks; got hooks: ${JSON.stringify(settings && settings.hooks)}`);
  });

  test('PreCompact event is registered with at least one hook', () => {
    const cmds = hooksForEvent(settings, 'PreCompact');
    assert.ok(cmds.length > 0,
      `Expected PreCompact hooks; got hooks: ${JSON.stringify(settings && settings.hooks)}`);
  });

  test('SubagentStop / Stop / PreCompact all use gsd-context-monitor', () => {
    for (const event of ['SubagentStop', 'Stop', 'PreCompact']) {
      const cmds = hooksForEvent(settings, event);
      assert.ok(
        cmds.some(c => c.includes('gsd-context-monitor')),
        `Event ${event} should use gsd-context-monitor; got commands: ${JSON.stringify(cmds)}`
      );
    }
  });
});

// ─── Suite 2: Claude — FileChanged hook for config hot-reload ─────────────────

describe('enh-770: Claude install registers FileChanged hook for .planning/config.json', () => {
  let tmpDir;
  let previousCwd;
  let settings;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-770-filechanged-');
    previousCwd = process.cwd();
    process.chdir(tmpDir);
    stubHooksIntoTarget(path.join(tmpDir, '.claude'));

    const result = install(false, 'claude', { installerMigrations: [] });
    settings = result && result.settings;
  });

  afterEach(() => {
    process.chdir(previousCwd);
    cleanup(tmpDir);
  });

  test('FileChanged event is registered with at least one hook', () => {
    const cmds = hooksForEvent(settings, 'FileChanged');
    assert.ok(cmds.length > 0,
      `Expected FileChanged hooks; got hooks: ${JSON.stringify(settings && settings.hooks)}`);
  });

  test('FileChanged hook uses gsd-config-reload', () => {
    const cmds = hooksForEvent(settings, 'FileChanged');
    assert.ok(
      cmds.some(c => c.includes('gsd-config-reload')),
      `FileChanged should use gsd-config-reload; got commands: ${JSON.stringify(cmds)}`
    );
  });

  test('FileChanged hook has a matcher targeting .planning/config.json', () => {
    const matchers = matchersForEvent(settings, 'FileChanged');
    assert.ok(
      matchers.some(m => m && m.includes('config.json')),
      `FileChanged matcher should target config.json; got matchers: ${JSON.stringify(matchers)}`
    );
  });
});

// ─── Suite 3: Idempotency ─────────────────────────────────────────────────────

describe('enh-770: Claude install is idempotent for the new hook events', () => {
  let tmpDir;
  let previousCwd;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-770-idem-');
    previousCwd = process.cwd();
    process.chdir(tmpDir);
    stubHooksIntoTarget(path.join(tmpDir, '.claude'));
  });

  afterEach(() => {
    process.chdir(previousCwd);
    cleanup(tmpDir);
  });

  test('re-running after persisted first install does not duplicate context monitor hooks', () => {
    const result1 = install(false, 'claude', { installerMigrations: [] });
    persistSettings(result1.settingsPath, result1.settings);

    process.chdir(tmpDir);
    const result2 = install(false, 'claude', { installerMigrations: [] });
    const s2 = result2.settings;

    for (const event of ['SubagentStop', 'Stop', 'PreCompact']) {
      const cmds = hooksForEvent(s2, event);
      assert.strictEqual(cmds.length, 1,
        `Event ${event} should have exactly 1 hook after idempotent reinstall; got ${cmds.length}: ${JSON.stringify(cmds)}`);
    }
  });

  test('re-running after persisted first install does not duplicate FileChanged hook', () => {
    const result1 = install(false, 'claude', { installerMigrations: [] });
    persistSettings(result1.settingsPath, result1.settings);

    process.chdir(tmpDir);
    const result2 = install(false, 'claude', { installerMigrations: [] });
    const s2 = result2.settings;

    const cmds = hooksForEvent(s2, 'FileChanged');
    assert.strictEqual(cmds.length, 1,
      `FileChanged should have exactly 1 hook after idempotent reinstall; got ${cmds.length}: ${JSON.stringify(cmds)}`);
  });
});

// ─── Suite 4: Uninstall removes registrations ─────────────────────────────────

describe('enh-770: Uninstall removes new hook event entries', () => {
  let tmpDir;
  let previousCwd;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-770-uninstall-');
    previousCwd = process.cwd();
    process.chdir(tmpDir);
    stubHooksIntoTarget(path.join(tmpDir, '.claude'));

    const result = install(false, 'claude', { installerMigrations: [] });
    persistSettings(result.settingsPath, result.settings);
  });

  afterEach(() => {
    process.chdir(previousCwd);
    cleanup(tmpDir);
  });

  test('settings.json hook entries are removed on uninstall', () => {
    uninstall(false, 'claude', { installerMigrations: [] });
    const settingsPath = path.join(tmpDir, '.claude', 'settings.json');
    if (!fs.existsSync(settingsPath)) return; // file removed entirely is fine
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    for (const event of ['SubagentStop', 'Stop', 'PreCompact', 'FileChanged']) {
      const cmds = hooksForEvent(settings, event);
      assert.strictEqual(cmds.length, 0,
        `After uninstall, ${event} should have 0 hooks; got: ${JSON.stringify(cmds)}`);
    }
  });
});

// ─── Suite 5: gsd-config-reload.js hook script exists and has correct shape ───

describe('enh-770: gsd-config-reload.js hook script', () => {
  const reloadScript = path.join(__dirname, '..', 'hooks', 'gsd-config-reload.js');

  test('gsd-config-reload.js exists in hooks/', () => {
    assert.ok(fs.existsSync(reloadScript),
      `gsd-config-reload.js must exist at ${reloadScript}`);
  });

  test('gsd-config-reload.js contains the gsd-hook-version stamp', () => {
    // allow-test-rule: runtime-contract-is-the-product — the stamp template token
    // IS the product surface that the installer must find and replace with the
    // real version at copy time; asserting its presence is required.
    const content = fs.readFileSync(reloadScript, 'utf8');
    assert.ok(
      content.includes('gsd-hook-version'),
      'gsd-config-reload.js must contain the gsd-hook-version stamp for installer stamping'
    );
  });

  test('gsd-config-reload.js reads from stdin and emits JSON output', () => {
    // allow-test-rule: runtime-contract-is-the-product — the stdin-read and
    // JSON-emit pattern IS the hook contract; asserting its presence is required.
    const content = fs.readFileSync(reloadScript, 'utf8');
    assert.ok(
      content.includes('process.stdin') && content.includes('JSON.stringify'),
      'gsd-config-reload.js must read stdin and emit JSON output per hook protocol'
    );
  });

  test('gsd-config-reload.js targets the FileChanged hook event', () => {
    // allow-test-rule: runtime-contract-is-the-product — the hookEventName is
    // the protocol surface; asserting its presence verifies the contract.
    const content = fs.readFileSync(reloadScript, 'utf8');
    assert.ok(
      content.includes('FileChanged'),
      'gsd-config-reload.js must reference FileChanged in its hookSpecificOutput'
    );
  });
});

// ─── Suite 6: hooks.json plugin manifest includes new events ──────────────────

describe('enh-770: hooks/hooks.json plugin manifest includes new hook events', () => {
  const hooksJsonPath = path.join(__dirname, '..', 'hooks', 'hooks.json');

  test('hooks.json exists', () => {
    assert.ok(fs.existsSync(hooksJsonPath), `hooks.json must exist at ${hooksJsonPath}`);
  });

  test('hooks.json contains SubagentStop event', () => {
    // allow-test-rule: runtime-contract-is-the-product — hooks.json IS the
    // plugin manifest surface that Claude Code reads at plugin load time.
    const content = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf8'));
    assert.ok(
      content.hooks && content.hooks.SubagentStop,
      'hooks.json must contain SubagentStop'
    );
  });

  test('hooks.json contains Stop event', () => {
    // allow-test-rule: runtime-contract-is-the-product — hooks.json IS the
    // plugin manifest surface that Claude Code reads at plugin load time.
    const content = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf8'));
    assert.ok(
      content.hooks && content.hooks.Stop,
      'hooks.json must contain Stop'
    );
  });

  test('hooks.json contains PreCompact event', () => {
    // allow-test-rule: runtime-contract-is-the-product — hooks.json IS the
    // plugin manifest surface that Claude Code reads at plugin load time.
    const content = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf8'));
    assert.ok(
      content.hooks && content.hooks.PreCompact,
      'hooks.json must contain PreCompact'
    );
  });

  test('hooks.json contains FileChanged event', () => {
    // allow-test-rule: runtime-contract-is-the-product — hooks.json IS the
    // plugin manifest surface that Claude Code reads at plugin load time.
    const content = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf8'));
    assert.ok(
      content.hooks && content.hooks.FileChanged,
      'hooks.json must contain FileChanged'
    );
  });
});

// ─── Suite 7: managed-hooks-registry includes gsd-config-reload.js ───────────

describe('enh-770: managed-hooks-registry includes gsd-config-reload.js', () => {
  test('MANAGED_HOOKS array includes gsd-config-reload.js', () => {
    const { MANAGED_HOOKS } = require('../hooks/managed-hooks-registry.cjs');
    assert.ok(
      MANAGED_HOOKS.includes('gsd-config-reload.js'),
      `MANAGED_HOOKS must include gsd-config-reload.js; got: ${JSON.stringify(MANAGED_HOOKS)}`
    );
  });
});
