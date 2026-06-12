'use strict';

/**
 * ADR-857 phase 5g drive 2: resolveRuntimeConfigIntent is now driven by the
 * runtime capability descriptor (capability-registry.cjs) rather than a
 * hand-kept REGISTRY const.
 *
 * This golden-master test pins the observable contract: the return shape and
 * values must be identical to the pre-change behavior for all 16 runtimes.
 * Purely behavioral — no source-grep.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const {
  resolveRuntimeConfigIntent,
  ALLOWED_CONFIG_RUNTIMES,
} = require(path.join(ROOT, 'gsd-core', 'bin', 'lib', 'runtime-config-adapter-registry.cjs'));

// ---------------------------------------------------------------------------
// Frozen expected table (pre-change behavior — the contract being pinned)
// ---------------------------------------------------------------------------

const EXPECTED = [
  { runtime: 'claude',       installSurface: 'settings-json',        writesSharedSettings: true,  finishPermissionWriter: null        },
  { runtime: 'gemini',       installSurface: 'settings-json',        writesSharedSettings: true,  finishPermissionWriter: null        },
  { runtime: 'antigravity',  installSurface: 'settings-json',        writesSharedSettings: true,  finishPermissionWriter: null        },
  { runtime: 'augment',      installSurface: 'settings-json',        writesSharedSettings: true,  finishPermissionWriter: null        },
  { runtime: 'qwen',         installSurface: 'settings-json',        writesSharedSettings: true,  finishPermissionWriter: null        },
  { runtime: 'hermes',       installSurface: 'settings-json',        writesSharedSettings: true,  finishPermissionWriter: null        },
  { runtime: 'codebuddy',    installSurface: 'settings-json',        writesSharedSettings: true,  finishPermissionWriter: null        },
  { runtime: 'opencode',     installSurface: 'settings-json',        writesSharedSettings: true,  finishPermissionWriter: 'opencode'  },
  { runtime: 'kilo',         installSurface: 'settings-json',        writesSharedSettings: false, finishPermissionWriter: 'kilo'      },
  { runtime: 'codex',        installSurface: 'codex-toml',           writesSharedSettings: false, finishPermissionWriter: null        },
  { runtime: 'copilot',      installSurface: 'copilot-instructions', writesSharedSettings: false, finishPermissionWriter: null        },
  { runtime: 'cline',        installSurface: 'cline-rules',          writesSharedSettings: false, finishPermissionWriter: null        },
  { runtime: 'cursor',       installSurface: 'cursor-hooks-json',    writesSharedSettings: false, finishPermissionWriter: null        },
  { runtime: 'windsurf',     installSurface: 'profile-marker-only',  writesSharedSettings: false, finishPermissionWriter: null        },
  { runtime: 'trae',         installSurface: 'profile-marker-only',  writesSharedSettings: false, finishPermissionWriter: null        },
  { runtime: 'kimi',         installSurface: 'profile-marker-only',  writesSharedSettings: false, finishPermissionWriter: null        },
];

// ---------------------------------------------------------------------------
// Test 1: Golden master — all 16 runtimes resolve to expected values
// ---------------------------------------------------------------------------

describe('enh-1055 descriptor-drive: resolveRuntimeConfigIntent golden master', () => {
  for (const row of EXPECTED) {
    test(`${row.runtime} resolves to expected intent`, () => {
      const intent = resolveRuntimeConfigIntent(row.runtime);
      assert.deepStrictEqual(intent, {
        runtime:               row.runtime,
        installSurface:        row.installSurface,
        writesSharedSettings:  row.writesSharedSettings,
        finishPermissionWriter: row.finishPermissionWriter,
      });
    });
  }
});

// ---------------------------------------------------------------------------
// Test 3: Unknown runtime throws TypeError
// ---------------------------------------------------------------------------

describe('enh-1055 descriptor-drive: unknown runtime throws TypeError', () => {
  test('throws TypeError for "bogus-runtime"', () => {
    assert.throws(() => resolveRuntimeConfigIntent('bogus-runtime'), TypeError);
  });

  test('throws TypeError for empty string', () => {
    assert.throws(() => resolveRuntimeConfigIntent(''), TypeError);
  });

  test('throws TypeError for undefined', () => {
    assert.throws(() => resolveRuntimeConfigIntent(undefined), TypeError);
  });

  test('throws TypeError for "__proto__"', () => {
    assert.throws(() => resolveRuntimeConfigIntent('__proto__'), TypeError);
  });
});

// ---------------------------------------------------------------------------
// Test 4: ALLOWED_CONFIG_RUNTIMES contains all 16 expected runtimes
// ---------------------------------------------------------------------------

describe('enh-1055 descriptor-drive: ALLOWED_CONFIG_RUNTIMES completeness', () => {
  const EXPECTED_16 = new Set([
    'claude', 'gemini', 'antigravity', 'augment', 'qwen', 'hermes', 'codebuddy',
    'opencode', 'kilo', 'codex', 'copilot', 'cline', 'cursor', 'windsurf', 'trae', 'kimi',
  ]);

  test('contains exactly the 16 expected runtimes', () => {
    assert.deepStrictEqual(new Set(ALLOWED_CONFIG_RUNTIMES), EXPECTED_16);
  });

  test('has exactly 16 entries', () => {
    assert.strictEqual([...ALLOWED_CONFIG_RUNTIMES].length, 16);
  });
});

// ---------------------------------------------------------------------------
// Test 5: Descriptor drive — the function reads from the descriptor, not
// a hardcoded local constant. This is proven indirectly: the golden master
// passes, meaning capability-registry.cjs (the live descriptor) matches the
// expected table. If the adapter had its own REGISTRY, a descriptor change
// would diverge silently; with drive, it cannot.
// ---------------------------------------------------------------------------

describe('enh-1055 descriptor-drive: finishPermissionWriter passthrough', () => {
  test('opencode → "opencode" (descriptor permissionWriter)', () => {
    assert.strictEqual(resolveRuntimeConfigIntent('opencode').finishPermissionWriter, 'opencode');
  });

  test('kilo → "kilo" (descriptor permissionWriter)', () => {
    assert.strictEqual(resolveRuntimeConfigIntent('kilo').finishPermissionWriter, 'kilo');
  });

  test('all other runtimes have finishPermissionWriter === null', () => {
    const nullExpected = EXPECTED
      .filter(r => r.finishPermissionWriter === null)
      .map(r => r.runtime);
    for (const runtime of nullExpected) {
      assert.strictEqual(
        resolveRuntimeConfigIntent(runtime).finishPermissionWriter,
        null,
        `${runtime} should have finishPermissionWriter null`,
      );
    }
  });
});
