'use strict';

/**
 * Unit tests for host-integration.cjs (ADR-1239 Phase A).
 * Pure, additive, no-I/O module — no temp dirs needed.
 * Uses node:test + node:assert/strict.
 * Requires the COMPILED artifact: ../gsd-core/bin/lib/host-integration.cjs
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const hi = require('../gsd-core/bin/lib/host-integration.cjs');
const {
  PROTOCOL_VERSION,
  HOST_INTEGRATION_AXES,
  INTERFACE_POINTS,
  PROFILE_BASELINES,
  DEFAULT_ENGINE,
  UNDOCUMENTED,
  degradationFor,
  profileOf,
  negotiateHostCapabilities,
} = hi;

// ---------------------------------------------------------------------------
// CONTRACT-PIN: constants and vocabulary
// ---------------------------------------------------------------------------

describe('CONTRACT-PIN', () => {
  test('PROTOCOL_VERSION === 1', () => {
    assert.strictEqual(PROTOCOL_VERSION, 1);
  });

  test('HOST_INTEGRATION_AXES is frozen', () => {
    assert.ok(Object.isFrozen(HOST_INTEGRATION_AXES), 'HOST_INTEGRATION_AXES must be frozen');
  });

  test('each axis sub-array is frozen', () => {
    for (const [axis, arr] of Object.entries(HOST_INTEGRATION_AXES)) {
      assert.ok(Object.isFrozen(arr), `HOST_INTEGRATION_AXES.${axis} must be frozen`);
    }
  });

  test('embeddingMode values (sorted)', () => {
    assert.deepStrictEqual(
      [...HOST_INTEGRATION_AXES.embeddingMode].sort(),
      ['declarative', 'imperative'],
    );
  });

  test('commandSurface values (sorted)', () => {
    assert.deepStrictEqual(
      [...HOST_INTEGRATION_AXES.commandSurface].sort(),
      ['palette', 'prose-only', 'slash-file', 'slash-programmatic', 'slash-toml'],
    );
  });

  test('modelMode values (sorted)', () => {
    assert.deepStrictEqual(
      [...HOST_INTEGRATION_AXES.modelMode].sort(),
      ['active', 'passive'],
    );
  });

  test('hookBus values (sorted)', () => {
    assert.deepStrictEqual(
      [...HOST_INTEGRATION_AXES.hookBus].sort(),
      ['engine', 'host', 'none'],
    );
  });

  test('stateIO values (sorted)', () => {
    assert.deepStrictEqual(
      [...HOST_INTEGRATION_AXES.stateIO].sort(),
      ['filesystem', 'sandboxed-storage', 'session-log-append'],
    );
  });

  test('transport values (sorted)', () => {
    assert.deepStrictEqual(
      [...HOST_INTEGRATION_AXES.transport].sort(),
      ['mcp', 'native-extension'],
    );
  });

  test('runtime values (sorted) — 8 documented values', () => {
    assert.deepStrictEqual(
      [...HOST_INTEGRATION_AXES.runtime].sort(),
      ['bun', 'electron', 'go', 'node', 'other', 'python', 'rust', 'sandboxed-web'],
    );
  });

  test('UNDOCUMENTED === "undocumented"', () => {
    assert.equal(UNDOCUMENTED, 'undocumented');
  });

  test('subagentToolkit values (sorted)', () => {
    assert.deepStrictEqual(
      [...HOST_INTEGRATION_AXES.subagentToolkit].sort(),
      ['full', 'read-only'],
    );
  });

  test('INTERFACE_POINTS frozen and contains expected values', () => {
    assert.ok(Object.isFrozen(INTERFACE_POINTS), 'INTERFACE_POINTS must be frozen');
    const expected = ['command', 'dispatch', 'model', 'hooks', 'state', 'artifact'].sort();
    assert.deepStrictEqual([...INTERFACE_POINTS].sort(), expected);
  });
});

// ---------------------------------------------------------------------------
// degradationFor — happy path per enum value
// ---------------------------------------------------------------------------

describe('degradationFor — happy path', () => {
  test('command: slash-file → full', () => {
    const r = degradationFor('command', { commandSurface: 'slash-file' });
    assert.strictEqual(r.level, 'full');
    assert.strictEqual(typeof r.fallback, 'string');
  });

  test('command: slash-programmatic → full', () => {
    const r = degradationFor('command', { commandSurface: 'slash-programmatic' });
    assert.strictEqual(r.level, 'full');
  });

  test('command: slash-toml → degraded', () => {
    const r = degradationFor('command', { commandSurface: 'slash-toml' });
    assert.strictEqual(r.level, 'degraded');
  });

  test('command: palette → degraded', () => {
    const r = degradationFor('command', { commandSurface: 'palette' });
    assert.strictEqual(r.level, 'degraded');
  });

  test('command: prose-only → absent', () => {
    const r = degradationFor('command', { commandSurface: 'prose-only' });
    assert.strictEqual(r.level, 'absent');
    assert.ok(r.fallback.length > 0, 'fallback must be non-empty for prose-only');
  });

  test('model: active → full', () => {
    const r = degradationFor('model', { modelMode: 'active' });
    assert.strictEqual(r.level, 'full');
  });

  test('model: passive → degraded', () => {
    const r = degradationFor('model', { modelMode: 'passive' });
    assert.strictEqual(r.level, 'degraded');
  });

  test('hooks: host → full', () => {
    const r = degradationFor('hooks', { hookBus: 'host' });
    assert.strictEqual(r.level, 'full');
  });

  test('hooks: engine → degraded', () => {
    const r = degradationFor('hooks', { hookBus: 'engine' });
    assert.strictEqual(r.level, 'degraded');
  });

  test('hooks: none → absent', () => {
    const r = degradationFor('hooks', { hookBus: 'none' });
    assert.strictEqual(r.level, 'absent');
  });

  test('state: filesystem → full', () => {
    const r = degradationFor('state', { stateIO: 'filesystem' });
    assert.strictEqual(r.level, 'full');
  });

  test('state: sandboxed-storage → degraded', () => {
    const r = degradationFor('state', { stateIO: 'sandboxed-storage' });
    assert.strictEqual(r.level, 'degraded');
  });

  test('state: session-log-append → degraded', () => {
    const r = degradationFor('state', { stateIO: 'session-log-append' });
    assert.strictEqual(r.level, 'degraded');
  });

  test('artifact: slash-file → full', () => {
    const r = degradationFor('artifact', { commandSurface: 'slash-file' });
    assert.strictEqual(r.level, 'full');
  });

  test('artifact: slash-programmatic → full', () => {
    const r = degradationFor('artifact', { commandSurface: 'slash-programmatic' });
    assert.strictEqual(r.level, 'full');
  });

  test('artifact: slash-toml → degraded', () => {
    const r = degradationFor('artifact', { commandSurface: 'slash-toml' });
    assert.strictEqual(r.level, 'degraded');
  });

  test('artifact: prose-only → degraded', () => {
    const r = degradationFor('artifact', { commandSurface: 'prose-only' });
    assert.strictEqual(r.level, 'degraded');
  });

  test('artifact: palette → absent', () => {
    const r = degradationFor('artifact', { commandSurface: 'palette' });
    assert.strictEqual(r.level, 'absent');
  });

  // dispatch variants
  test('dispatch: no namedDispatch → absent', () => {
    const r = degradationFor('dispatch', { dispatch: { namedDispatch: false, nested: false, maxDepth: 0, background: false, subagentToolkit: 'full' } });
    assert.strictEqual(r.level, 'absent');
  });

  test('dispatch: maxDepth===0 → absent', () => {
    const r = degradationFor('dispatch', { dispatch: { namedDispatch: true, nested: true, maxDepth: 0, background: true, subagentToolkit: 'full' } });
    assert.strictEqual(r.level, 'absent');
  });

  test('dispatch: unbounded (-1) nested → full', () => {
    const r = degradationFor('dispatch', { dispatch: { namedDispatch: true, nested: true, maxDepth: -1, background: true, subagentToolkit: 'full' } });
    assert.strictEqual(r.level, 'full');
  });

  test('dispatch: nested maxDepth>=2 → full', () => {
    const r = degradationFor('dispatch', { dispatch: { namedDispatch: true, nested: true, maxDepth: 2, background: true, subagentToolkit: 'full' } });
    assert.strictEqual(r.level, 'full');
  });

  test('dispatch: full but subagentToolkit read-only → degraded', () => {
    const r = degradationFor('dispatch', { dispatch: { namedDispatch: true, nested: true, maxDepth: -1, background: true, subagentToolkit: 'read-only' } });
    assert.strictEqual(r.level, 'degraded');
  });

  test('dispatch: flat (maxDepth===1) → degraded', () => {
    const r = degradationFor('dispatch', { dispatch: { namedDispatch: true, nested: false, maxDepth: 1, background: false, subagentToolkit: 'full' } });
    assert.strictEqual(r.level, 'degraded');
  });
});

// ---------------------------------------------------------------------------
// degradationFor — EVERY enum value returns a defined result with valid level
// ---------------------------------------------------------------------------

describe('degradationFor — all enum values return valid level', () => {
  const VALID_LEVELS = new Set(['full', 'degraded', 'absent']);

  test('command — all commandSurface values', () => {
    for (const v of HOST_INTEGRATION_AXES.commandSurface) {
      const r = degradationFor('command', { commandSurface: v });
      assert.ok(VALID_LEVELS.has(r.level), `command/${v}: level '${r.level}' invalid`);
      assert.strictEqual(typeof r.fallback, 'string');
    }
  });

  test('model — all modelMode values', () => {
    for (const v of HOST_INTEGRATION_AXES.modelMode) {
      const r = degradationFor('model', { modelMode: v });
      assert.ok(VALID_LEVELS.has(r.level), `model/${v}: level '${r.level}' invalid`);
    }
  });

  test('hooks — all hookBus values', () => {
    for (const v of HOST_INTEGRATION_AXES.hookBus) {
      const r = degradationFor('hooks', { hookBus: v });
      assert.ok(VALID_LEVELS.has(r.level), `hooks/${v}: level '${r.level}' invalid`);
    }
  });

  test('state — all stateIO values', () => {
    for (const v of HOST_INTEGRATION_AXES.stateIO) {
      const r = degradationFor('state', { stateIO: v });
      assert.ok(VALID_LEVELS.has(r.level), `state/${v}: level '${r.level}' invalid`);
    }
  });

  test('artifact — all commandSurface values', () => {
    for (const v of HOST_INTEGRATION_AXES.commandSurface) {
      const r = degradationFor('artifact', { commandSurface: v });
      assert.ok(VALID_LEVELS.has(r.level), `artifact/${v}: level '${r.level}' invalid`);
    }
  });
});

// ---------------------------------------------------------------------------
// degradationFor — unknown / missing axis → absent + unknown:true, never throws
// ---------------------------------------------------------------------------

describe('degradationFor — unknown / missing axis', () => {
  test('unknown commandSurface value for command → absent + unknown:true', () => {
    const r = degradationFor('command', { commandSurface: 'zzz' });
    assert.strictEqual(r.level, 'absent');
    assert.strictEqual(r.unknown, true);
  });

  test('missing commandSurface for command → absent + unknown:true', () => {
    const r = degradationFor('command', {});
    assert.strictEqual(r.level, 'absent');
    assert.strictEqual(r.unknown, true);
  });

  test('unknown modelMode → absent + unknown:true', () => {
    const r = degradationFor('model', { modelMode: 'zzz' });
    assert.strictEqual(r.level, 'absent');
    assert.strictEqual(r.unknown, true);
  });

  test('missing hookBus for hooks → absent + unknown:true', () => {
    const r = degradationFor('hooks', {});
    assert.strictEqual(r.level, 'absent');
    assert.strictEqual(r.unknown, true);
  });

  test('no throw on unknown axis value', () => {
    assert.doesNotThrow(() => degradationFor('dispatch', { dispatch: 'not-an-object' }));
  });

  test('no throw on completely empty axes', () => {
    for (const point of INTERFACE_POINTS) {
      assert.doesNotThrow(() => degradationFor(point, {}));
    }
  });
});

// ---------------------------------------------------------------------------
// profileOf
// ---------------------------------------------------------------------------

describe('profileOf', () => {
  test('profileOf(PROFILE_BASELINES["programmatic-cli"]) === "programmatic-cli"', () => {
    assert.strictEqual(profileOf(PROFILE_BASELINES['programmatic-cli']), 'programmatic-cli');
  });

  test('profileOf(PROFILE_BASELINES["declarative-cli"]) === "declarative-cli"', () => {
    assert.strictEqual(profileOf(PROFILE_BASELINES['declarative-cli']), 'declarative-cli');
  });

  test('profileOf(PROFILE_BASELINES["ide"]) === "ide"', () => {
    assert.strictEqual(profileOf(PROFILE_BASELINES['ide']), 'ide');
  });

  test('imperative + sandboxed-web → ide', () => {
    assert.strictEqual(
      profileOf({ embeddingMode: 'imperative', runtime: 'sandboxed-web' }),
      'ide',
    );
  });

  test('imperative + node → programmatic-cli', () => {
    assert.strictEqual(
      profileOf({ embeddingMode: 'imperative', runtime: 'node' }),
      'programmatic-cli',
    );
  });

  test('declarative → declarative-cli', () => {
    assert.strictEqual(
      profileOf({ embeddingMode: 'declarative' }),
      'declarative-cli',
    );
  });

  test('empty axes → null', () => {
    assert.strictEqual(profileOf({}), null);
  });

  test('PROFILE_BASELINES are frozen', () => {
    assert.ok(Object.isFrozen(PROFILE_BASELINES), 'PROFILE_BASELINES must be frozen');
  });
});

// ---------------------------------------------------------------------------
// negotiateHostCapabilities — HAPPY PATH
// ---------------------------------------------------------------------------

describe('negotiateHostCapabilities — happy path', () => {
  test('declarative-cli baseline → effective matches, no warnings, points.command.effectiveLevel===full', () => {
    const baseline = PROFILE_BASELINES['declarative-cli'];
    const result = negotiateHostCapabilities(baseline);

    // No warnings
    assert.deepStrictEqual(result.warnings, [], 'Expected no warnings for full declarative-cli baseline');

    // Key points
    assert.strictEqual(result.points.command.effectiveLevel, 'full');
    assert.strictEqual(result.points.hooks.effectiveLevel, 'full');
    assert.strictEqual(result.points.state.effectiveLevel, 'full');

    // protocolVersion
    assert.strictEqual(result.protocolVersion, PROTOCOL_VERSION);

    // effective axes match baseline (scalar)
    assert.strictEqual(result.effective.embeddingMode, baseline.embeddingMode);
    assert.strictEqual(result.effective.commandSurface, baseline.commandSurface);
    assert.strictEqual(result.effective.modelMode, baseline.modelMode);
    assert.strictEqual(result.effective.hookBus, baseline.hookBus);
    assert.strictEqual(result.effective.stateIO, baseline.stateIO);

    // effective dispatch has maxDepth resolved (declarative has maxDepth:1)
    assert.strictEqual(result.effective.dispatch.maxDepth, 1);
    assert.strictEqual(result.effective.dispatch.namedDispatch, true);
  });

  test('all INTERFACE_POINTS are present in result.points', () => {
    const result = negotiateHostCapabilities(PROFILE_BASELINES['programmatic-cli']);
    for (const point of INTERFACE_POINTS) {
      assert.ok(point in result.points, `Missing point: ${point}`);
      assert.ok(['full', 'degraded', 'absent'].includes(result.points[point].effectiveLevel),
        `Invalid effectiveLevel for ${point}`);
    }
  });
});

// ---------------------------------------------------------------------------
// negotiateHostCapabilities — SECURITY / HOSTILE
// ---------------------------------------------------------------------------

describe('negotiateHostCapabilities — security / hostile', () => {
  test('(1) host declares future commandSurface at protocolVersion 99 → effective is KNOWN value, NOT the unknown one', () => {
    const result = negotiateHostCapabilities({
      ...PROFILE_BASELINES['programmatic-cli'],
      commandSurface: 'future-surface',
      protocolVersion: 99,
    });
    // effective.commandSurface must be a KNOWN value
    assert.ok(
      HOST_INTEGRATION_AXES.commandSurface.includes(result.effective.commandSurface),
      `effective.commandSurface '${result.effective.commandSurface}' is not in known vocabulary`,
    );
    assert.notStrictEqual(result.effective.commandSurface, 'future-surface',
      'future-surface must NOT appear in effective');
    // A warning mentioning protocolVersion
    const warnText = result.warnings.join(' ');
    assert.ok(warnText.includes('protocolVersion') || warnText.includes('unknown'),
      `Expected a warning about protocolVersion or unknown value; got: ${warnText}`);
  });

  test('(2) host modelMode active but engine passive → effective.modelMode === passive', () => {
    const restrictedEngine = {
      ...DEFAULT_ENGINE,
      axes: { ...DEFAULT_ENGINE.axes, modelMode: 'passive' },
    };
    const result = negotiateHostCapabilities(
      { ...PROFILE_BASELINES['programmatic-cli'], modelMode: 'active' },
      restrictedEngine,
    );
    assert.strictEqual(result.effective.modelMode, 'passive');
  });

  test('(3) host dispatch maxDepth:5 nested:true but engine dispatch maxDepth:1 → effective.dispatch.maxDepth===1', () => {
    const restrictedEngine = {
      ...DEFAULT_ENGINE,
      axes: {
        ...DEFAULT_ENGINE.axes,
        dispatch: { ...DEFAULT_ENGINE.axes.dispatch, maxDepth: 1, nested: false },
      },
    };
    const result = negotiateHostCapabilities(
      {
        ...PROFILE_BASELINES['programmatic-cli'],
        dispatch: { namedDispatch: true, nested: true, maxDepth: 5, background: true, subagentToolkit: 'full' },
      },
      restrictedEngine,
    );
    assert.strictEqual(result.effective.dispatch.maxDepth, 1);
  });

  test('(4) host omits hookBus → effective.hookBus is safe default + warning present', () => {
    const hostWithoutHookBus = { ...PROFILE_BASELINES['declarative-cli'] };
    delete hostWithoutHookBus.hookBus;

    const result = negotiateHostCapabilities(hostWithoutHookBus);
    // effective hookBus must be a known value
    assert.ok(
      HOST_INTEGRATION_AXES.hookBus.includes(result.effective.hookBus),
      `effective.hookBus '${result.effective.hookBus}' is not known`,
    );
    // points.hooks must be present
    assert.ok('hooks' in result.points, 'points.hooks must be present');
    // a warning mentioning hookBus
    const warnText = result.warnings.join(' ');
    assert.ok(warnText.includes('hookBus'), `Expected warning about hookBus; got: ${warnText}`);
  });

  test('(5) INVARIANT: every effective scalar ∈ engine.known[axis] for hostile hosts', () => {
    const hostileHosts = [
      // All unknown values
      {
        embeddingMode: 'future-mode',
        commandSurface: 'future-surface',
        modelMode: 'quantum',
        hookBus: 'blockchain',
        stateIO: 'cloud-magic',
        transport: 'telepathy',
        runtime: 'wasm',
        protocolVersion: 999,
      },
      // Mix of known and unknown
      {
        embeddingMode: 'imperative',
        commandSurface: 'palette',
        modelMode: 'active',
        hookBus: 'none',
        stateIO: 'unknown-future',
        transport: 'mcp',
        runtime: 'sandboxed-web',
      },
      // Empty host
      {},
      // Only dispatch with extreme values
      {
        dispatch: { namedDispatch: true, nested: true, maxDepth: 9999, background: true, subagentToolkit: 'full' },
      },
    ];

    const scalarAxes = ['embeddingMode', 'commandSurface', 'modelMode', 'hookBus', 'stateIO', 'transport', 'runtime'];

    for (const host of hostileHosts) {
      const result = negotiateHostCapabilities(host);
      for (const axis of scalarAxes) {
        const effectiveVal = result.effective[axis];
        assert.ok(
          HOST_INTEGRATION_AXES[axis].includes(effectiveVal),
          `INVARIANT VIOLATION: effective.${axis}='${effectiveVal}' is NOT in known vocabulary for host=${JSON.stringify(host)}`,
        );
      }
    }
  });

  test('host protocolVersion > engine → warning mentioning protocolVersion', () => {
    const result = negotiateHostCapabilities({
      ...PROFILE_BASELINES['declarative-cli'],
      protocolVersion: 99,
    });
    const warnText = result.warnings.join(' ');
    assert.ok(warnText.includes('protocolVersion'), `Expected protocolVersion warning; got: ${warnText}`);
    assert.strictEqual(result.protocolVersion, PROTOCOL_VERSION);
  });
});

// ---------------------------------------------------------------------------
// INDEPENDENCE: mutation safety
// ---------------------------------------------------------------------------

describe('independence / mutation safety', () => {
  test('mutating returned result does not affect second call', () => {
    const host = PROFILE_BASELINES['declarative-cli'];
    const r1 = negotiateHostCapabilities(host);
    // Mutate r1
    r1.warnings.push('injected');
    r1.effective.modelMode = 'active';
    r1.points.command.effectiveLevel = 'absent';

    const r2 = negotiateHostCapabilities(host);
    // r2 must not be affected
    assert.deepStrictEqual(r2.warnings, [], 'r2.warnings must not include injected warning');
    assert.strictEqual(r2.effective.modelMode, host.modelMode, 'r2.effective.modelMode must be original value');
    assert.strictEqual(r2.points.command.effectiveLevel, 'full', 'r2.points.command.effectiveLevel must be full');
  });

  test('all exports are present on the module', () => {
    const expectedExports = [
      'PROTOCOL_VERSION', 'HOST_INTEGRATION_AXES', 'INTERFACE_POINTS',
      'PROFILE_BASELINES', 'DEFAULT_ENGINE', 'UNDOCUMENTED',
      'degradationFor', 'profileOf', 'negotiateHostCapabilities',
    ];
    for (const exp of expectedExports) {
      assert.ok(exp in hi, `Missing export: ${exp}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Decision 1: undocumented sentinel — fail-closed in negotiation
// ---------------------------------------------------------------------------

describe('Decision 1: UNDOCUMENTED sentinel — fail-closed negotiation', () => {
  test('negotiate with embeddingMode:"undocumented" → effective is safe default (documented value), NOT "undocumented"', () => {
    const host = {
      ...PROFILE_BASELINES['declarative-cli'],
      embeddingMode: 'undocumented',
    };
    const result = negotiateHostCapabilities(host);
    // effective.embeddingMode must be a documented value, NOT 'undocumented'
    assert.ok(
      HOST_INTEGRATION_AXES.embeddingMode.includes(result.effective.embeddingMode),
      `effective.embeddingMode must be a documented value; got '${result.effective.embeddingMode}'`,
    );
    assert.notStrictEqual(result.effective.embeddingMode, 'undocumented',
      'effective.embeddingMode must not be "undocumented"');
    // A warning mentioning "undocumented"
    const warnText = result.warnings.join(' ');
    assert.ok(warnText.includes('undocumented'),
      `Expected a warning mentioning "undocumented"; got: ${warnText}`);
  });

  test('negotiate with dispatch fields all "undocumented" → fail-closed dispatch', () => {
    const host = {
      ...PROFILE_BASELINES['programmatic-cli'],
      dispatch: {
        namedDispatch: 'undocumented',
        nested: 'undocumented',
        maxDepth: 'undocumented',
        background: 'undocumented',
        subagentToolkit: 'undocumented',
      },
    };
    const result = negotiateHostCapabilities(host);
    const d = result.effective.dispatch;
    assert.strictEqual(d.namedDispatch, false, 'namedDispatch must be false when "undocumented"');
    assert.strictEqual(d.nested, false, 'nested must be false when "undocumented"');
    assert.strictEqual(d.background, false, 'background must be false when "undocumented"');
    assert.strictEqual(d.subagentToolkit, 'read-only', 'subagentToolkit must be "read-only" when "undocumented"');
    assert.strictEqual(d.maxDepth, 0, 'maxDepth must be 0 when "undocumented"');
    // points.dispatch must be absent
    assert.strictEqual(result.points.dispatch.effectiveLevel, 'absent',
      'points.dispatch.effectiveLevel must be "absent" when dispatch is all undocumented');
  });

  test('degradationFor dispatch with namedDispatch:"undocumented" → level "absent"', () => {
    const r = degradationFor('dispatch', {
      dispatch: {
        namedDispatch: 'undocumented',
        nested: false,
        maxDepth: 0,
        background: false,
        subagentToolkit: 'full',
      },
    });
    assert.strictEqual(r.level, 'absent',
      `degradationFor with namedDispatch:"undocumented" must return absent; got "${r.level}"`);
  });

  test('subagentToolkit "undocumented" (truthy string) fails closed to read-only', () => {
    const host = {
      ...PROFILE_BASELINES['programmatic-cli'],
      dispatch: {
        namedDispatch: true,
        nested: true,
        maxDepth: -1,
        background: true,
        subagentToolkit: 'undocumented',
      },
    };
    const result = negotiateHostCapabilities(host);
    assert.strictEqual(result.effective.dispatch.subagentToolkit, 'read-only',
      'subagentToolkit "undocumented" must degrade to "read-only"');
  });
});

// ---------------------------------------------------------------------------
// Decision 2: expanded runtime vocabulary (8 documented values)
// ---------------------------------------------------------------------------

describe('Decision 2: expanded runtime vocabulary', () => {
  const newRuntimes = ['python', 'go', 'rust', 'electron', 'other'];

  for (const rt of newRuntimes) {
    test(`negotiate with runtime:"${rt}" → effective.runtime === "${rt}" (no warn about unknown)`, () => {
      const host = {
        ...PROFILE_BASELINES['programmatic-cli'],
        runtime: rt,
      };
      const result = negotiateHostCapabilities(host);
      assert.strictEqual(result.effective.runtime, rt,
        `effective.runtime must be "${rt}"; got "${result.effective.runtime}"`);
      // Must NOT have an unknown-value warning for this runtime
      const runtimeWarnings = result.warnings.filter((w) => w.includes('runtime') && w.includes('not trusted'));
      assert.strictEqual(runtimeWarnings.length, 0,
        `Must not warn about unknown runtime "${rt}"; warnings: ${result.warnings.join(', ')}`);
    });
  }

  test('runtime "undocumented" (sentinel) → fail-closed to safe default', () => {
    const host = {
      ...PROFILE_BASELINES['programmatic-cli'],
      runtime: 'undocumented',
    };
    const result = negotiateHostCapabilities(host);
    // Must be a documented value, not "undocumented"
    assert.ok(
      HOST_INTEGRATION_AXES.runtime.includes(result.effective.runtime),
      `effective.runtime must be documented; got "${result.effective.runtime}"`,
    );
    assert.notStrictEqual(result.effective.runtime, 'undocumented');
    const warnText = result.warnings.join(' ');
    assert.ok(warnText.includes('undocumented'), `Expected undocumented warning; got: ${warnText}`);
  });

  test('"wasm" (genuinely unknown, not sentinel) → still fails closed with "not trusted" warning', () => {
    const host = {
      ...PROFILE_BASELINES['programmatic-cli'],
      runtime: 'wasm',
    };
    const result = negotiateHostCapabilities(host);
    assert.ok(HOST_INTEGRATION_AXES.runtime.includes(result.effective.runtime),
      `effective.runtime must be documented; got "${result.effective.runtime}"`);
    const warnText = result.warnings.join(' ');
    assert.ok(warnText.includes('not trusted') || warnText.includes('unknown'),
      `Expected not-trusted/unknown warning; got: ${warnText}`);
  });
});

// ---------------------------------------------------------------------------
// Fix 1: degradationFor('dispatch') fail-closed on non-'full' subagentToolkit
// ---------------------------------------------------------------------------

describe('Fix 1: degradationFor dispatch fails closed on non-full subagentToolkit', () => {
  const FULL_DEPTH_DISPATCH = { namedDispatch: true, nested: true, maxDepth: -1, background: true };

  test('subagentToolkit:"full" + full depth → level "full"', () => {
    const r = degradationFor('dispatch', { dispatch: { ...FULL_DEPTH_DISPATCH, subagentToolkit: 'full' } });
    assert.strictEqual(r.level, 'full',
      'subagentToolkit:"full" with full depth must return level "full"');
  });

  test('subagentToolkit:"read-only" + full depth → level "degraded"', () => {
    const r = degradationFor('dispatch', { dispatch: { ...FULL_DEPTH_DISPATCH, subagentToolkit: 'read-only' } });
    assert.strictEqual(r.level, 'degraded',
      'subagentToolkit:"read-only" must return level "degraded"');
    assert.ok(r.fallback.length > 0, 'fallback must be non-empty');
  });

  test('subagentToolkit:"undocumented" + full depth → level "degraded" (fail-closed)', () => {
    const r = degradationFor('dispatch', { dispatch: { ...FULL_DEPTH_DISPATCH, subagentToolkit: 'undocumented' } });
    assert.strictEqual(r.level, 'degraded',
      'subagentToolkit:"undocumented" must fail closed to level "degraded"; got "' + r.level + '"');
    assert.ok(r.fallback.length > 0, 'fallback must be non-empty');
  });

  test('subagentToolkit:"future-xyz" + full depth → level "degraded" (fail-closed)', () => {
    const r = degradationFor('dispatch', { dispatch: { ...FULL_DEPTH_DISPATCH, subagentToolkit: 'future-xyz' } });
    assert.strictEqual(r.level, 'degraded',
      'subagentToolkit:"future-xyz" (unknown) must fail closed to level "degraded"; got "' + r.level + '"');
    assert.ok(r.fallback.length > 0, 'fallback must be non-empty');
  });

  test('subagentToolkit:"" (empty string) + full depth → level "degraded" (fail-closed)', () => {
    const r = degradationFor('dispatch', { dispatch: { ...FULL_DEPTH_DISPATCH, subagentToolkit: '' } });
    assert.strictEqual(r.level, 'degraded',
      'subagentToolkit:"" must fail closed to level "degraded"; got "' + r.level + '"');
  });
});

// ---------------------------------------------------------------------------
// Fix 2: negotiateHostCapabilities — host omitting 'dispatch' → subagentToolkit 'read-only'
// ---------------------------------------------------------------------------

describe('Fix 2: negotiate — host omits dispatch → subagentToolkit read-only (fail-closed)', () => {
  test('negotiateHostCapabilities({}) → effective.dispatch.subagentToolkit === "read-only"', () => {
    const result = negotiateHostCapabilities({});
    assert.strictEqual(result.effective.dispatch.subagentToolkit, 'read-only',
      'When host omits dispatch, subagentToolkit must fail-closed to "read-only"; got "' + result.effective.dispatch.subagentToolkit + '"');
  });

  test('negotiateHostCapabilities({}) → effective.dispatch.namedDispatch===false, maxDepth===0, nested===false, background===false', () => {
    const result = negotiateHostCapabilities({});
    const d = result.effective.dispatch;
    assert.strictEqual(d.namedDispatch, false);
    assert.strictEqual(d.maxDepth, 0);
    assert.strictEqual(d.nested, false);
    assert.strictEqual(d.background, false);
  });

  test('negotiateHostCapabilities({}) → points.dispatch.effectiveLevel === "absent"', () => {
    const result = negotiateHostCapabilities({});
    assert.strictEqual(result.points.dispatch.effectiveLevel, 'absent',
      'dispatch absent when host omits it');
  });

  test('host with all axes but no dispatch → subagentToolkit "read-only"', () => {
    const hostWithoutDispatch = {
      embeddingMode: 'imperative',
      commandSurface: 'slash-file',
      modelMode: 'passive',
      hookBus: 'host',
      stateIO: 'filesystem',
      transport: 'mcp',
      runtime: 'node',
      // no dispatch key
    };
    const result = negotiateHostCapabilities(hostWithoutDispatch);
    assert.strictEqual(result.effective.dispatch.subagentToolkit, 'read-only',
      'Host missing dispatch must produce subagentToolkit "read-only"; got "' + result.effective.dispatch.subagentToolkit + '"');
  });
});
