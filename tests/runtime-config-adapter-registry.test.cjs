'use strict';

// Tests for runtime-config-adapter-registry.cjs (issue #60).
// TDD: this file is written BEFORE the implementation to establish the red state.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const {
  resolveRuntimeConfigIntent,
  ALLOWED_CONFIG_RUNTIMES,
  INSTALL_SURFACES,
} = require(path.join(ROOT, 'gsd-core', 'bin', 'lib', 'runtime-config-adapter-registry.cjs'));

// ---------------------------------------------------------------------------
// Source-of-truth table (mirrors the intent table in the brief exactly)
// ---------------------------------------------------------------------------

const EXPECTED_TABLE = [
  { runtime: 'claude',      installSurface: 'settings-json',        writesSharedSettings: true,  finishPermissionWriter: null       },
  { runtime: 'gemini',      installSurface: 'settings-json',        writesSharedSettings: true,  finishPermissionWriter: null       },
  { runtime: 'antigravity', installSurface: 'settings-json',        writesSharedSettings: true,  finishPermissionWriter: null       },
  { runtime: 'augment',     installSurface: 'settings-json',        writesSharedSettings: true,  finishPermissionWriter: null       },
  { runtime: 'qwen',        installSurface: 'settings-json',        writesSharedSettings: true,  finishPermissionWriter: null       },
  { runtime: 'hermes',      installSurface: 'settings-json',        writesSharedSettings: true,  finishPermissionWriter: null       },
  { runtime: 'codebuddy',   installSurface: 'settings-json',        writesSharedSettings: true,  finishPermissionWriter: null       },
  { runtime: 'opencode',    installSurface: 'settings-json',        writesSharedSettings: true,  finishPermissionWriter: 'opencode' },
  { runtime: 'kilo',        installSurface: 'settings-json',        writesSharedSettings: false, finishPermissionWriter: 'kilo'     },
  { runtime: 'codex',       installSurface: 'codex-toml',           writesSharedSettings: false, finishPermissionWriter: null       },
  { runtime: 'copilot',     installSurface: 'copilot-instructions', writesSharedSettings: false, finishPermissionWriter: null       },
  { runtime: 'cline',       installSurface: 'cline-rules',          writesSharedSettings: false, finishPermissionWriter: null       },
  { runtime: 'cursor',      installSurface: 'cursor-hooks-json',    writesSharedSettings: false, finishPermissionWriter: null       },
  { runtime: 'omp',         installSurface: 'profile-marker-only',  writesSharedSettings: false, finishPermissionWriter: null       },
  { runtime: 'windsurf',    installSurface: 'profile-marker-only',  writesSharedSettings: false, finishPermissionWriter: null       },
  { runtime: 'trae',        installSurface: 'profile-marker-only',  writesSharedSettings: false, finishPermissionWriter: null       },
  { runtime: 'kimi',        installSurface: 'profile-marker-only',  writesSharedSettings: false, finishPermissionWriter: null       },
];

// ---------------------------------------------------------------------------
// Test 1: Table-lock — every row in EXPECTED_TABLE must match exactly
// ---------------------------------------------------------------------------

describe('resolveRuntimeConfigIntent — table-lock', () => {
  for (const row of EXPECTED_TABLE) {
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
// Test 2: Unknown runtime fails loudly (AC#2)
// ---------------------------------------------------------------------------

describe('resolveRuntimeConfigIntent — unknown runtime throws TypeError', () => {
  test('throws TypeError for unknown string "grok"', () => {
    assert.throws(() => resolveRuntimeConfigIntent('grok'), TypeError);
  });

  test('throws TypeError for unknown string "xyzunknown"', () => {
    assert.throws(() => resolveRuntimeConfigIntent('xyzunknown'), TypeError);
  });

  test('throws TypeError for empty string ""', () => {
    assert.throws(() => resolveRuntimeConfigIntent(''), TypeError);
  });

  test('throws TypeError for undefined', () => {
    assert.throws(() => resolveRuntimeConfigIntent(undefined), TypeError);
  });

  test('throws TypeError for "__proto__" (prototype-chain key)', () => {
    assert.throws(() => resolveRuntimeConfigIntent('__proto__'), TypeError);
  });

  test('throws TypeError for "constructor" (prototype-chain key)', () => {
    assert.throws(() => resolveRuntimeConfigIntent('constructor'), TypeError);
  });

  test('throws TypeError for "hasOwnProperty" (prototype-chain key)', () => {
    assert.throws(() => resolveRuntimeConfigIntent('hasOwnProperty'), TypeError);
  });

  test('throws TypeError for "toString" (prototype-chain key)', () => {
    assert.throws(() => resolveRuntimeConfigIntent('toString'), TypeError);
  });
});

// ---------------------------------------------------------------------------
// Test 3: writesSharedSettings exclusion equivalence
// ---------------------------------------------------------------------------

describe('writesSharedSettings exclusion equivalence', () => {
  const EXPECTED_FALSE_SET = new Set(['codex', 'copilot', 'kilo', 'cursor', 'windsurf', 'trae', 'cline', 'kimi', 'omp']);

  test('runtimes with writesSharedSettings===false are exactly the exclusion set', () => {
    const falseRuntimes = EXPECTED_TABLE
      .filter(r => r.writesSharedSettings === false)
      .map(r => r.runtime);
    assert.deepStrictEqual(new Set(falseRuntimes), EXPECTED_FALSE_SET);
  });

  test('all other supported runtimes have writesSharedSettings===true', () => {
    const trueRuntimes = EXPECTED_TABLE
      .filter(r => r.writesSharedSettings === true)
      .map(r => r.runtime);
    for (const runtime of trueRuntimes) {
      assert.ok(!EXPECTED_FALSE_SET.has(runtime), `${runtime} should have writesSharedSettings true`);
    }
  });
});

// ---------------------------------------------------------------------------
// Test 4: finishPermissionWriter correctness
// ---------------------------------------------------------------------------

describe('finishPermissionWriter', () => {
  test('opencode -> "opencode"', () => {
    assert.strictEqual(resolveRuntimeConfigIntent('opencode').finishPermissionWriter, 'opencode');
  });

  test('kilo -> "kilo"', () => {
    assert.strictEqual(resolveRuntimeConfigIntent('kilo').finishPermissionWriter, 'kilo');
  });

  test('every other supported runtime -> null', () => {
    const nullExpected = EXPECTED_TABLE
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

// ---------------------------------------------------------------------------
// Test 5: Distinct dedicated surfaces
// ---------------------------------------------------------------------------

describe('installSurface correctness', () => {
  test('codex -> "codex-toml"', () => {
    assert.strictEqual(resolveRuntimeConfigIntent('codex').installSurface, 'codex-toml');
  });

  test('copilot -> "copilot-instructions"', () => {
    assert.strictEqual(resolveRuntimeConfigIntent('copilot').installSurface, 'copilot-instructions');
  });

  test('cline -> "cline-rules"', () => {
    assert.strictEqual(resolveRuntimeConfigIntent('cline').installSurface, 'cline-rules');
  });

  test('cursor -> "cursor-hooks-json"', () => {
    assert.strictEqual(resolveRuntimeConfigIntent('cursor').installSurface, 'cursor-hooks-json');
  });

  test('windsurf -> "profile-marker-only"', () => {
    assert.strictEqual(resolveRuntimeConfigIntent('windsurf').installSurface, 'profile-marker-only');
  });

  test('trae -> "profile-marker-only"', () => {
    assert.strictEqual(resolveRuntimeConfigIntent('trae').installSurface, 'profile-marker-only');
  });

  test('kimi -> "profile-marker-only"', () => {
    assert.strictEqual(resolveRuntimeConfigIntent('kimi').installSurface, 'profile-marker-only');
  });

  test('the 7 passthroughs + opencode + kilo -> "settings-json"', () => {
    const settingsJsonRuntimes = ['claude', 'gemini', 'antigravity', 'augment', 'qwen', 'hermes', 'codebuddy', 'opencode', 'kilo'];
    for (const runtime of settingsJsonRuntimes) {
      assert.strictEqual(
        resolveRuntimeConfigIntent(runtime).installSurface,
        'settings-json',
        `${runtime} should have installSurface "settings-json"`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Test 6: Returned intent is a fresh object (no shared reference mutation)
// ---------------------------------------------------------------------------

describe('resolveRuntimeConfigIntent — fresh object each call', () => {
  test('mutating the returned object does not affect a subsequent resolve', () => {
    const first = resolveRuntimeConfigIntent('claude');
    first.installSurface = 'MUTATED';
    first.writesSharedSettings = false;

    const second = resolveRuntimeConfigIntent('claude');
    assert.strictEqual(second.installSurface, 'settings-json');
    assert.strictEqual(second.writesSharedSettings, true);
  });
});

// ---------------------------------------------------------------------------
// Test 7: Completeness (AC#4 table-driven) — ALLOWED_CONFIG_RUNTIMES
// ---------------------------------------------------------------------------

describe('ALLOWED_CONFIG_RUNTIMES completeness', () => {
  const EXPECTED_17 = new Set([
    'claude', 'gemini', 'antigravity', 'augment', 'qwen', 'hermes', 'codebuddy',
    'opencode', 'kilo', 'codex', 'copilot', 'cline', 'cursor', 'windsurf', 'trae',
    'kimi', 'omp',
  ]);

  test('ALLOWED_CONFIG_RUNTIMES contains exactly the 17 expected runtimes', () => {
    const runtimeSet = new Set(ALLOWED_CONFIG_RUNTIMES);
    assert.deepStrictEqual(runtimeSet, EXPECTED_17);
  });

  test('every member of ALLOWED_CONFIG_RUNTIMES resolves without throwing', () => {
    for (const runtime of ALLOWED_CONFIG_RUNTIMES) {
      assert.doesNotThrow(() => resolveRuntimeConfigIntent(runtime), `${runtime} should resolve without throwing`);
    }
  });

  test('ALLOWED_CONFIG_RUNTIMES has exactly 17 entries', () => {
    assert.strictEqual([...ALLOWED_CONFIG_RUNTIMES].length, 17);
  });
});

// ---------------------------------------------------------------------------
// Test 8: INSTALL_SURFACES export
// ---------------------------------------------------------------------------

describe('INSTALL_SURFACES export', () => {
  const EXPECTED_SURFACES = new Set([
    'settings-json',
    'codex-toml',
    'copilot-instructions',
    'cline-rules',
    'cursor-hooks-json',
    'profile-marker-only',
  ]);

  test('INSTALL_SURFACES contains exactly the 6 surface strings', () => {
    assert.deepStrictEqual(new Set(INSTALL_SURFACES), EXPECTED_SURFACES);
  });
});
