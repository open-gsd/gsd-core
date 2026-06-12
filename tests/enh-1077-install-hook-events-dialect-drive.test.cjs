'use strict';

process.env.GSD_TEST_MODE = '1';

/**
 * ADR-857 phase 5f-2: hook-events dialect is driven from the registry descriptor.
 *
 * Before this change, postToolEvent and preToolEvent were hardcoded strings
 * derived from runtime-name checks:
 *
 *   (runtime === 'gemini' || runtime === 'antigravity') ? 'AfterTool'  : 'PostToolUse'
 *   (runtime === 'gemini' || runtime === 'antigravity') ? 'BeforeTool' : 'PreToolUse'
 *
 * After phase 5f-2, both are driven by the registry descriptor's
 * `hookEvents` field: hookEvents === 'gemini' → AfterTool/BeforeTool;
 * any other value (or missing) → PostToolUse/PreToolUse.
 *
 * Equivalence (i.e. identical observable behaviour for all runtimes):
 *   hookEvents === 'gemini'  iff  runtime ∈ {gemini, antigravity}
 *
 * This suite asserts the equivalence and the registry-parity invariant:
 * any runtime whose descriptor carries hookEvents='gemini' gets the
 * AfterTool/BeforeTool dialect; all others get PostToolUse/PreToolUse.
 */

const { test, describe, before, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { install } = require('../bin/install.js');
const { createTempDir, cleanup } = require('./helpers.cjs');

// ─── hooks/dist build guard ───────────────────────────────────────────────────
//
// hooks/dist/ is gitignored and only produced by `npm run build:hooks`.
// In CI the scoped/windows test jobs do NOT run build:hooks before running
// tests, so install() finds no hook files → event arrays come back empty →
// every "expected AfterTool/PostToolUse/BeforeTool/PreToolUse hooks" assertion
// fails. This mirrors the pattern in bug-376-claude-js-hook-gsd-rewriter.test.cjs.

const REPO_ROOT = path.resolve(__dirname, '..');
const HOOKS_DIST_DIR = path.join(REPO_ROOT, 'hooks', 'dist');
const BUILD_HOOKS_SCRIPT = path.join(REPO_ROOT, 'scripts', 'build-hooks.js');

/**
 * Idempotently ensure hooks/dist contains built .js files.
 * Runs build-hooks.js only when the directory is absent or empty of .js files.
 */
function ensureHooksDist() {
  if (!fs.existsSync(HOOKS_DIST_DIR) || fs.readdirSync(HOOKS_DIST_DIR).filter(f => f.endsWith('.js')).length === 0) {
    execFileSync(process.execPath, [BUILD_HOOKS_SCRIPT], { stdio: 'pipe' });
  }
}

before(() => {
  ensureHooksDist();
});

// ─── Registry lookup ──────────────────────────────────────────────────────────

const REGISTRY_PATH = path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'capability-registry.cjs');
const registry = (() => {
  try { return require(REGISTRY_PATH); } catch { return undefined; }
})();

/**
 * Return the hookEvents dialect for a runtime ID from the live registry.
 * Returns undefined when the registry is absent or the runtime has no descriptor.
 */
function registryHookEvents(runtimeId) {
  return registry?.runtimes?.[runtimeId]?.runtime?.hookEvents;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Collect all hook commands registered under a settings event key. */
function hooksForEvent(settings, eventName) {
  if (!settings || !settings.hooks || !Array.isArray(settings.hooks[eventName])) return [];
  return settings.hooks[eventName].flatMap(entry =>
    (entry && Array.isArray(entry.hooks) ? entry.hooks : [])
      .map(h => h && h.command)
      .filter(Boolean)
  );
}

/** True if at least one hook is registered under eventName. */
function hasHooksFor(settings, eventName) {
  return hooksForEvent(settings, eventName).length > 0;
}

// ─── Suite 1: Gemini-dialect runtimes use AfterTool/BeforeTool ───────────────
//
// Registry runtimes with hookEvents='gemini': gemini, antigravity

describe('enh-1077 phase 5f-2: gemini hookEvents dialect → AfterTool/BeforeTool', () => {
  // ── gemini ──

  describe('gemini install uses AfterTool for post-tool hooks', () => {
    let tmpDir;
    let previousCwd;
    let settings;

    beforeEach(() => {
      tmpDir = createTempDir('gsd-1077-gemini-');
      previousCwd = process.cwd();
      process.chdir(tmpDir);

      const geminiDir = path.join(tmpDir, '.gemini');
      fs.mkdirSync(geminiDir, { recursive: true });
      const result = install(false, 'gemini');
      settings = result && result.settings;
    });

    afterEach(() => {
      process.chdir(previousCwd);
      cleanup(tmpDir);
    });

    test('registry confirms gemini hookEvents is "gemini"', () => {
      // Parity assertion: if the registry changes, this test fails first.
      const he = registryHookEvents('gemini');
      if (he !== undefined) {
        assert.strictEqual(he, 'gemini',
          'Registry descriptor for gemini must declare hookEvents="gemini"');
      }
    });

    test('gemini install returns a settings object', () => {
      assert.ok(settings !== null && typeof settings === 'object',
        'gemini install must return a non-null settings object');
    });

    test('gemini install registers at least one hook under AfterTool (post-tool)', () => {
      assert.ok(hasHooksFor(settings, 'AfterTool'),
        `Expected AfterTool hooks on gemini; got hooks keys: ${JSON.stringify(Object.keys((settings && settings.hooks) || {}))}`);
    });

    test('gemini install does NOT register context-monitor under PostToolUse (wrong dialect)', () => {
      const cmds = hooksForEvent(settings, 'PostToolUse');
      const hasMonitor = cmds.some(c => c && c.includes('gsd-context-monitor'));
      assert.strictEqual(hasMonitor, false,
        `gemini must NOT use PostToolUse for context-monitor; got PostToolUse commands: ${JSON.stringify(cmds)}`);
    });

    test('gemini install registers at least one pre-tool hook (prompt-guard) under BeforeTool', () => {
      const cmds = hooksForEvent(settings, 'BeforeTool');
      const hasPromptGuard = cmds.some(c => c && c.includes('gsd-prompt-guard'));
      assert.ok(hasPromptGuard,
        `Expected prompt-guard hook under BeforeTool on gemini; BeforeTool commands: ${JSON.stringify(cmds)}; hooks keys: ${JSON.stringify(Object.keys((settings && settings.hooks) || {}))}`);
    });

    test('gemini install does NOT register prompt-guard under PreToolUse (wrong pre-tool dialect)', () => {
      const cmds = hooksForEvent(settings, 'PreToolUse');
      const hasPromptGuard = cmds.some(c => c && c.includes('gsd-prompt-guard'));
      assert.strictEqual(hasPromptGuard, false,
        `gemini must NOT use PreToolUse for prompt-guard; got PreToolUse commands: ${JSON.stringify(cmds)}`);
    });
  });

  // ── antigravity ──

  describe('antigravity install uses AfterTool/BeforeTool (gemini dialect)', () => {
    let tmpDir;
    let previousCwd;
    let settings;

    beforeEach(() => {
      tmpDir = createTempDir('gsd-1077-antigrav-');
      previousCwd = process.cwd();
      process.chdir(tmpDir);

      const agDir = path.join(tmpDir, '.gemini', 'antigravity');
      fs.mkdirSync(agDir, { recursive: true });
      const result = install(false, 'antigravity');
      settings = result && result.settings;
    });

    afterEach(() => {
      process.chdir(previousCwd);
      cleanup(tmpDir);
    });

    test('registry confirms antigravity hookEvents is "gemini"', () => {
      const he = registryHookEvents('antigravity');
      if (he !== undefined) {
        assert.strictEqual(he, 'gemini',
          'Registry descriptor for antigravity must declare hookEvents="gemini"');
      }
    });

    test('antigravity install returns a settings object', () => {
      assert.ok(settings !== null && typeof settings === 'object',
        'antigravity install must return a non-null settings object');
    });

    test('antigravity install registers at least one hook under AfterTool', () => {
      assert.ok(hasHooksFor(settings, 'AfterTool'),
        `Expected AfterTool hooks on antigravity; got hooks keys: ${JSON.stringify(Object.keys((settings && settings.hooks) || {}))}`);
    });

    test('antigravity install does NOT register context-monitor under PostToolUse', () => {
      const cmds = hooksForEvent(settings, 'PostToolUse');
      const hasMonitor = cmds.some(c => c && c.includes('gsd-context-monitor'));
      assert.strictEqual(hasMonitor, false,
        `antigravity must NOT use PostToolUse for context-monitor; got: ${JSON.stringify(cmds)}`);
    });

    test('antigravity install registers at least one pre-tool hook (prompt-guard) under BeforeTool', () => {
      const cmds = hooksForEvent(settings, 'BeforeTool');
      const hasPromptGuard = cmds.some(c => c && c.includes('gsd-prompt-guard'));
      assert.ok(hasPromptGuard,
        `Expected prompt-guard hook under BeforeTool on antigravity; BeforeTool commands: ${JSON.stringify(cmds)}; hooks keys: ${JSON.stringify(Object.keys((settings && settings.hooks) || {}))}`);
    });

    test('antigravity install does NOT register prompt-guard under PreToolUse (wrong pre-tool dialect)', () => {
      const cmds = hooksForEvent(settings, 'PreToolUse');
      const hasPromptGuard = cmds.some(c => c && c.includes('gsd-prompt-guard'));
      assert.strictEqual(hasPromptGuard, false,
        `antigravity must NOT use PreToolUse for prompt-guard; got PreToolUse commands: ${JSON.stringify(cmds)}`);
    });
  });
});

// ─── Suite 2: Claude-dialect runtimes use PostToolUse/PreToolUse ──────────────
//
// Registry runtimes with hookEvents='claude': claude, augment

describe('enh-1077 phase 5f-2: claude hookEvents dialect → PostToolUse/PreToolUse', () => {
  // ── claude ──

  describe('claude install uses PostToolUse for post-tool hooks', () => {
    let tmpDir;
    let previousCwd;
    let settings;

    beforeEach(() => {
      tmpDir = createTempDir('gsd-1077-claude-');
      previousCwd = process.cwd();
      process.chdir(tmpDir);

      const claudeDir = path.join(tmpDir, '.claude');
      fs.mkdirSync(claudeDir, { recursive: true });
      const result = install(false, 'claude');
      settings = result && result.settings;
    });

    afterEach(() => {
      process.chdir(previousCwd);
      cleanup(tmpDir);
    });

    test('registry confirms claude hookEvents is "claude"', () => {
      const he = registryHookEvents('claude');
      if (he !== undefined) {
        assert.strictEqual(he, 'claude',
          'Registry descriptor for claude must declare hookEvents="claude"');
      }
    });

    test('claude install returns a settings object', () => {
      assert.ok(settings !== null && typeof settings === 'object',
        'claude install must return a non-null settings object');
    });

    test('claude install registers at least one hook under PostToolUse', () => {
      assert.ok(hasHooksFor(settings, 'PostToolUse'),
        `Expected PostToolUse hooks on claude; got hooks keys: ${JSON.stringify(Object.keys((settings && settings.hooks) || {}))}`);
    });

    test('claude install does NOT register context-monitor under AfterTool (wrong dialect)', () => {
      const cmds = hooksForEvent(settings, 'AfterTool');
      const hasMonitor = cmds.some(c => c && c.includes('gsd-context-monitor'));
      assert.strictEqual(hasMonitor, false,
        `claude must NOT use AfterTool for context-monitor; got AfterTool commands: ${JSON.stringify(cmds)}`);
    });

    test('claude install registers at least one pre-tool hook (prompt-guard) under PreToolUse', () => {
      const cmds = hooksForEvent(settings, 'PreToolUse');
      const hasPromptGuard = cmds.some(c => c && c.includes('gsd-prompt-guard'));
      assert.ok(hasPromptGuard,
        `Expected prompt-guard hook under PreToolUse on claude; PreToolUse commands: ${JSON.stringify(cmds)}; hooks keys: ${JSON.stringify(Object.keys((settings && settings.hooks) || {}))}`);
    });

    test('claude install does NOT register prompt-guard under BeforeTool (wrong pre-tool dialect)', () => {
      const cmds = hooksForEvent(settings, 'BeforeTool');
      const hasPromptGuard = cmds.some(c => c && c.includes('gsd-prompt-guard'));
      assert.strictEqual(hasPromptGuard, false,
        `claude must NOT use BeforeTool for prompt-guard; got BeforeTool commands: ${JSON.stringify(cmds)}`);
    });
  });

  // ── augment ──

  describe('augment install uses PostToolUse/PreToolUse (claude dialect)', () => {
    let tmpDir;
    let previousCwd;
    let settings;

    beforeEach(() => {
      tmpDir = createTempDir('gsd-1077-augment-');
      previousCwd = process.cwd();
      process.chdir(tmpDir);

      const augDir = path.join(tmpDir, '.augment');
      fs.mkdirSync(augDir, { recursive: true });
      const result = install(false, 'augment');
      settings = result && result.settings;
    });

    afterEach(() => {
      process.chdir(previousCwd);
      cleanup(tmpDir);
    });

    test('registry confirms augment hookEvents is "claude"', () => {
      const he = registryHookEvents('augment');
      if (he !== undefined) {
        assert.strictEqual(he, 'claude',
          'Registry descriptor for augment must declare hookEvents="claude"');
      }
    });

    test('augment install returns a settings object', () => {
      assert.ok(settings !== null && typeof settings === 'object',
        'augment install must return a non-null settings object');
    });

    test('augment install registers at least one hook under PostToolUse', () => {
      assert.ok(hasHooksFor(settings, 'PostToolUse'),
        `Expected PostToolUse hooks on augment; got hooks keys: ${JSON.stringify(Object.keys((settings && settings.hooks) || {}))}`);
    });

    test('augment install does NOT register context-monitor under AfterTool', () => {
      const cmds = hooksForEvent(settings, 'AfterTool');
      const hasMonitor = cmds.some(c => c && c.includes('gsd-context-monitor'));
      assert.strictEqual(hasMonitor, false,
        `augment must NOT use AfterTool for context-monitor; got: ${JSON.stringify(cmds)}`);
    });

    test('augment install registers at least one pre-tool hook (prompt-guard) under PreToolUse', () => {
      const cmds = hooksForEvent(settings, 'PreToolUse');
      const hasPromptGuard = cmds.some(c => c && c.includes('gsd-prompt-guard'));
      assert.ok(hasPromptGuard,
        `Expected prompt-guard hook under PreToolUse on augment; PreToolUse commands: ${JSON.stringify(cmds)}; hooks keys: ${JSON.stringify(Object.keys((settings && settings.hooks) || {}))}`);
    });

    test('augment install does NOT register prompt-guard under BeforeTool (wrong pre-tool dialect)', () => {
      const cmds = hooksForEvent(settings, 'BeforeTool');
      const hasPromptGuard = cmds.some(c => c && c.includes('gsd-prompt-guard'));
      assert.strictEqual(hasPromptGuard, false,
        `augment must NOT use BeforeTool for prompt-guard; got BeforeTool commands: ${JSON.stringify(cmds)}`);
    });
  });
});

// ─── Suite 3: Registry-parity invariant ──────────────────────────────────────
//
// For every runtime in the registry that exposes a settings.json surface
// (i.e. hookEvents is defined), assert that the installed hook dialect matches
// the registry value. This is the generative-fix parity assertion
// (DEFECT.GENERATIVE-FIX): adding a new runtime with hookEvents to the
// registry automatically requires a passing install test for that runtime.

describe('enh-1077 phase 5f-2: registry-parity — hookEvents descriptor drives install dialect', () => {
  test('all registry runtimes with hookEvents use the matching install dialect', () => {
    if (!registry || !registry.runtimes) {
      // Registry absent — skip parity check (equivalence still verified above)
      return;
    }

    // Runtimes that have settings.json surfaces and a hookEvents descriptor
    const SETTINGS_JSON_RUNTIMES = ['claude', 'gemini', 'antigravity', 'augment', 'qwen', 'hermes', 'codebuddy'];

    const failures = [];

    for (const runtimeId of SETTINGS_JSON_RUNTIMES) {
      const he = registryHookEvents(runtimeId);
      if (he === undefined) continue; // no hookEvents in descriptor — skip

      const expectedPostEvent = he === 'gemini' ? 'AfterTool' : 'PostToolUse';
      const unexpectedPostEvent = he === 'gemini' ? 'PostToolUse' : 'AfterTool';
      const expectedPreEvent = he === 'gemini' ? 'BeforeTool' : 'PreToolUse';
      const unexpectedPreEvent = he === 'gemini' ? 'PreToolUse' : 'BeforeTool';

      const previousCwd = process.cwd();
      const tmpDir = createTempDir(`gsd-1077-parity-${runtimeId}-`);
      try {
        process.chdir(tmpDir);
        const result = install(false, runtimeId);
        const settings = result && result.settings;
        if (!settings) continue; // non-settings-json surface, skip

        // Post-tool event assertions
        const hasExpected = hasHooksFor(settings, expectedPostEvent);
        const hasUnexpected = hooksForEvent(settings, unexpectedPostEvent)
          .some(c => c && c.includes('gsd-context-monitor'));

        if (!hasExpected) {
          failures.push(`${runtimeId}: expected context-monitor hook under ${expectedPostEvent} (hookEvents=${he}), but none found`);
        }
        if (hasUnexpected) {
          failures.push(`${runtimeId}: must NOT register context-monitor under ${unexpectedPostEvent}, but it was found`);
        }

        // Pre-tool event assertions: prompt-guard must land under the dialect-correct key.
        const preToolCmdsExpected = hooksForEvent(settings, expectedPreEvent);
        const hasPromptGuardExpected = preToolCmdsExpected.some(c => c && c.includes('gsd-prompt-guard'));
        const preToolCmdsUnexpected = hooksForEvent(settings, unexpectedPreEvent);
        const hasPromptGuardUnexpected = preToolCmdsUnexpected.some(c => c && c.includes('gsd-prompt-guard'));

        if (!hasPromptGuardExpected) {
          failures.push(`${runtimeId}: expected prompt-guard hook under ${expectedPreEvent} (hookEvents=${he}), but none found; ${expectedPreEvent} cmds: ${JSON.stringify(preToolCmdsExpected)}`);
        }
        if (hasPromptGuardUnexpected) {
          failures.push(`${runtimeId}: must NOT register prompt-guard under ${unexpectedPreEvent} (hookEvents=${he}), but it was found`);
        }
      } finally {
        process.chdir(previousCwd);
        cleanup(tmpDir);
      }
    }

    assert.deepEqual(failures, [],
      'Registry-parity failures (hookEvents descriptor must drive install dialect):\n' +
      failures.join('\n'));
  });
});
