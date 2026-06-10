'use strict';

process.env.GSD_TEST_MODE = '1';

/**
 * Enhancement #776: Adopt new Gemini hook events + detect hooksConfig.enabled:false.
 *
 * Gemini CLI exposes several hook events beyond BeforeTool/AfterTool that gsd
 * previously did not register.  This suite asserts that a Gemini install
 * registers the 3 new high-value events:
 *   - BeforeAgent  — fires before the agent plans (context headroom tracking)
 *   - AfterAgent   — fires after final response generation (context tracking)
 *   - BeforeModel  — fires before each LLM call (per-turn context awareness)
 *
 * All three are wired to gsd-context-monitor.js — the same hook used for
 * AfterTool — so context headroom warnings surface at these lifecycle moments.
 *
 * Also asserts:
 *   - Claude Code installs do NOT gain these Gemini-only events (strict scope guard).
 *   - Reinstalls are idempotent (no hook duplication).
 *   - Uninstall removes the new event registrations.
 *   - hooksConfig.enabled:false warning is emitted during a Gemini install.
 *
 * Source: https://github.com/google-gemini/gemini-cli/blob/main/docs/hooks/reference.md
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
//
// For Gemini, the installer migration baseline includes 'hooks/' in its surface
// list (unlike Qwen which excludes it). Pre-install stubs placed in .gemini/hooks/
// are classified as 'bundled-gsd-hook' and auto-removed by the migration before
// registration can succeed. The workaround: run a first install (which writes the
// gsd-file-manifest.json), then add the stubs, then run install again. On the
// second install the manifest marks the hook files as managed, so migration keeps
// them and registration guards (fs.existsSync) pass.
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

/**
 * Two-pass Gemini install.
 *
 * Pass 1: install() with no hook stubs — writes gsd-file-manifest.json.
 *         Migration runs on an empty hooks/ so nothing gets auto-removed.
 * Pass 2: stub hooks into the target dir (now manifest-tracked on next scan),
 *         then run install() again.  Migration now classifies the hooks as
 *         managed-unchanged and preserves them; registration guards pass.
 *
 * Returns the settings from pass 2.
 */
function twoPassGeminiInstall(tmpDir) {
  const targetDir = path.join(tmpDir, '.gemini');
  fs.mkdirSync(targetDir, { recursive: true });

  // Pass 1 — no hook stubs yet; writes the manifest
  const result1 = install(false, 'gemini');
  persistSettings(result1.settingsPath, result1.settings);

  // Inject stubs so the registration guards (fs.existsSync) pass on pass 2
  stubHooksIntoTarget(targetDir);

  // Pass 2 — manifest exists, migration keeps stubs, registration succeeds
  process.chdir(tmpDir);
  const result2 = install(false, 'gemini');
  return result2;
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

// ─── Suite 1: Gemini — new events are registered ─────────────────────────────

describe('enh-776: Gemini install registers 3 new hook events', () => {
  let tmpDir;
  let previousCwd;
  let settings;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-776-gemini-');
    previousCwd = process.cwd();
    process.chdir(tmpDir);

    // Two-pass install: first pass writes manifest, second pass with stubs
    // so registration guards (fs.existsSync) pass.
    const result = twoPassGeminiInstall(tmpDir);
    settings = result.settings;
  });

  afterEach(() => {
    process.chdir(previousCwd);
    cleanup(tmpDir);
  });

  test('install returns a settings object (not null)', () => {
    assert.ok(settings !== null && typeof settings === 'object',
      'Gemini install must return a non-null settings object');
  });

  test('BeforeAgent event is registered with at least one hook', () => {
    const cmds = hooksForEvent(settings, 'BeforeAgent');
    assert.ok(cmds.length > 0,
      `Expected BeforeAgent hooks; got hooks: ${JSON.stringify(settings && settings.hooks)}`);
  });

  test('AfterAgent event is registered with at least one hook', () => {
    const cmds = hooksForEvent(settings, 'AfterAgent');
    assert.ok(cmds.length > 0,
      `Expected AfterAgent hooks; got hooks: ${JSON.stringify(settings && settings.hooks)}`);
  });

  test('BeforeModel event is registered with at least one hook', () => {
    const cmds = hooksForEvent(settings, 'BeforeModel');
    assert.ok(cmds.length > 0,
      `Expected BeforeModel hooks; got hooks: ${JSON.stringify(settings && settings.hooks)}`);
  });

  test('BeforeAgent / AfterAgent / BeforeModel all use gsd-context-monitor', () => {
    for (const event of ['BeforeAgent', 'AfterAgent', 'BeforeModel']) {
      const cmds = hooksForEvent(settings, event);
      assert.ok(
        cmds.some(c => c.includes('gsd-context-monitor')),
        `Event ${event} should use gsd-context-monitor; got commands: ${JSON.stringify(cmds)}`
      );
    }
  });
});

// ─── Suite 2: Non-Gemini installs do NOT get the new events ──────────────────
//
// Two runtimes are particularly important to guard:
//   Claude — the canonical non-Gemini runtime
//   Antigravity — shares Gemini-style BeforeTool/AfterTool naming and uses
//                 isGemini-adjacent logic; a future accidental
//                 `isGemini || isAntigravity` change must be caught here.

describe('enh-776: Claude install does NOT register Gemini-only hook events', () => {
  let tmpDir;
  let previousCwd;
  let settings;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-776-claude-');
    previousCwd = process.cwd();
    process.chdir(tmpDir);

    const result = install(false, 'claude');
    settings = result && result.settings;
  });

  afterEach(() => {
    process.chdir(previousCwd);
    cleanup(tmpDir);
  });

  test('Claude install does not register BeforeAgent', () => {
    const cmds = hooksForEvent(settings, 'BeforeAgent');
    assert.strictEqual(cmds.length, 0,
      `Claude should NOT have BeforeAgent; got: ${JSON.stringify(cmds)}`);
  });

  test('Claude install does not register AfterAgent', () => {
    const cmds = hooksForEvent(settings, 'AfterAgent');
    assert.strictEqual(cmds.length, 0,
      `Claude should NOT have AfterAgent; got: ${JSON.stringify(cmds)}`);
  });

  test('Claude install does not register BeforeModel', () => {
    const cmds = hooksForEvent(settings, 'BeforeModel');
    assert.strictEqual(cmds.length, 0,
      `Claude should NOT have BeforeModel; got: ${JSON.stringify(cmds)}`);
  });
});

describe('enh-776: Antigravity install does NOT register Gemini-only hook events', () => {
  let tmpDir;
  let previousCwd;
  let settings;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-776-antigravity-');
    previousCwd = process.cwd();
    process.chdir(tmpDir);

    const result = install(false, 'antigravity');
    settings = result && result.settings;
  });

  afterEach(() => {
    process.chdir(previousCwd);
    cleanup(tmpDir);
  });

  test('Antigravity install does not register BeforeAgent', () => {
    const cmds = hooksForEvent(settings, 'BeforeAgent');
    assert.strictEqual(cmds.length, 0,
      `Antigravity should NOT have BeforeAgent; got: ${JSON.stringify(cmds)}`);
  });

  test('Antigravity install does not register AfterAgent', () => {
    const cmds = hooksForEvent(settings, 'AfterAgent');
    assert.strictEqual(cmds.length, 0,
      `Antigravity should NOT have AfterAgent; got: ${JSON.stringify(cmds)}`);
  });

  test('Antigravity install does not register BeforeModel', () => {
    const cmds = hooksForEvent(settings, 'BeforeModel');
    assert.strictEqual(cmds.length, 0,
      `Antigravity should NOT have BeforeModel; got: ${JSON.stringify(cmds)}`);
  });
});

// ─── Suite 3: Idempotency — persisted reinstall does not duplicate hooks ──────

describe('enh-776: Gemini install is idempotent across persisted reinstalls', () => {
  let tmpDir;
  let previousCwd;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-776-idem-');
    previousCwd = process.cwd();
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(previousCwd);
    cleanup(tmpDir);
  });

  test('re-running after persisted first install does not duplicate hook entries', () => {
    // Two-pass to get hooks installed.
    const result2 = twoPassGeminiInstall(tmpDir);
    const s2 = result2.settings;

    // Assert hooks ARE registered after pass 2 (guards against false-pass where
    // hooks never registered and idempotency passes trivially at count=0).
    for (const event of ['BeforeAgent', 'AfterAgent', 'BeforeModel']) {
      const cmds = hooksForEvent(s2, event);
      assert.strictEqual(cmds.length, 1,
        `Event ${event} should have exactly 1 hook after two-pass install; got ${cmds.length}: ${JSON.stringify(cmds)}`);
    }

    persistSettings(result2.settingsPath, s2);

    // Third install: reads the persisted settings.json — dedup guards apply
    process.chdir(tmpDir);
    const result3 = install(false, 'gemini');
    const s3 = result3.settings;

    for (const event of ['BeforeAgent', 'AfterAgent', 'BeforeModel']) {
      const cmds = hooksForEvent(s3, event);
      assert.strictEqual(cmds.length, 1,
        `Event ${event} should have exactly 1 hook command after idempotent reinstall; got ${cmds.length}: ${JSON.stringify(cmds)}`);
    }
  });
});

// ─── Suite 4: Uninstall removes the new event registrations ──────────────────

describe('enh-776: Gemini uninstall removes new hook event entries', () => {
  let tmpDir;
  let previousCwd;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-776-uninstall-');
    previousCwd = process.cwd();
    process.chdir(tmpDir);

    // Two-pass install and persist so uninstall has a settings.json to clean
    const result = twoPassGeminiInstall(tmpDir);
    persistSettings(result.settingsPath, result.settings);
  });

  afterEach(() => {
    process.chdir(previousCwd);
    cleanup(tmpDir);
  });

  test('settings.json hook entries are removed on uninstall', () => {
    uninstall(false, 'gemini');
    const settingsPath = path.join(tmpDir, '.gemini', 'settings.json');
    if (!fs.existsSync(settingsPath)) return; // file removed entirely is fine
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    for (const event of ['BeforeAgent', 'AfterAgent', 'BeforeModel']) {
      const cmds = hooksForEvent(settings, event);
      assert.strictEqual(cmds.length, 0,
        `After uninstall, ${event} should have 0 hooks; got: ${JSON.stringify(cmds)}`);
    }
  });
});

// ─── Suite 5: hooksConfig.enabled:false warning ───────────────────────────────

describe('enh-776: hooksConfig.enabled:false warning during Gemini install', () => {
  let tmpDir;
  let previousCwd;
  let stderrLines;
  let originalWarn;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-776-hookscfg-');
    previousCwd = process.cwd();
    process.chdir(tmpDir);

    const targetDir = path.join(tmpDir, '.gemini');
    fs.mkdirSync(targetDir, { recursive: true });

    // Capture console.warn output
    stderrLines = [];
    originalWarn = console.warn;
    console.warn = (...args) => { stderrLines.push(args.join(' ')); };
  });

  afterEach(() => {
    console.warn = originalWarn;
    process.chdir(previousCwd);
    cleanup(tmpDir);
  });

  test('emits a warning when hooksConfig.enabled is false', () => {
    // Write a settings.json with hooksConfig.enabled: false BEFORE install
    // (the check in install() reads the existing settings.json on disk).
    const targetDir = path.join(tmpDir, '.gemini');
    const settingsPath = path.join(targetDir, 'settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify({ hooksConfig: { enabled: false } }, null, 2) + '\n', 'utf8');

    install(false, 'gemini');
    const warnText = stderrLines.join('\n');
    assert.ok(
      warnText.includes('hooksConfig.enabled is false'),
      `Expected hooksConfig.enabled warning; got console.warn output:\n${warnText}`
    );
  });

  test('does NOT emit the hooksConfig warning when hooksConfig.enabled is true', () => {
    const targetDir = path.join(tmpDir, '.gemini');
    const settingsPath = path.join(targetDir, 'settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify({ hooksConfig: { enabled: true } }, null, 2) + '\n', 'utf8');

    install(false, 'gemini');
    const warnText = stderrLines.join('\n');
    assert.ok(
      !warnText.includes('hooksConfig.enabled is false'),
      `Should NOT warn when hooksConfig.enabled is true; got:\n${warnText}`
    );
  });

  test('does NOT emit the hooksConfig warning when hooksConfig is absent', () => {
    const targetDir = path.join(tmpDir, '.gemini');
    const settingsPath = path.join(targetDir, 'settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify({}, null, 2) + '\n', 'utf8');

    install(false, 'gemini');
    const warnText = stderrLines.join('\n');
    assert.ok(
      !warnText.includes('hooksConfig.enabled is false'),
      `Should NOT warn when hooksConfig is absent; got:\n${warnText}`
    );
  });
});
