'use strict';

process.env.GSD_TEST_MODE = '1';

/**
 * Enhancement #788: Expand Qwen Code hook-event coverage.
 *
 * Qwen Code supports 15 hook events; gsd previously registered only
 * SessionStart and PostToolUse.  This suite asserts that a Qwen install
 * registers the 4 new high-value events:
 *   - SubagentStop   — subagent lifecycle finalisation
 *   - Stop           — model stop / final-response hook
 *   - PreCompact     — pre-compaction awareness
 *   - UserPromptSubmit — prompt enrichment / validation
 *
 * Also asserts the inverse: Claude Code installs do NOT gain these events
 * (strict scope guard).
 *
 * Source: https://qwenlm.github.io/qwen-code-docs/en/users/features/hooks/
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { install, uninstall } = require('../bin/install.js');
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

// ─── Suite 1: Qwen — new events are registered ───────────────────────────────

// Stub JS hook files that the installer checks with fs.existsSync() so hook
// registration guards pass even when hooks/dist/ isn't built.
const HOOKS_SRC = path.join(__dirname, '..', 'hooks');
const STUB_HOOKS = [
  'gsd-context-monitor.js',
  'gsd-prompt-guard.js',
  'gsd-check-update.js',
];

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

describe('enh-788: Qwen install registers 4 new hook events', () => {
  let tmpDir;
  let previousCwd;
  let settings;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-788-qwen-');
    previousCwd = process.cwd();
    process.chdir(tmpDir);

    const targetDir = path.join(tmpDir, '.qwen');
    fs.mkdirSync(targetDir, { recursive: true });
    // Pre-populate hook files so installer registration guards (fs.existsSync)
    // pass and hooks are actually registered in settings.json.
    stubHooksIntoTarget(targetDir);

    const result = install(false, 'qwen');
    settings = result.settings;
  });

  afterEach(() => {
    process.chdir(previousCwd);
    cleanup(tmpDir);
  });

  test('install returns a settings object (not null)', () => {
    assert.ok(settings !== null && typeof settings === 'object',
      'Qwen install must return a non-null settings object');
  });

  test('SubagentStop event is registered with at least one hook', () => {
    const cmds = hooksForEvent(settings, 'SubagentStop');
    assert.ok(cmds.length > 0,
      `Expected SubagentStop hooks; got: ${JSON.stringify(settings && settings.hooks)}`);
  });

  test('Stop event is registered with at least one hook', () => {
    const cmds = hooksForEvent(settings, 'Stop');
    assert.ok(cmds.length > 0,
      `Expected Stop hooks; got: ${JSON.stringify(settings && settings.hooks)}`);
  });

  test('PreCompact event is registered with at least one hook', () => {
    const cmds = hooksForEvent(settings, 'PreCompact');
    assert.ok(cmds.length > 0,
      `Expected PreCompact hooks; got: ${JSON.stringify(settings && settings.hooks)}`);
  });

  test('UserPromptSubmit event is registered with at least one hook', () => {
    const cmds = hooksForEvent(settings, 'UserPromptSubmit');
    assert.ok(cmds.length > 0,
      `Expected UserPromptSubmit hooks; got: ${JSON.stringify(settings && settings.hooks)}`);
  });

  test('SubagentStop / Stop / PreCompact use gsd-context-monitor', () => {
    for (const event of ['SubagentStop', 'Stop', 'PreCompact']) {
      const cmds = hooksForEvent(settings, event);
      assert.ok(
        cmds.some(c => c.includes('gsd-context-monitor')),
        `Event ${event} should use gsd-context-monitor; got commands: ${JSON.stringify(cmds)}`
      );
    }
  });

  test('UserPromptSubmit uses gsd-prompt-guard', () => {
    const cmds = hooksForEvent(settings, 'UserPromptSubmit');
    assert.ok(
      cmds.some(c => c.includes('gsd-prompt-guard')),
      `UserPromptSubmit should use gsd-prompt-guard; got commands: ${JSON.stringify(cmds)}`
    );
  });

  test('install is idempotent — re-running does not duplicate entries', () => {
    // Run install a second time in the same tmpDir (hooks already stubbed from beforeEach)
    process.chdir(tmpDir);
    const result2 = install(false, 'qwen');
    const s2 = result2.settings;
    for (const event of ['SubagentStop', 'Stop', 'PreCompact', 'UserPromptSubmit']) {
      const cmds = hooksForEvent(s2, event);
      // Should have exactly 1 command entry (dedup guard prevents doubling)
      assert.strictEqual(cmds.length, 1,
        `Event ${event} should have exactly 1 hook command after idempotent reinstall; got ${cmds.length}: ${JSON.stringify(cmds)}`);
    }
  });
});

// ─── Suite 2: Claude install does NOT get the new events ─────────────────────

describe('enh-788: Claude install does NOT register Qwen-only hook events', () => {
  let tmpDir;
  let previousCwd;
  let settings;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-788-claude-');
    previousCwd = process.cwd();
    process.chdir(tmpDir);

    const result = install(false, 'claude');
    settings = result && result.settings;
  });

  afterEach(() => {
    process.chdir(previousCwd);
    cleanup(tmpDir);
  });

  test('Claude install does not register SubagentStop', () => {
    const cmds = hooksForEvent(settings, 'SubagentStop');
    assert.strictEqual(cmds.length, 0,
      `Claude should NOT have SubagentStop; got: ${JSON.stringify(cmds)}`);
  });

  test('Claude install does not register Stop', () => {
    const cmds = hooksForEvent(settings, 'Stop');
    assert.strictEqual(cmds.length, 0,
      `Claude should NOT have Stop; got: ${JSON.stringify(cmds)}`);
  });

  test('Claude install does not register PreCompact', () => {
    const cmds = hooksForEvent(settings, 'PreCompact');
    assert.strictEqual(cmds.length, 0,
      `Claude should NOT have PreCompact; got: ${JSON.stringify(cmds)}`);
  });

  test('Claude install does not register UserPromptSubmit', () => {
    const cmds = hooksForEvent(settings, 'UserPromptSubmit');
    assert.strictEqual(cmds.length, 0,
      `Claude should NOT have UserPromptSubmit; got: ${JSON.stringify(cmds)}`);
  });
});

// ─── Suite 3: Uninstall removes the new event registrations ──────────────────

describe('enh-788: Qwen uninstall removes new hook event entries', () => {
  let tmpDir;
  let previousCwd;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-788-uninstall-');
    previousCwd = process.cwd();
    process.chdir(tmpDir);

    const targetDir = path.join(tmpDir, '.qwen');
    fs.mkdirSync(targetDir, { recursive: true });
    stubHooksIntoTarget(targetDir);
    install(false, 'qwen');
  });

  afterEach(() => {
    process.chdir(previousCwd);
    cleanup(tmpDir);
  });

  test('settings.json hook entries are removed on uninstall', () => {
    uninstall(false, 'qwen');
    const settingsPath = path.join(tmpDir, '.qwen', 'settings.json');
    if (!fs.existsSync(settingsPath)) return; // already gone is also fine
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    for (const event of ['SubagentStop', 'Stop', 'PreCompact', 'UserPromptSubmit']) {
      const cmds = hooksForEvent(settings, event);
      assert.strictEqual(cmds.length, 0,
        `After uninstall, ${event} should have 0 hooks; got: ${JSON.stringify(cmds)}`);
    }
  });
});
