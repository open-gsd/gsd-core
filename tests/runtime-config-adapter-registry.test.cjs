'use strict';

// Tests for runtime-config-adapter-registry.cjs (issue #60).
//
// 1.7.0 (ADR-1016 / ADR-1239) makes runtimes pluggable data descriptors, and
// resolveRuntimeConfigIntent / resolveInstallPlan are PURE PROJECTIONS of those
// descriptors. So this file asserts the PROJECTION CONTRACT — that each
// function maps descriptor fields to the intent/plan shape correctly (right
// field names, right null-handling, right types) — for EVERY runtime in the
// registry, rather than pinning a frozen per-runtime value snapshot that would
// have to be hand-edited on every runtime addition. The EXPECTED_TABLE below is
// DERIVED from the capability registry at load time; adding a runtime descriptor
// requires zero changes here.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const {
  resolveRuntimeConfigIntent,
  resolveInstallPlan,
  resolveInstallPlanFromRuntimes,
  ALLOWED_CONFIG_RUNTIMES,
  INSTALL_SURFACES,
} = require(path.join(ROOT, 'gsd-core', 'bin', 'lib', 'runtime-config-adapter-registry.cjs'));
const registry = require(path.join(ROOT, 'gsd-core', 'bin', 'lib', 'capability-registry.cjs'));

// ---------------------------------------------------------------------------
// Source-of-truth table — DERIVED from the capability registry descriptors.
// Each row is the descriptor projection of one runtime's config intent. This is
// deliberately non-circular: production reads the descriptor too, and this
// asserts the mapping (field names, null-coalescing of permissionWriter, etc.)
// is correct for every present and future runtime.
// ---------------------------------------------------------------------------

const EXPECTED_TABLE = Object.keys(registry.runtimes).map((id) => {
  const r = registry.runtimes[id].runtime;
  const pw = r.permissionWriter;
  return {
    runtime: id,
    installSurface: r.installSurface,
    writesSharedSettings: r.writesSharedSettings,
    finishPermissionWriter: pw == null ? null : pw,
  };
});

// ---------------------------------------------------------------------------
// Test 1: Projection contract — every registry runtime resolves to its
// descriptor-derived intent (count-agnostic).
// ---------------------------------------------------------------------------

describe('resolveRuntimeConfigIntent — projection contract', () => {
  test('every registry runtime resolves to its descriptor-derived intent', () => {
    assert.ok(EXPECTED_TABLE.length > 0, 'registry must contain at least one runtime');
    for (const row of EXPECTED_TABLE) {
      assert.deepStrictEqual(resolveRuntimeConfigIntent(row.runtime), {
        runtime: row.runtime,
        installSurface: row.installSurface,
        writesSharedSettings: row.writesSharedSettings,
        finishPermissionWriter: row.finishPermissionWriter,
      }, `resolveRuntimeConfigIntent('${row.runtime}') must match the descriptor projection`);
    }
  });
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
// Test 3: writesSharedSettings — derived equivalence (count-agnostic).
// The runtimes resolving to false are exactly those whose descriptor declares
// writesSharedSettings===false.
// ---------------------------------------------------------------------------

describe('writesSharedSettings — descriptor-driven equivalence', () => {
  test('runtimes resolving writesSharedSettings===false are exactly the descriptor-declared false set', () => {
    const falseRuntimes = EXPECTED_TABLE
      .filter(r => r.writesSharedSettings === false)
      .map(r => r.runtime)
      .sort();
    const descriptorFalse = Object.keys(registry.runtimes)
      .filter((id) => registry.runtimes[id].runtime.writesSharedSettings === false)
      .sort();
    assert.deepStrictEqual(falseRuntimes, descriptorFalse);
  });
});

// ---------------------------------------------------------------------------
// Test 4: finishPermissionWriter — opencode/kilo are non-null, the rest null.
// Spot-check the two non-null writers (stable curated values) plus the
// descriptor-derived null set.
// ---------------------------------------------------------------------------

describe('finishPermissionWriter', () => {
  test('opencode -> "opencode"', () => {
    assert.strictEqual(resolveRuntimeConfigIntent('opencode').finishPermissionWriter, 'opencode');
  });

  test('kilo -> "kilo"', () => {
    assert.strictEqual(resolveRuntimeConfigIntent('kilo').finishPermissionWriter, 'kilo');
  });

  test('every registry runtime whose descriptor permissionWriter is null/absent resolves to null', () => {
    for (const row of EXPECTED_TABLE.filter((r) => r.finishPermissionWriter === null)) {
      assert.strictEqual(
        resolveRuntimeConfigIntent(row.runtime).finishPermissionWriter,
        null,
        `${row.runtime} should have finishPermissionWriter null`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Test 5: installSurface — spot-check the stable dedicated surfaces, plus a
// descriptor-driven assertion that every runtime resolves to its declared
// surface (count-agnostic).
// ---------------------------------------------------------------------------

describe('installSurface correctness', () => {
  test('dedicated surfaces are stable (spot-check)', () => {
    assert.strictEqual(resolveRuntimeConfigIntent('codex').installSurface, 'codex-toml');
    assert.strictEqual(resolveRuntimeConfigIntent('copilot').installSurface, 'copilot-instructions');
    assert.strictEqual(resolveRuntimeConfigIntent('cline').installSurface, 'cline-rules');
    assert.strictEqual(resolveRuntimeConfigIntent('cursor').installSurface, 'cursor-hooks-json');
    assert.strictEqual(resolveRuntimeConfigIntent('windsurf').installSurface, 'profile-marker-only');
    assert.strictEqual(resolveRuntimeConfigIntent('trae').installSurface, 'profile-marker-only');
  });

  test('every registry runtime resolves to its descriptor-declared installSurface', () => {
    for (const row of EXPECTED_TABLE) {
      assert.strictEqual(
        resolveRuntimeConfigIntent(row.runtime).installSurface,
        row.installSurface,
        `${row.runtime} must resolve its descriptor installSurface`,
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
// Test 7: Completeness — ALLOWED_CONFIG_RUNTIMES equals the set of registry
// runtimes that declare an installSurface (count-agnostic; derived from the
// same source as the production Set).
// ---------------------------------------------------------------------------

describe('ALLOWED_CONFIG_RUNTIMES completeness', () => {
  test('ALLOWED_CONFIG_RUNTIMES equals the registry runtimes that declare a real (non-"none") installSurface', () => {
    // #2103: installSurface 'none' means "no CLI install surface at all"
    // (e.g. vscode — Marketplace/VSIX-distributed, never CLI-installed), so
    // it is excluded from the config-adapter runtime set by definition — this
    // mirrors the exclusion already baked into the production
    // ALLOWED_CONFIG_RUNTIMES filter (src/runtime-config-adapter-registry.cts).
    const descriptorAllowed = new Set(
      Object.entries(registry.runtimes)
        .filter(([, cap]) => cap && cap.runtime && typeof cap.runtime.installSurface === 'string' && cap.runtime.installSurface !== 'none')
        .map(([id]) => id),
    );
    assert.deepStrictEqual(new Set(ALLOWED_CONFIG_RUNTIMES), descriptorAllowed);
  });

  test('#2103: vscode declares installSurface "none" and is registered but intentionally excluded from ALLOWED_CONFIG_RUNTIMES', () => {
    assert.strictEqual(registry.runtimes.vscode.runtime.installSurface, 'none');
    assert.ok(!ALLOWED_CONFIG_RUNTIMES.has('vscode'),
      'vscode must not be a config-adapter runtime — it has no CLI install surface');
  });

  test('every member of ALLOWED_CONFIG_RUNTIMES resolves without throwing', () => {
    for (const runtime of ALLOWED_CONFIG_RUNTIMES) {
      assert.doesNotThrow(() => resolveRuntimeConfigIntent(runtime), `${runtime} should resolve without throwing`);
    }
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
    // 'none' added #2103 — vscode has no CLI install surface at all.
    'none',
  ]);

  test('INSTALL_SURFACES contains exactly the 7 surface strings', () => {
    assert.deepStrictEqual(new Set(INSTALL_SURFACES), EXPECTED_SURFACES);
  });
});

describe('resolveInstallPlan — hooksSurface is descriptor-owned', () => {
  test('real descriptor-owned none surface is preserved for opencode and kilo', () => {
    assert.strictEqual(resolveInstallPlan('opencode').hooksSurface, 'none');
    assert.strictEqual(resolveInstallPlan('kilo').hooksSurface, 'none');
  });

  test('synthetic descriptor resolves hooksSurface without runtime-name fallback', () => {
    const runtimes = {
      futurecli: {
        runtime: {
          installSurface: 'settings-json',
          writesSharedSettings: true,
          permissionWriter: null,
          hookEvents: 'claude',
          extendedHookEvents: ['Stop'],
          hooksSurface: 'settings-json',
          sandboxTier: 'none',
        },
      },
    };

    assert.deepStrictEqual(resolveInstallPlanFromRuntimes(runtimes, 'futurecli'), {
      runtime: 'futurecli',
      installSurface: 'settings-json',
      writesSharedSettings: true,
      finishPermissionWriter: null,
      hookEvents: 'claude',
      extendedHookEvents: ['Stop'],
      hooksSurface: 'settings-json',
      sandboxTier: 'none',
    });
  });

  test('missing hooksSurface fails loudly instead of falling back from runtime name', () => {
    const runtimes = {
      opencode: {
        runtime: {
          installSurface: 'settings-json',
          writesSharedSettings: true,
          permissionWriter: 'opencode',
          extendedHookEvents: [],
        },
      },
    };

    assert.throws(
      () => resolveInstallPlanFromRuntimes(runtimes, 'opencode'),
      /runtime\.hooksSurface/,
    );
  });
});

// ---------------------------------------------------------------------------
// resolveInstallPlan — descriptor-projection contract (replaces the frozen
// per-runtime golden master). Asserts that for EVERY registry runtime,
// resolveInstallPlan(id) deep-equals the plan built directly from that runtime's
// descriptor fields. Count-agnostic: adding a runtime descriptor extends
// coverage with zero edits here. Folded from enh-1082 (consolidation epic #1969).
// ---------------------------------------------------------------------------

describe('resolveInstallPlan — descriptor-projection contract (count-agnostic)', () => {
  const RUNTIME_IDS = Object.keys(registry.runtimes);

  test('covers every registry runtime', () => {
    assert.ok(RUNTIME_IDS.length > 0, 'registry must contain at least one runtime');
  });

  // Build the expected plan directly from each descriptor — the same mapping
  // resolveInstallPlan performs, asserted rather than trusted.
  function expectedPlanFromDescriptor(id) {
    const desc = registry.runtimes[id].runtime;
    const pw = desc.permissionWriter;
    return {
      runtime: id,
      installSurface: desc.installSurface,
      writesSharedSettings: desc.writesSharedSettings,
      finishPermissionWriter: pw == null ? null : pw,
      hookEvents: desc.hookEvents,
      extendedHookEvents: Array.isArray(desc.extendedHookEvents) ? [...desc.extendedHookEvents] : [],
      hooksSurface: desc.hooksSurface,
      sandboxTier: desc.sandboxTier,
    };
  }

  for (const id of RUNTIME_IDS) {
    test(`resolveInstallPlan('${id}') matches the descriptor projection`, () => {
      assert.deepStrictEqual(
        resolveInstallPlan(id),
        expectedPlanFromDescriptor(id),
        `InstallPlan for '${id}' diverged from its descriptor projection`,
      );
    });
  }

  test('resolveInstallPlan throws TypeError for unknown runtime', () => {
    assert.throws(
      () => resolveInstallPlan('bogus'),
      (err) => err instanceof TypeError && /bogus/.test(err.message),
    );
  });

  test('extendedHookEvents is always an array for every runtime', () => {
    for (const id of RUNTIME_IDS) {
      assert.ok(Array.isArray(resolveInstallPlan(id).extendedHookEvents),
        `${id}: extendedHookEvents should be an array`);
    }
  });

  test('hooksSurface is always a non-empty string for every runtime', () => {
    for (const id of RUNTIME_IDS) {
      const plan = resolveInstallPlan(id);
      assert.strictEqual(typeof plan.hooksSurface, 'string', `${id}: hooksSurface should be a string`);
      assert.ok(plan.hooksSurface.length > 0, `${id}: hooksSurface should not be empty`);
    }
  });

  test('parity: resolveInstallPlan config-intent fields match resolveRuntimeConfigIntent', () => {
    // Guard that resolveInstallPlan composes resolveRuntimeConfigIntent correctly —
    // any drift between the two would silently break install().
    for (const id of RUNTIME_IDS) {
      const plan = resolveInstallPlan(id);
      const intent = resolveRuntimeConfigIntent(id);
      assert.strictEqual(plan.installSurface, intent.installSurface, `${id}: installSurface mismatch`);
      assert.strictEqual(plan.writesSharedSettings, intent.writesSharedSettings, `${id}: writesSharedSettings mismatch`);
      assert.strictEqual(plan.finishPermissionWriter, intent.finishPermissionWriter, `${id}: finishPermissionWriter mismatch`);
    }
  });
});
