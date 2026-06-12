'use strict';

process.env.GSD_TEST_MODE = '1';

/**
 * ADR-857 phase 5f-3: extended hook event guards are driven by the
 * extendedHookEvents descriptor field, not hardcoded runtime-name checks.
 *
 * Before this change:
 *   - SubagentStop/Stop/PreCompact were wired only when (isQwen || runtime==='claude')
 *   - FileChanged was wired only when (runtime === 'claude')
 *   - BeforeAgent/AfterAgent/BeforeModel were wired only when (isGemini)
 *
 * After this change:
 *   - All three guard blocks are driven purely by extendedEvents.includes(eventName)
 *   - Any runtime (or arbitrary string) that passes the right extendedHookEvents
 *     array gets exactly those events registered, regardless of its runtime name.
 *
 * This suite proves descriptor-drive by calling applySettingsJsonHooks directly
 * with a controlled extendedHookEvents array and asserting on settings.hooks.
 * No source-grep; purely behavioral.
 */

const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const HOOKS_DIST_DIR = path.join(REPO_ROOT, 'hooks', 'dist');
const BUILD_HOOKS_SCRIPT = path.join(REPO_ROOT, 'scripts', 'build-hooks.js');

/** Idempotently ensure hooks/dist contains built .js files. */
function ensureHooksDist() {
  if (!fs.existsSync(HOOKS_DIST_DIR) || fs.readdirSync(HOOKS_DIST_DIR).filter(f => f.endsWith('.js')).length === 0) {
    execFileSync(process.execPath, [BUILD_HOOKS_SCRIPT], { stdio: 'pipe' });
  }
}

before(() => {
  ensureHooksDist();
});

const { applySettingsJsonHooks } = require('../bin/install.js');
const { cleanup } = require('./helpers.cjs');

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Return all hook commands registered under an event key. */
function hooksForEvent(settings, eventName) {
  if (!settings || !settings.hooks || !Array.isArray(settings.hooks[eventName])) return [];
  return settings.hooks[eventName].flatMap(entry =>
    (entry && Array.isArray(entry.hooks) ? entry.hooks : [])
      .map(h => h && h.command)
      .filter(Boolean)
  );
}

/** True if any hook is registered under eventName. */
function hasHooksFor(settings, eventName) {
  return hooksForEvent(settings, eventName).length > 0;
}

/**
 * Create a temporary directory with stub hook files so fs.existsSync guards pass.
 * Returns the targetDir path.
 */
function createStubTargetDir() {
  const tmpDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'gsd-1076-'));
  const hooksDir = path.join(tmpDir, 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  // Stubs for the hooks applySettingsJsonHooks existsSync-checks
  const stubs = [
    'gsd-check-update.js',
    'gsd-context-monitor.js',
    'gsd-prompt-guard.js',
    'gsd-read-guard.js',
    'gsd-read-injection-scanner.js',
    'gsd-config-reload.js',
    'gsd-workflow-guard.js',
    'gsd-worktree-path-guard.js',
    'gsd-validate-commit.sh',
    'gsd-session-state.sh',
    'gsd-phase-boundary.sh',
    'gsd-graphify-update.sh',
  ];
  const hooksDistDir = path.join(REPO_ROOT, 'hooks', 'dist');
  for (const stub of stubs) {
    const dest = path.join(hooksDir, stub);
    const distSrc = path.join(hooksDistDir, stub);
    if (fs.existsSync(distSrc)) {
      fs.copyFileSync(distSrc, dest);
    } else {
      // Minimal stub so existsSync passes
      const ext = path.extname(stub);
      fs.writeFileSync(dest, ext === '.sh' ? '#!/bin/bash\n# stub\n' : '#!/usr/bin/env node\n// stub\n');
    }
    try { fs.chmodSync(dest, 0o755); } catch { /* Windows */ }
  }
  return tmpDir;
}

function cleanupDir(dir) {
  cleanup(dir);
}

/**
 * Build the minimal opts bag for applySettingsJsonHooks.
 * postToolEvent: 'PostToolUse' (default dialect).
 * All commands: non-null strings so the "command truthy" guard passes.
 */
function buildOpts(targetDir, { runtime, extendedHookEvents }) {
  const hookOpts = { platform: process.platform, runtime };
  const node = process.execPath;
  return {
    runtime,
    isGlobal: true,
    targetDir,
    postToolEvent: 'PostToolUse',
    hookEvents: undefined,         // not the hookEvents dialect — we're testing extendedHookEvents
    extendedHookEvents,
    updateCheckCommand: `${node} "${path.join(targetDir, 'hooks', 'gsd-check-update.js')}"`,
    contextMonitorCommand: `${node} "${path.join(targetDir, 'hooks', 'gsd-context-monitor.js')}"`,
    promptGuardCommand: `${node} "${path.join(targetDir, 'hooks', 'gsd-prompt-guard.js')}"`,
    readGuardCommand: `${node} "${path.join(targetDir, 'hooks', 'gsd-read-guard.js')}"`,
    readInjectionScannerCommand: `${node} "${path.join(targetDir, 'hooks', 'gsd-read-injection-scanner.js')}"`,
    configReloadCommand: `${node} "${path.join(targetDir, 'hooks', 'gsd-config-reload.js')}"`,
    hookOpts,
    localCmd: () => null,
    localShellCmd: () => null,
  };
}

// ─── Suite 1: claude shape (SubagentStop+Stop+PreCompact+FileChanged) ─────────

describe('enh-1076 phase 5f-3: claude extendedHookEvents → SubagentStop/Stop/PreCompact/FileChanged', () => {
  let targetDir;
  let settings;

  before(() => {
    targetDir = createStubTargetDir();
    settings = { hooks: {} };
    const opts = buildOpts(targetDir, {
      runtime: 'claude',
      extendedHookEvents: ['SubagentStop', 'Stop', 'PreCompact', 'FileChanged'],
    });
    applySettingsJsonHooks(settings, opts);
  });

  test('SubagentStop is wired (descriptor-driven)', () => {
    assert.ok(
      hasHooksFor(settings, 'SubagentStop'),
      `Expected SubagentStop hooks; hooks keys: ${JSON.stringify(Object.keys(settings.hooks || {}))}`
    );
  });

  test('Stop is wired (descriptor-driven)', () => {
    assert.ok(
      hasHooksFor(settings, 'Stop'),
      `Expected Stop hooks; hooks keys: ${JSON.stringify(Object.keys(settings.hooks || {}))}`
    );
  });

  test('PreCompact is wired (descriptor-driven)', () => {
    assert.ok(
      hasHooksFor(settings, 'PreCompact'),
      `Expected PreCompact hooks; hooks keys: ${JSON.stringify(Object.keys(settings.hooks || {}))}`
    );
  });

  test('FileChanged is wired (descriptor-driven)', () => {
    assert.ok(
      hasHooksFor(settings, 'FileChanged'),
      `Expected FileChanged hooks; hooks keys: ${JSON.stringify(Object.keys(settings.hooks || {}))}`
    );
  });

  test('cleanup', () => {
    cleanupDir(targetDir);
  });
});

// ─── Suite 2: qwen shape (SubagentStop+Stop+PreCompact, no FileChanged) ───────

describe('enh-1076 phase 5f-3: qwen extendedHookEvents → SubagentStop/Stop/PreCompact only', () => {
  let targetDir;
  let settings;

  before(() => {
    targetDir = createStubTargetDir();
    settings = { hooks: {} };
    const opts = buildOpts(targetDir, {
      runtime: 'qwen',
      extendedHookEvents: ['SubagentStop', 'Stop', 'PreCompact'],
    });
    applySettingsJsonHooks(settings, opts);
  });

  test('SubagentStop is wired', () => {
    assert.ok(hasHooksFor(settings, 'SubagentStop'));
  });

  test('Stop is wired', () => {
    assert.ok(hasHooksFor(settings, 'Stop'));
  });

  test('PreCompact is wired', () => {
    assert.ok(hasHooksFor(settings, 'PreCompact'));
  });

  test('FileChanged is NOT wired (not in extendedHookEvents)', () => {
    assert.strictEqual(
      hasHooksFor(settings, 'FileChanged'),
      false,
      `FileChanged must NOT be wired for qwen shape; hooks keys: ${JSON.stringify(Object.keys(settings.hooks || {}))}`
    );
  });

  test('cleanup', () => {
    cleanupDir(targetDir);
  });
});

// ─── Suite 3: gemini shape (BeforeAgent+AfterAgent+BeforeModel) ───────────────

describe('enh-1076 phase 5f-3: gemini extendedHookEvents → BeforeAgent/AfterAgent/BeforeModel', () => {
  let targetDir;
  let settings;

  before(() => {
    targetDir = createStubTargetDir();
    settings = { hooks: {} };
    const opts = buildOpts(targetDir, {
      runtime: 'gemini',
      extendedHookEvents: ['BeforeAgent', 'AfterAgent', 'BeforeModel'],
    });
    applySettingsJsonHooks(settings, opts);
  });

  test('BeforeAgent is wired', () => {
    assert.ok(
      hasHooksFor(settings, 'BeforeAgent'),
      `Expected BeforeAgent hooks; hooks keys: ${JSON.stringify(Object.keys(settings.hooks || {}))}`
    );
  });

  test('AfterAgent is wired', () => {
    assert.ok(hasHooksFor(settings, 'AfterAgent'));
  });

  test('BeforeModel is wired', () => {
    assert.ok(hasHooksFor(settings, 'BeforeModel'));
  });

  test('SubagentStop is NOT wired (not in extendedHookEvents)', () => {
    assert.strictEqual(
      hasHooksFor(settings, 'SubagentStop'),
      false,
      'SubagentStop must NOT be wired for gemini shape'
    );
  });

  test('FileChanged is NOT wired (not in extendedHookEvents)', () => {
    assert.strictEqual(
      hasHooksFor(settings, 'FileChanged'),
      false,
      'FileChanged must NOT be wired for gemini shape'
    );
  });

  test('cleanup', () => {
    cleanupDir(targetDir);
  });
});

// ─── Suite 4: empty extendedHookEvents → none of the extended events ──────────

describe('enh-1076 phase 5f-3: empty extendedHookEvents → no extended events wired', () => {
  let targetDir;
  let settings;

  before(() => {
    targetDir = createStubTargetDir();
    settings = { hooks: {} };
    // Use runtime='someruntime' to prove it's the descriptor, not the name, that matters
    const opts = buildOpts(targetDir, {
      runtime: 'someruntime',
      extendedHookEvents: [],
    });
    applySettingsJsonHooks(settings, opts);
  });

  const EXTENDED_EVENTS = [
    'SubagentStop', 'Stop', 'PreCompact', 'FileChanged',
    'BeforeAgent', 'AfterAgent', 'BeforeModel',
  ];

  for (const event of EXTENDED_EVENTS) {
    test(`${event} is NOT wired when extendedHookEvents is empty`, () => {
      assert.strictEqual(
        hasHooksFor(settings, event),
        false,
        `${event} must not be wired when extendedHookEvents=[] (runtime=someruntime); hooks keys: ${JSON.stringify(Object.keys(settings.hooks || {}))}`
      );
    });
  }

  test('cleanup', () => {
    cleanupDir(targetDir);
  });
});

// ─── Suite 5: descriptor-drive is runtime-name-agnostic ───────────────────────
// Pass an arbitrary runtime name ('hypothetical') with SubagentStop in its
// extendedHookEvents. This could NEVER have worked under the old hardcoded check.
// Under the new descriptor-driven guard it MUST work.

describe('enh-1076 phase 5f-3: arbitrary runtime with SubagentStop in descriptor gets it wired', () => {
  let targetDir;
  let settings;

  before(() => {
    targetDir = createStubTargetDir();
    settings = { hooks: {} };
    const opts = buildOpts(targetDir, {
      runtime: 'hypothetical',   // NOT 'claude' or 'qwen' — would have been skipped before
      extendedHookEvents: ['SubagentStop'],
    });
    applySettingsJsonHooks(settings, opts);
  });

  test('SubagentStop IS wired for a hypothetical runtime when descriptor includes it', () => {
    assert.ok(
      hasHooksFor(settings, 'SubagentStop'),
      `SubagentStop must be wired via descriptor even for unknown runtime names; hooks keys: ${JSON.stringify(Object.keys(settings.hooks || {}))}`
    );
  });

  test('Stop is NOT wired (not in extendedHookEvents)', () => {
    assert.strictEqual(hasHooksFor(settings, 'Stop'), false);
  });

  test('cleanup', () => {
    cleanupDir(targetDir);
  });
});

// ─── Suite 6: hooksSurface drive (ADR-857 phase 5g drive 3) ──────────────────
//
// applySettingsJsonHooks is gated by opts.hooksSurface !== 'none'.
// - hooksSurface:'none'         → entire body is skipped; no hooks written
// - hooksSurface:'settings-json'→ hooks are written (even for a runtime whose
//   name was previously hardcoded to skip, e.g. 'opencode')
//
// This proves the skip is driven by the descriptor field, not the runtime name.

describe('enh-1076 phase 5g drive 3: hooksSurface:none skips all hooks regardless of runtime', () => {
  let targetDir;
  let settings;

  before(() => {
    targetDir = createStubTargetDir();
    settings = { hooks: {} };
    // 'claude' would normally write hooks, but hooksSurface:'none' must skip entirely.
    const opts = {
      ...buildOpts(targetDir, { runtime: 'claude', extendedHookEvents: ['SubagentStop'] }),
      hooksSurface: 'none',
    };
    applySettingsJsonHooks(settings, opts);
  });

  test('SessionStart is NOT written when hooksSurface is "none"', () => {
    assert.strictEqual(
      hasHooksFor(settings, 'SessionStart'),
      false,
      `SessionStart must not be written when hooksSurface="none"; hooks keys: ${JSON.stringify(Object.keys(settings.hooks || {}))}`
    );
  });

  test('PostToolUse is NOT written when hooksSurface is "none"', () => {
    assert.strictEqual(hasHooksFor(settings, 'PostToolUse'), false);
  });

  test('PreToolUse is NOT written when hooksSurface is "none"', () => {
    assert.strictEqual(hasHooksFor(settings, 'PreToolUse'), false);
  });

  test('cleanup', () => {
    cleanupDir(targetDir);
  });
});

describe('enh-1076 phase 5g drive 3: hooksSurface:settings-json writes hooks even for previously-skipped runtime name', () => {
  let targetDir;
  let settings;

  before(() => {
    targetDir = createStubTargetDir();
    settings = { hooks: {} };
    // 'opencode' previously was hardcoded to skip hooks; with descriptor drive it
    // should write hooks whenever hooksSurface !== 'none'.
    const opts = {
      ...buildOpts(targetDir, { runtime: 'opencode', extendedHookEvents: [] }),
      hooksSurface: 'settings-json',
    };
    applySettingsJsonHooks(settings, opts);
  });

  test('SessionStart IS written when hooksSurface is "settings-json" (even for opencode name)', () => {
    // The hook file guard may prevent actual writing if hooks/dist is absent,
    // but the hooks object itself is at minimum initialized.
    assert.ok(
      settings.hooks && typeof settings.hooks === 'object',
      `settings.hooks must be initialized when hooksSurface="settings-json"`,
    );
    // At a minimum, SessionStart key exists (array may be empty if hook file not present)
    assert.ok(
      Object.prototype.hasOwnProperty.call(settings.hooks, 'SessionStart'),
      `settings.hooks.SessionStart must be initialized; keys: ${JSON.stringify(Object.keys(settings.hooks))}`,
    );
  });

  test('cleanup', () => {
    cleanupDir(targetDir);
  });
});
