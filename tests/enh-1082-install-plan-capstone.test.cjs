'use strict';

/**
 * Golden-master test for resolveInstallPlan — ADR-857 phase 5g capstone.
 *
 * Pins the exact InstallPlan shape for all 16 runtimes to guard against
 * descriptor drift. Derived from actual resolveInstallPlan output at the time
 * the seam was introduced (2026-06-11). Behavioral: calls the exported
 * function and asserts on typed fields — no source-grep.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { resolveInstallPlan } = require('../gsd-core/bin/lib/runtime-config-adapter-registry.cjs');

// ---------------------------------------------------------------------------
// Frozen golden-master table — derived from actual resolveInstallPlan output
// ---------------------------------------------------------------------------

const EXPECTED = {
  claude: {
    runtime: 'claude',
    installSurface: 'settings-json',
    writesSharedSettings: true,
    finishPermissionWriter: null,
    hookEvents: 'claude',
    extendedHookEvents: ['SubagentStop', 'Stop', 'PreCompact', 'FileChanged'],
    hooksSurface: 'settings-json',
    sandboxTier: 'none',
  },
  codex: {
    runtime: 'codex',
    installSurface: 'codex-toml',
    writesSharedSettings: false,
    finishPermissionWriter: null,
    hookEvents: 'claude',
    extendedHookEvents: [],
    hooksSurface: 'codex-hooks-json',
    sandboxTier: 'codex-agent-sandbox',
  },
  antigravity: {
    runtime: 'antigravity',
    installSurface: 'settings-json',
    writesSharedSettings: true,
    finishPermissionWriter: null,
    hookEvents: 'gemini',
    extendedHookEvents: [],
    hooksSurface: 'settings-json',
    sandboxTier: 'none',
  },
  gemini: {
    runtime: 'gemini',
    installSurface: 'settings-json',
    writesSharedSettings: true,
    finishPermissionWriter: null,
    hookEvents: 'gemini',
    extendedHookEvents: ['BeforeAgent', 'AfterAgent', 'BeforeModel'],
    hooksSurface: 'settings-json',
    sandboxTier: 'none',
  },
  cursor: {
    runtime: 'cursor',
    installSurface: 'cursor-hooks-json',
    writesSharedSettings: false,
    finishPermissionWriter: null,
    hookEvents: 'claude',
    extendedHookEvents: [],
    hooksSurface: 'cursor-hooks-json',
    sandboxTier: 'none',
  },
  opencode: {
    runtime: 'opencode',
    installSurface: 'settings-json',
    writesSharedSettings: true,
    finishPermissionWriter: 'opencode',
    hookEvents: undefined,
    extendedHookEvents: [],
    hooksSurface: 'none',
    sandboxTier: 'none',
  },
  kilo: {
    runtime: 'kilo',
    installSurface: 'settings-json',
    writesSharedSettings: false,
    finishPermissionWriter: 'kilo',
    hookEvents: undefined,
    extendedHookEvents: [],
    hooksSurface: 'none',
    sandboxTier: 'none',
  },
  copilot: {
    runtime: 'copilot',
    installSurface: 'copilot-instructions',
    writesSharedSettings: false,
    finishPermissionWriter: null,
    hookEvents: undefined,
    extendedHookEvents: [],
    hooksSurface: 'copilot-inline',
    sandboxTier: 'none',
  },
  augment: {
    runtime: 'augment',
    installSurface: 'settings-json',
    writesSharedSettings: true,
    finishPermissionWriter: null,
    hookEvents: 'claude',
    extendedHookEvents: [],
    hooksSurface: 'settings-json',
    sandboxTier: 'none',
  },
  trae: {
    runtime: 'trae',
    installSurface: 'profile-marker-only',
    writesSharedSettings: false,
    finishPermissionWriter: null,
    hookEvents: undefined,
    extendedHookEvents: [],
    hooksSurface: 'none',
    sandboxTier: 'none',
  },
  qwen: {
    runtime: 'qwen',
    installSurface: 'settings-json',
    writesSharedSettings: true,
    finishPermissionWriter: null,
    hookEvents: 'claude',
    extendedHookEvents: ['SubagentStop', 'Stop', 'PreCompact'],
    hooksSurface: 'settings-json',
    sandboxTier: 'none',
  },
  hermes: {
    runtime: 'hermes',
    installSurface: 'settings-json',
    writesSharedSettings: true,
    finishPermissionWriter: null,
    hookEvents: 'claude',
    extendedHookEvents: [],
    hooksSurface: 'settings-json',
    sandboxTier: 'none',
  },
  codebuddy: {
    runtime: 'codebuddy',
    installSurface: 'settings-json',
    writesSharedSettings: true,
    finishPermissionWriter: null,
    hookEvents: 'claude',
    extendedHookEvents: [],
    hooksSurface: 'settings-json',
    sandboxTier: 'none',
  },
  cline: {
    runtime: 'cline',
    installSurface: 'cline-rules',
    writesSharedSettings: false,
    finishPermissionWriter: null,
    hookEvents: undefined,
    extendedHookEvents: [],
    hooksSurface: 'cline-rules',
    sandboxTier: 'none',
  },
  kimi: {
    runtime: 'kimi',
    installSurface: 'profile-marker-only',
    writesSharedSettings: false,
    finishPermissionWriter: null,
    hookEvents: undefined,
    extendedHookEvents: [],
    hooksSurface: 'none',
    sandboxTier: 'none',
  },
  windsurf: {
    runtime: 'windsurf',
    installSurface: 'profile-marker-only',
    writesSharedSettings: false,
    finishPermissionWriter: null,
    hookEvents: undefined,
    extendedHookEvents: [],
    hooksSurface: 'none',
    sandboxTier: 'none',
  },
};

const ALL_RUNTIMES = Object.keys(EXPECTED);

describe('resolveInstallPlan — ADR-857 phase 5g golden master', () => {
  it('covers exactly 16 runtimes', () => {
    assert.strictEqual(ALL_RUNTIMES.length, 16);
  });

  for (const runtime of ALL_RUNTIMES) {
    it(`resolveInstallPlan('${runtime}') matches frozen plan`, () => {
      const actual = resolveInstallPlan(runtime);
      assert.deepStrictEqual(actual, EXPECTED[runtime],
        `InstallPlan for '${runtime}' drifted from golden master`);
    });
  }

  it('resolveInstallPlan throws TypeError for unknown runtime', () => {
    assert.throws(
      () => resolveInstallPlan('bogus'),
      (err) => err instanceof TypeError && /bogus/.test(err.message),
    );
  });

  it('extendedHookEvents is always an array for every runtime', () => {
    for (const runtime of ALL_RUNTIMES) {
      const plan = resolveInstallPlan(runtime);
      assert.ok(Array.isArray(plan.extendedHookEvents),
        `${runtime}: extendedHookEvents should be an array`);
    }
  });

  it('hooksSurface is always a non-empty string for every runtime', () => {
    for (const runtime of ALL_RUNTIMES) {
      const plan = resolveInstallPlan(runtime);
      assert.strictEqual(typeof plan.hooksSurface, 'string',
        `${runtime}: hooksSurface should be a string`);
      assert.ok(plan.hooksSurface.length > 0,
        `${runtime}: hooksSurface should not be empty`);
    }
  });

  it('parity: resolveInstallPlan config-intent fields match resolveRuntimeConfigIntent', () => {
    // Guard that resolveInstallPlan composes resolveRuntimeConfigIntent correctly —
    // any drift between the two would silently break install().
    const { resolveRuntimeConfigIntent } = require('../gsd-core/bin/lib/runtime-config-adapter-registry.cjs');
    for (const runtime of ALL_RUNTIMES) {
      const plan = resolveInstallPlan(runtime);
      const intent = resolveRuntimeConfigIntent(runtime);
      assert.strictEqual(plan.installSurface, intent.installSurface,
        `${runtime}: installSurface mismatch between plan and intent`);
      assert.strictEqual(plan.writesSharedSettings, intent.writesSharedSettings,
        `${runtime}: writesSharedSettings mismatch`);
      assert.strictEqual(plan.finishPermissionWriter, intent.finishPermissionWriter,
        `${runtime}: finishPermissionWriter mismatch`);
    }
  });
});
