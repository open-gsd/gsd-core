'use strict';

process.env.GSD_TEST_MODE = '1';

/**
 * Enhancement #788: Expand Qwen Code hook-event coverage.
 *
 * Qwen Code supports 15 hook events; gsd previously registered only
 * SessionStart and PostToolUse.  This suite asserts that a Qwen install
 * registers the 3 new high-value events:
 *   - SubagentStop  — subagent lifecycle finalisation (context tracking)
 *   - Stop          — model stop / final-response hook (context tracking)
 *   - PreCompact    — pre-compaction awareness (context tracking)
 *
 * All three are wired to gsd-context-monitor.js — the same hook used for
 * PostToolUse — so context headroom warnings surface at these moments too.
 *
 * Note: UserPromptSubmit is NOT wired — gsd-prompt-guard exits unless
 * tool_name is Write|Edit (PreToolUse shape), so it would be a no-op for
 * the UserPromptSubmit payload.  Deferred to a follow-on issue.
 *
 * Also asserts the inverse: Claude Code installs do NOT gain these events
 * (strict isQwen scope guard).
 *
 * Source: https://qwenlm.github.io/qwen-code-docs/en/users/features/hooks/
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

// Stub JS hook files that the installer checks with fs.existsSync() so hook
// registration guards pass even when hooks/dist/ isn't built.
const HOOKS_SRC = path.join(__dirname, '..', 'hooks');
const STUB_HOOKS = [
  'gsd-context-monitor.js',
  'gsd-prompt-guard.js',
  'gsd-check-update.js',
  'gsd-config-reload.js', // Added in #770
];

const HOOKS_DIST = path.join(__dirname, '..', 'hooks', 'dist');
let hooksDistCreatedByTest = false;

/**
 * Ensure hooks/dist/ exists with stub files so the installer's copy loop can
 * populate targetDir/hooks/ for Claude Code installs.  Claude's
 * first-time-baseline migration auto-removes pre-existing bundled hook stubs
 * from targetDir/hooks/ and expects the installer to re-copy from hooks/dist/.
 */
function ensureHooksDist() {
  if (!fs.existsSync(HOOKS_DIST)) {
    fs.mkdirSync(HOOKS_DIST, { recursive: true });
    hooksDistCreatedByTest = true;
  }
  for (const hookFile of STUB_HOOKS) {
    const dest = path.join(HOOKS_DIST, hookFile);
    if (!fs.existsSync(dest)) {
      const src = path.join(HOOKS_SRC, hookFile);
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, dest);
      } else {
        fs.writeFileSync(dest, '#!/usr/bin/env node\n// stub\n');
      }
      try { fs.chmodSync(dest, 0o755); } catch { /* Windows */ }
    }
  }
}

function teardownHooksDist() {
  if (hooksDistCreatedByTest && fs.existsSync(HOOKS_DIST)) {
    for (const hookFile of STUB_HOOKS) {
      try { fs.unlinkSync(path.join(HOOKS_DIST, hookFile)); } catch { /* ignore */ }
    }
    try {
      if (fs.readdirSync(HOOKS_DIST).length === 0) fs.rmdirSync(HOOKS_DIST);
    } catch { /* ignore */ }
    hooksDistCreatedByTest = false;
  }
}

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

/**
 * Persist in-memory settings to disk, simulating what finishInstall() does
 * (finishInstall is not exported).  Required for tests that call install()
 * twice and need the second call to read the first call's hook registrations.
 */
function persistSettings(settingsPath, settings) {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(validateHookFields(settings), null, 2) + '\n', 'utf8');
}

// ─── Suite 1: Qwen — new events are registered ───────────────────────────────

describe('enh-788: Qwen install registers 3 new hook events', () => {
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

  test('UserPromptSubmit is NOT registered (handler not yet implemented for that payload shape)', () => {
    // gsd-prompt-guard exits unless tool_name is Write|Edit — it is a no-op
    // for UserPromptSubmit payloads.  Registration is deferred until a
    // dedicated hook can process the user-prompt payload shape.
    const cmds = hooksForEvent(settings, 'UserPromptSubmit');
    assert.strictEqual(cmds.length, 0,
      `UserPromptSubmit should NOT be registered yet; got: ${JSON.stringify(cmds)}`);
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

  test('FileChanged is NOT registered for Qwen (Claude-only event)', () => {
    // gsd-config-reload / FileChanged is a Claude Code-only registration.
    // Qwen does not support the FileChanged hook event at all.
    const cmds = hooksForEvent(settings, 'FileChanged');
    assert.strictEqual(cmds.length, 0,
      `FileChanged should NOT be registered for Qwen; got: ${JSON.stringify(cmds)}`);
  });
});

// ─── Suite 2: Claude install DOES get the context events (since #770) ───────
// Note: Prior to #770, these were Qwen-only events.  #770 extended them to
// Claude Code.  This suite is updated to match the new expected behavior.

describe('enh-788 (updated by #770): Claude install registers context lifecycle events', () => {
  let tmpDir;
  let previousCwd;
  let settings;

  beforeEach(() => {
    ensureHooksDist();
    tmpDir = createTempDir('gsd-788-claude-');
    previousCwd = process.cwd();
    process.chdir(tmpDir);

    const result = install(false, 'claude');
    settings = result && result.settings;
  });

  afterEach(() => {
    process.chdir(previousCwd);
    cleanup(tmpDir);
    teardownHooksDist();
  });

  test('Claude install registers SubagentStop (since #770)', () => {
    const cmds = hooksForEvent(settings, 'SubagentStop');
    assert.ok(cmds.length > 0,
      `Claude should have SubagentStop since #770; got: ${JSON.stringify(cmds)}`);
  });

  test('Claude install registers Stop (since #770)', () => {
    const cmds = hooksForEvent(settings, 'Stop');
    assert.ok(cmds.length > 0,
      `Claude should have Stop since #770; got: ${JSON.stringify(cmds)}`);
  });

  test('Claude install registers PreCompact (since #770)', () => {
    const cmds = hooksForEvent(settings, 'PreCompact');
    assert.ok(cmds.length > 0,
      `Claude should have PreCompact since #770; got: ${JSON.stringify(cmds)}`);
  });
});

// ─── Suite 3: Idempotency — persisted reinstall does not duplicate hooks ──────

describe('enh-788: Qwen install is idempotent across persisted reinstalls', () => {
  let tmpDir;
  let previousCwd;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-788-idem-');
    previousCwd = process.cwd();
    process.chdir(tmpDir);

    const targetDir = path.join(tmpDir, '.qwen');
    fs.mkdirSync(targetDir, { recursive: true });
    stubHooksIntoTarget(targetDir);
  });

  afterEach(() => {
    process.chdir(previousCwd);
    cleanup(tmpDir);
  });

  test('re-running after persisted first install does not duplicate hook entries', () => {
    // First install: get settings and persist to disk (simulating finishInstall)
    const result1 = install(false, 'qwen');
    persistSettings(result1.settingsPath, result1.settings);

    // Second install: reads the persisted settings.json — dedup guards apply
    process.chdir(tmpDir);
    const result2 = install(false, 'qwen');
    const s2 = result2.settings;

    for (const event of ['SubagentStop', 'Stop', 'PreCompact']) {
      const cmds = hooksForEvent(s2, event);
      assert.strictEqual(cmds.length, 1,
        `Event ${event} should have exactly 1 hook command after idempotent reinstall; got ${cmds.length}: ${JSON.stringify(cmds)}`);
    }
  });
});

// ─── Suite 4: Uninstall removes the new event registrations ──────────────────

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

    // Install and persist to disk so uninstall has a settings.json to clean
    const result = install(false, 'qwen');
    persistSettings(result.settingsPath, result.settings);
  });

  afterEach(() => {
    process.chdir(previousCwd);
    cleanup(tmpDir);
  });

  test('settings.json hook entries are removed on uninstall', () => {
    uninstall(false, 'qwen');
    const settingsPath = path.join(tmpDir, '.qwen', 'settings.json');
    if (!fs.existsSync(settingsPath)) return; // file removed entirely is fine
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    for (const event of ['SubagentStop', 'Stop', 'PreCompact']) {
      const cmds = hooksForEvent(settings, event);
      assert.strictEqual(cmds.length, 0,
        `After uninstall, ${event} should have 0 hooks; got: ${JSON.stringify(cmds)}`);
    }
  });
});
