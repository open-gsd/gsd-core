'use strict';

/**
 * ADR-1239 Phase A: Parity guard — validator VALID_* sets MUST exactly match
 * HOST_INTEGRATION_AXES arrays from host-integration.cjs.
 *
 * If either side drifts, this test fails immediately (not silently).
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runGsdTools, createTempDir, cleanup } = require('./helpers.cjs');
// Seeded fast-check convention: the shared setup helper (seed 42, numRuns 200,
// GSD_FC_SEED to explore), never 'fast-check' directly.
const fc = require('./helpers/fast-check-setup.cjs');

const {
  HOST_INTEGRATION_AXES,
} = require(path.join(__dirname, '../gsd-core/bin/lib/host-integration.cjs'));

const {
  _HOST_INTEGRATION_VOCAB,
  validateCapability,
} = require(path.join(__dirname, '../gsd-core/bin/lib/capability-validator.cjs'));

// Sort for deterministic comparison
function sorted(arr) {
  return [...arr].sort();
}

// A shell `case` pattern line naming two or more bare-word alternatives —
// `  harness-worktree|orchestrator-worktree|none) ;;` — with an optional
// leading `(` and whitespace around `|`, both legal shell. Returns the
// alternatives in order, or null when the line is not such a pattern. The
// scan below and its round-trip property share this one parser.
const CASE_ALTERNATION = /^\s*\(?\s*([a-z][a-z-]*(?:\s*\|\s*[a-z][a-z-]*)+)\s*\)/;
function parseCaseAlternation(line) {
  const m = CASE_ALTERNATION.exec(line);
  return m ? m[1].split(/\s*\|\s*/) : null;
}

// Minimal valid runtime capability descriptor (all documented values)
function makeMinimalRuntimeCap(overrides = {}) {
  return {
    id: 'test-runtime',
    role: 'runtime',
    title: 'Test Runtime',
    description: 'Test runtime capability for parity tests',
    tier: 'core',
    requires: [],
    version: '1.0.0',
    runtime: {
      configHome: {
        kind: 'dot-home',
        name: '.test-runtime',
        env: [],
      },
      configFormat: 'markdown',
      artifactLayout: {
        global: [],
        local: [],
      },
      commandStyle: 'slash-hyphen',
      hooksSurface: 'none',
      sandboxTier: 'none',
      supportTier: 1,
      installSurface: 'profile-marker-only',
      localConfigDir: '.test-runtime',
      writesSharedSettings: false,
      permissionWriter: null,
      extendedHookEvents: [],
      hostIntegration: {
        embeddingMode: 'imperative',
        commandSurface: 'slash-file',
        modelMode: 'passive',
        hookBus: 'host',
        stateIO: 'filesystem',
        transport: 'mcp',
        runtime: 'node',
        dispatch: {
          namedDispatch: true,
          nested: false,
          maxDepth: 1,
          background: false,
          subagentToolkit: 'full',
          backgroundDispatch: false,
        },
      },
      ...overrides,
    },
  };
}

describe('ADR-1239 Phase A: host-integration validator parity', () => {
  test('_HOST_INTEGRATION_VOCAB is exported from capability-validator.cjs', () => {
    assert.ok(
      _HOST_INTEGRATION_VOCAB !== undefined && _HOST_INTEGRATION_VOCAB !== null,
      '_HOST_INTEGRATION_VOCAB must be exported from capability-validator.cjs',
    );
    assert.strictEqual(typeof _HOST_INTEGRATION_VOCAB, 'object');
  });

  test('embeddingMode: validator set === HOST_INTEGRATION_AXES.embeddingMode', () => {
    assert.deepEqual(
      sorted(_HOST_INTEGRATION_VOCAB.embeddingMode),
      sorted(HOST_INTEGRATION_AXES.embeddingMode),
      'validator VALID_EMBEDDING_MODES must exactly match HOST_INTEGRATION_AXES.embeddingMode',
    );
  });

  test('commandSurface: validator set === HOST_INTEGRATION_AXES.commandSurface', () => {
    assert.deepEqual(
      sorted(_HOST_INTEGRATION_VOCAB.commandSurface),
      sorted(HOST_INTEGRATION_AXES.commandSurface),
      'validator VALID_COMMAND_SURFACES must exactly match HOST_INTEGRATION_AXES.commandSurface',
    );
  });

  test('modelMode: validator set === HOST_INTEGRATION_AXES.modelMode', () => {
    assert.deepEqual(
      sorted(_HOST_INTEGRATION_VOCAB.modelMode),
      sorted(HOST_INTEGRATION_AXES.modelMode),
      'validator VALID_MODEL_MODES must exactly match HOST_INTEGRATION_AXES.modelMode',
    );
  });

  test('hookBus: validator set === HOST_INTEGRATION_AXES.hookBus', () => {
    assert.deepEqual(
      sorted(_HOST_INTEGRATION_VOCAB.hookBus),
      sorted(HOST_INTEGRATION_AXES.hookBus),
      'validator VALID_HOOK_BUSES must exactly match HOST_INTEGRATION_AXES.hookBus',
    );
  });

  test('stateIO: validator set === HOST_INTEGRATION_AXES.stateIO', () => {
    assert.deepEqual(
      sorted(_HOST_INTEGRATION_VOCAB.stateIO),
      sorted(HOST_INTEGRATION_AXES.stateIO),
      'validator VALID_STATE_IO must exactly match HOST_INTEGRATION_AXES.stateIO',
    );
  });

  test('transport: validator set === HOST_INTEGRATION_AXES.transport', () => {
    assert.deepEqual(
      sorted(_HOST_INTEGRATION_VOCAB.transport),
      sorted(HOST_INTEGRATION_AXES.transport),
      'validator VALID_TRANSPORTS must exactly match HOST_INTEGRATION_AXES.transport',
    );
  });

  test('runtime (axis): validator set === HOST_INTEGRATION_AXES.runtime (8 documented values)', () => {
    assert.deepEqual(
      sorted(_HOST_INTEGRATION_VOCAB.runtime),
      sorted(HOST_INTEGRATION_AXES.runtime),
      'validator VALID_HOST_RUNTIMES must exactly match HOST_INTEGRATION_AXES.runtime',
    );
  });

  test('subagentToolkit: validator set === HOST_INTEGRATION_AXES.subagentToolkit', () => {
    assert.deepEqual(
      sorted(_HOST_INTEGRATION_VOCAB.subagentToolkit),
      sorted(HOST_INTEGRATION_AXES.subagentToolkit),
      'validator VALID_SUBAGENT_TOOLKITS must exactly match HOST_INTEGRATION_AXES.subagentToolkit',
    );
  });

  test('all axis keys in HOST_INTEGRATION_AXES are covered by _HOST_INTEGRATION_VOCAB', () => {
    const axisKeys = Object.keys(HOST_INTEGRATION_AXES).sort();
    const vocabKeys = Object.keys(_HOST_INTEGRATION_VOCAB).sort();
    assert.deepEqual(
      vocabKeys,
      axisKeys,
      '_HOST_INTEGRATION_VOCAB must cover exactly the same axis keys as HOST_INTEGRATION_AXES',
    );
  });

  test('_HOST_INTEGRATION_VOCAB does NOT include "undocumented" (documented vocab only)', () => {
    for (const [axis, values] of Object.entries(_HOST_INTEGRATION_VOCAB)) {
      assert.ok(
        !values.includes('undocumented'),
        `_HOST_INTEGRATION_VOCAB.${axis} must not include "undocumented" (sentinel is NOT documented vocab)`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Behavioral: "undocumented" passes validator; bogus values still fail
// ---------------------------------------------------------------------------

describe('ADR-1239 validator behavioral: undocumented sentinel passes, bogus fails', () => {
  const SCALAR_AXES = ['embeddingMode', 'commandSurface', 'modelMode', 'hookBus', 'stateIO', 'transport', 'runtime'];

  for (const axis of SCALAR_AXES) {
    test(`hostIntegration.${axis}:"undocumented" → ZERO validator errors`, () => {
      const cap = makeMinimalRuntimeCap({
        hostIntegration: {
          ...makeMinimalRuntimeCap().runtime.hostIntegration,
          [axis]: 'undocumented',
        },
      });
      const errors = validateCapability(cap, 'test-runtime');
      const hiErrors = errors.filter((e) => e.includes('hostIntegration.' + axis));
      assert.strictEqual(hiErrors.length, 0,
        `"undocumented" for axis "${axis}" must produce no validator errors; got: ${hiErrors.join(', ')}`);
    });

    test(`hostIntegration.${axis}:"zzz" → produces a validator error`, () => {
      const cap = makeMinimalRuntimeCap({
        hostIntegration: {
          ...makeMinimalRuntimeCap().runtime.hostIntegration,
          [axis]: 'zzz',
        },
      });
      const errors = validateCapability(cap, 'test-runtime');
      const hiErrors = errors.filter((e) => e.includes('hostIntegration.' + axis));
      assert.ok(hiErrors.length > 0,
        `bogus value "zzz" for axis "${axis}" must produce a validator error`);
    });
  }

  test('dispatch.namedDispatch:"undocumented" → ZERO validator errors for that field', () => {
    const cap = makeMinimalRuntimeCap({
      hostIntegration: {
        ...makeMinimalRuntimeCap().runtime.hostIntegration,
        dispatch: {
          namedDispatch: 'undocumented',
          nested: 'undocumented',
          maxDepth: 'undocumented',
          background: 'undocumented',
          subagentToolkit: 'undocumented',
          backgroundDispatch: 'undocumented',
        },
      },
    });
    const errors = validateCapability(cap, 'test-runtime');
    const dispatchErrors = errors.filter((e) => e.includes('hostIntegration.dispatch'));
    assert.strictEqual(dispatchErrors.length, 0,
      `"undocumented" for all dispatch fields must produce no validator errors; got: ${dispatchErrors.join(', ')}`);
  });

  test('dispatch boolean fields: true/false still accepted', () => {
    const cap = makeMinimalRuntimeCap();
    const errors = validateCapability(cap, 'test-runtime');
    const dispatchErrors = errors.filter((e) => e.includes('hostIntegration.dispatch'));
    assert.strictEqual(dispatchErrors.length, 0,
      `Valid boolean dispatch fields must produce no errors; got: ${dispatchErrors.join(', ')}`);
  });

  // Phase B: backgroundDispatch field validation
  test('dispatch.backgroundDispatch:true → ZERO validator errors', () => {
    const cap = makeMinimalRuntimeCap({
      hostIntegration: {
        ...makeMinimalRuntimeCap().runtime.hostIntegration,
        dispatch: { ...makeMinimalRuntimeCap().runtime.hostIntegration.dispatch, backgroundDispatch: true },
      },
    });
    const errors = validateCapability(cap, 'test-runtime');
    const bdErrors = errors.filter((e) => e.includes('backgroundDispatch'));
    assert.strictEqual(bdErrors.length, 0,
      `backgroundDispatch:true must produce no errors; got: ${bdErrors.join(', ')}`);
  });

  test('dispatch.backgroundDispatch:false → ZERO validator errors', () => {
    const cap = makeMinimalRuntimeCap({
      hostIntegration: {
        ...makeMinimalRuntimeCap().runtime.hostIntegration,
        dispatch: { ...makeMinimalRuntimeCap().runtime.hostIntegration.dispatch, backgroundDispatch: false },
      },
    });
    const errors = validateCapability(cap, 'test-runtime');
    const bdErrors = errors.filter((e) => e.includes('backgroundDispatch'));
    assert.strictEqual(bdErrors.length, 0,
      `backgroundDispatch:false must produce no errors; got: ${bdErrors.join(', ')}`);
  });

  test('dispatch.backgroundDispatch:"undocumented" → ZERO validator errors', () => {
    const cap = makeMinimalRuntimeCap({
      hostIntegration: {
        ...makeMinimalRuntimeCap().runtime.hostIntegration,
        dispatch: { ...makeMinimalRuntimeCap().runtime.hostIntegration.dispatch, backgroundDispatch: 'undocumented' },
      },
    });
    const errors = validateCapability(cap, 'test-runtime');
    const bdErrors = errors.filter((e) => e.includes('backgroundDispatch'));
    assert.strictEqual(bdErrors.length, 0,
      `backgroundDispatch:"undocumented" must produce no errors; got: ${bdErrors.join(', ')}`);
  });

  test('dispatch.backgroundDispatch:"zzz" → produces a validator error', () => {
    const cap = makeMinimalRuntimeCap({
      hostIntegration: {
        ...makeMinimalRuntimeCap().runtime.hostIntegration,
        dispatch: { ...makeMinimalRuntimeCap().runtime.hostIntegration.dispatch, backgroundDispatch: 'zzz' },
      },
    });
    const errors = validateCapability(cap, 'test-runtime');
    const bdErrors = errors.filter((e) => e.includes('backgroundDispatch'));
    assert.ok(bdErrors.length > 0,
      `bogus value "zzz" for backgroundDispatch must produce a validator error`);
  });

  test('dispatch without backgroundDispatch key → validator error (required field — all 15 descriptors carry it)', () => {
    // backgroundDispatch is now REQUIRED (matches sibling fields namedDispatch/nested/background/subagentToolkit/maxDepth).
    const cap = makeMinimalRuntimeCap({
      hostIntegration: {
        ...makeMinimalRuntimeCap().runtime.hostIntegration,
        dispatch: (() => {
          const d = { ...makeMinimalRuntimeCap().runtime.hostIntegration.dispatch };
          delete d.backgroundDispatch;
          return d;
        })(),
      },
    });
    const errors = validateCapability(cap, 'test-runtime');
    const bdErrors = errors.filter((e) => e.includes('backgroundDispatch'));
    assert.ok(bdErrors.length > 0,
      `Missing backgroundDispatch (required field) must produce a validator error`);
  });
});

// ---------------------------------------------------------------------------
// Fix 3: validator must reject reserved keys on hostIntegration and dispatch
// ---------------------------------------------------------------------------

describe('Fix 3: reserved-key guard on hostIntegration and hostIntegration.dispatch', () => {
  // Base valid runtime body (all documented values, claude layout)
  // We build it via JSON.parse to produce an own "__proto__" key that would
  // normally be swallowed by a spread (JSON.parse always produces own props).
  const BASE_RUNTIME_JSON = JSON.stringify({
    id: 'test-runtime',
    role: 'runtime',
    title: 'Test',
    description: 'Test runtime',
    tier: 'core',
    requires: [],
    version: '1.6.0',
    engines: { gsd: '>=1.6.0' },
    runtime: {
      configHome: { kind: 'dot-home', name: '.test', env: [] },
      configFormat: 'settings-json',
      artifactLayout: { global: [], local: [] },
      commandStyle: 'slash-hyphen',
      hooksSurface: 'settings-json',
      hookEvents: 'claude',
      sandboxTier: 'none',
      supportTier: 1,
      installSurface: 'settings-json',
      localConfigDir: '.test-runtime',
      writesSharedSettings: true,
      permissionWriter: null,
      extendedHookEvents: ['SubagentStop', 'Stop', 'PreCompact', 'FileChanged'],
      hostIntegration: {
        embeddingMode: 'imperative',
        commandSurface: 'slash-file',
        dispatch: {
          namedDispatch: true,
          nested: true,
          maxDepth: 5,
          background: true,
          subagentToolkit: 'full',
          backgroundDispatch: true,
        },
        modelMode: 'passive',
        hookBus: 'host',
        stateIO: 'filesystem',
        transport: 'mcp',
        runtime: 'node',
      },
    },
  });

  test('baseline (no reserved keys) → ZERO errors', () => {
    const cap = JSON.parse(BASE_RUNTIME_JSON);
    const errors = validateCapability(cap, 'test-runtime');
    assert.strictEqual(errors.length, 0,
      'Baseline with no reserved keys must produce zero errors; got: ' + errors.join(', '));
  });

  test('hostIntegration with own __proto__ key → error mentioning "reserved key" and "__proto__"', () => {
    // Inject a raw __proto__ key via JSON string manipulation — JSON.parse gives it
    // as an OWN property (unlike { ..., __proto__: ... } which sets prototype chain).
    const json = BASE_RUNTIME_JSON.replace(
      '"hostIntegration":{',
      '"hostIntegration":{"__proto__":{"polluted":true},',
    );
    const cap = JSON.parse(json);
    // Verify the own-key is actually present (our assumption about JSON.parse)
    assert.ok(
      Object.prototype.hasOwnProperty.call(cap.runtime.hostIntegration, '__proto__'),
      'JSON.parse must produce an own __proto__ key on hostIntegration',
    );
    const errors = validateCapability(cap, 'test-runtime');
    const reservedErrors = errors.filter((e) => e.includes('reserved key') && e.includes('__proto__'));
    assert.ok(reservedErrors.length > 0,
      'Must produce an error mentioning "reserved key" and "__proto__" for hostIntegration; got: ' + errors.join(', '));
  });

  test('hostIntegration with own "constructor" key → error mentioning "reserved key" and "constructor"', () => {
    const json = BASE_RUNTIME_JSON.replace(
      '"hostIntegration":{',
      '"hostIntegration":{"constructor":"polluted",',
    );
    const cap = JSON.parse(json);
    assert.ok(
      Object.prototype.hasOwnProperty.call(cap.runtime.hostIntegration, 'constructor'),
      'JSON.parse must produce an own constructor key on hostIntegration',
    );
    const errors = validateCapability(cap, 'test-runtime');
    const reservedErrors = errors.filter((e) => e.includes('reserved key') && e.includes('constructor'));
    assert.ok(reservedErrors.length > 0,
      'Must produce an error for "constructor" reserved key on hostIntegration; got: ' + errors.join(', '));
  });

  test('hostIntegration.dispatch with own __proto__ key → error mentioning "reserved key" and "__proto__"', () => {
    const json = BASE_RUNTIME_JSON.replace(
      '"dispatch":{',
      '"dispatch":{"__proto__":{"polluted":true},',
    );
    const cap = JSON.parse(json);
    assert.ok(
      Object.prototype.hasOwnProperty.call(cap.runtime.hostIntegration.dispatch, '__proto__'),
      'JSON.parse must produce an own __proto__ key on dispatch',
    );
    const errors = validateCapability(cap, 'test-runtime');
    const reservedErrors = errors.filter((e) => e.includes('reserved key') && e.includes('__proto__'));
    assert.ok(reservedErrors.length > 0,
      'Must produce an error for "__proto__" reserved key on dispatch; got: ' + errors.join(', '));
  });

  test('hostIntegration.dispatch with own "prototype" key → error mentioning "reserved key" and "prototype"', () => {
    const json = BASE_RUNTIME_JSON.replace(
      '"dispatch":{',
      '"dispatch":{"prototype":{"polluted":true},',
    );
    const cap = JSON.parse(json);
    assert.ok(
      Object.prototype.hasOwnProperty.call(cap.runtime.hostIntegration.dispatch, 'prototype'),
      'JSON.parse must produce an own prototype key on dispatch',
    );
    const errors = validateCapability(cap, 'test-runtime');
    const reservedErrors = errors.filter((e) => e.includes('reserved key') && e.includes('prototype'));
    assert.ok(reservedErrors.length > 0,
      'Must produce an error for "prototype" reserved key on dispatch; got: ' + errors.join(', '));
  });
});

// ---------------------------------------------------------------------------
// #3673 — ADR-1239 Phase 1: all 19 shipped descriptors carry
// dispatch.maxConcurrency (a real sourced integer or the "undocumented"
// sentinel — never silently absent), and every one validates clean.
// ---------------------------------------------------------------------------

describe('#3673 dispatch.maxConcurrency — all 19 shipped descriptors', () => {
  const registry = require(path.join(__dirname, '../gsd-core/bin/lib/capability-registry.cjs'));

  test('registry carries exactly 19 runtime descriptors', () => {
    assert.strictEqual(Object.keys(registry.runtimes).length, 19,
      `expected exactly 19 shipped runtimes; got: ${Object.keys(registry.runtimes).sort().join(', ')}`);
  });

  test('every shipped descriptor declares dispatch.maxConcurrency as a number or "undocumented" — never absent', () => {
    for (const [id, cap] of Object.entries(registry.runtimes)) {
      const mc = cap && cap.runtime && cap.runtime.hostIntegration && cap.runtime.hostIntegration.dispatch
        && cap.runtime.hostIntegration.dispatch.maxConcurrency;
      assert.ok(mc !== undefined,
        `${id}: runtime.hostIntegration.dispatch.maxConcurrency must be present (number or "undocumented")`);
      assert.ok(typeof mc === 'number' || mc === 'undocumented',
        `${id}: runtime.hostIntegration.dispatch.maxConcurrency must be a number or "undocumented"; got: ${JSON.stringify(mc)}`);
    }
  });

  test('claude declares the one real sourced value (20)', () => {
    assert.strictEqual(registry.runtimes.claude.runtime.hostIntegration.dispatch.maxConcurrency, 20);
  });

  test('every other shipped descriptor declares "undocumented" (not researched for this axis)', () => {
    for (const [id, cap] of Object.entries(registry.runtimes)) {
      if (id === 'claude') continue;
      assert.strictEqual(cap.runtime.hostIntegration.dispatch.maxConcurrency, 'undocumented',
        `${id}: expected "undocumented" (only claude has a cited value)`);
    }
  });

  test('validateCapability accepts all 19 shipped descriptors\' dispatch.maxConcurrency with zero errors', () => {
    for (const [id, cap] of Object.entries(registry.runtimes)) {
      const errors = validateCapability(cap, id);
      const mcErrors = errors.filter((e) => e.includes('maxConcurrency'));
      assert.strictEqual(mcErrors.length, 0,
        `${id}: shipped dispatch.maxConcurrency must validate clean; got: ${JSON.stringify(mcErrors)}`);
    }
  });
});

// ---------------------------------------------------------------------------
// #4561: the dispatch-isolation vocabulary has ONE owner — src/dispatch-isolation.cts
// ---------------------------------------------------------------------------
//
// Until #4561 the set {harness-worktree, orchestrator-worktree, none} and its
// worktree-creating subset were hand-written at eight sites with nothing
// asserting they agreed (half of them outside the TypeScript project). This
// block is the cross-check. Every runtime site now CONSUMES the owner, so most
// rows below assert consumption (same object / same set); the one deliberate
// mirror — hooks/lib/isolation-sentinel.js's VALID_ISOLATION, kept literal so
// the guard hooks load on a raw install with no compiled lib — is asserted
// EQUAL, so adding a mode to the owner turns into a red test here until the
// mirror follows.
describe('#4561: dispatch-isolation vocabulary — single owner, every site consumes or mirrors it', () => {
  const owner = require(path.join(__dirname, '../gsd-core/bin/lib/dispatch-isolation.cjs'));
  const {
    DISPATCH_ISOLATION_MODES,
    DISPATCH_ISOLATION_VOCABULARY,
    BASE_CHECK_ISOLATION_MODES,
    BASE_CHECK_ISOLATION_VOCABULARY,
    isDispatchIsolation,
    isBaseCheckIsolationMode,
  } = owner;
  const { VALID_ISOLATION: hookMirror } = require(path.join(__dirname, '../hooks/lib/isolation-sentinel.js'));
  const { cmdWorktreeBaseCheck } = require(path.join(__dirname, '../gsd-core/bin/lib/worktree-base-ref.cjs'));

  test('the owner tuple is frozen, non-empty, duplicate-free, and contains `none` (the fail-closed member every degrade lands on)', () => {
    assert.ok(Object.isFrozen(DISPATCH_ISOLATION_MODES));
    assert.ok(DISPATCH_ISOLATION_MODES.length >= 1);
    assert.equal(new Set(DISPATCH_ISOLATION_MODES).size, DISPATCH_ISOLATION_MODES.length);
    assert.ok(DISPATCH_ISOLATION_MODES.includes('none'));
    assert.deepEqual(sorted(DISPATCH_ISOLATION_VOCABULARY), sorted(DISPATCH_ISOLATION_MODES));
  });

  test('HOST_INTEGRATION_AXES.isolation IS the owner tuple (consumed by identity, not copied)', () => {
    assert.strictEqual(HOST_INTEGRATION_AXES.isolation, DISPATCH_ISOLATION_MODES);
  });

  test('isolation: validator VALID_DISPATCH_ISOLATION === owner (the row the ADR-1239 parity block never had)', () => {
    assert.deepEqual(
      sorted(_HOST_INTEGRATION_VOCAB.isolation),
      sorted(DISPATCH_ISOLATION_MODES),
      'validator VALID_DISPATCH_ISOLATION must exactly match the owner tuple',
    );
  });

  test('hooks/lib/isolation-sentinel.js VALID_ISOLATION mirror === owner (update the mirror when you add a mode)', () => {
    assert.deepEqual(
      sorted(hookMirror),
      sorted(DISPATCH_ISOLATION_MODES),
      'hooks/lib/isolation-sentinel.js keeps a deliberate literal mirror of the vocabulary; it has drifted from src/dispatch-isolation.cts',
    );
  });

  test('every shell `case` validity list for the vocabulary in gsd-core/**/*.md === owner (workflow shell cannot import it, so each list is pinned)', () => {
    // The dispatch sites and diagnostics validate the resolver's output in
    // shell — `case "$ISOLATION" in harness-worktree|orchestrator-worktree|none) ;;`
    // — and shell inside workflow markdown has no way to consume the owner.
    // These are copies that must exist (ADR-4630 Decision 3), so each is
    // pinned: a fourth mode added to the owner and the hook mirror alone
    // would otherwise leave every other test green while these lists reject
    // it and fail the dispatch closed. Sites are DISCOVERED, not listed, so a
    // new copy that names a worktree mode is pinned the day it lands.
    const root = path.join(__dirname, '../gsd-core');
    const members = new Set(DISPATCH_ISOLATION_MODES);
    const found = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.name.endsWith('.md')) continue;
        fs.readFileSync(full, 'utf8').split(/\r?\n/).forEach((line, i) => {
          // Whitespace around `|` is legal shell (`a | b)`), so the parser allows it.
          const alts = parseCaseAlternation(line);
          if (!alts) return;
          // A list is a copy of THIS vocabulary when it names a worktree mode.
          // `none` alone is too common a shell word to key on (`off|none)`),
          // so a list naming neither worktree mode is out of scope by design.
          if (!alts.some((a) => members.has(a) && a !== 'none')) return;
          found.push({ site: `${path.relative(root, full)}:${i + 1}`, alts });
        });
      }
    };
    walk(root);
    // Positive control: the scan must reach the four sites known at this
    // commit (dispatch-isolation-gate.md, executor-isolation-dispatch.md,
    // health.md, settings.md). Fewer means the scan is broken, not clean.
    assert.ok(found.length >= 4, `expected >= 4 shell validity lists, found ${found.length}: ${found.map((f) => f.site).join(', ')}`);
    for (const { site, alts } of found) {
      assert.deepEqual(sorted(alts), sorted(DISPATCH_ISOLATION_MODES),
        `${site}: this shell validity list has drifted from src/dispatch-isolation.cts`);
    }
  });

  test('the base-check subset is exactly the owner minus `none` — derived, not a second list', () => {
    assert.ok(Object.isFrozen(BASE_CHECK_ISOLATION_MODES));
    assert.deepEqual(
      sorted(BASE_CHECK_ISOLATION_MODES),
      sorted(DISPATCH_ISOLATION_MODES.filter((m) => m !== 'none')),
    );
    assert.deepEqual(sorted(BASE_CHECK_ISOLATION_VOCABULARY), sorted(BASE_CHECK_ISOLATION_MODES));
    assert.ok(!BASE_CHECK_ISOLATION_VOCABULARY.has('none'));
  });

  test('type guards accept every member and reject non-members, `none` (for the subset), and non-strings', () => {
    for (const mode of DISPATCH_ISOLATION_MODES) assert.equal(isDispatchIsolation(mode), true, mode);
    for (const mode of BASE_CHECK_ISOLATION_MODES) assert.equal(isBaseCheckIsolationMode(mode), true, mode);
    assert.equal(isBaseCheckIsolationMode('none'), false);
    for (const bogus of ['bogus-mode', '', 'HARNESS-WORKTREE', null, undefined, 3, {}, ['none']]) {
      assert.equal(isDispatchIsolation(bogus), false, JSON.stringify(bogus));
      assert.equal(isBaseCheckIsolationMode(bogus), false, JSON.stringify(bogus));
    }
  });

  test('property: the guards are exactly owner membership over arbitrary strings, prototype keys and near-misses included', () => {
    // A hand-listed `bogus` array tests the inputs someone thought of; this
    // tests the invariant. The near-miss arm keeps the interesting inputs in
    // play at every seed: each member, the prototype keys a bare-object lookup
    // would resolve, and case / whitespace / truncation neighbours of each mode.
    const nearMisses = fc.constantFrom(
      ...DISPATCH_ISOLATION_MODES,
      'constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf',
      ...DISPATCH_ISOLATION_MODES.flatMap((m) => [m.toUpperCase(), ` ${m}`, `${m} `, `${m}\n`, m.slice(0, -1)]),
    );
    fc.assert(fc.property(fc.oneof(fc.string(), nearMisses), (s) => {
      const member = DISPATCH_ISOLATION_MODES.includes(s);
      assert.equal(isDispatchIsolation(s), member, JSON.stringify(s));
      assert.equal(isBaseCheckIsolationMode(s), member && s !== 'none', JSON.stringify(s));
    }));
  });

  test('property: no non-string is a mode, including values that stringify to one', () => {
    const member = fc.constantFrom(...DISPATCH_ISOLATION_MODES);
    const lookalike = fc.oneof(member.map((m) => [m]), member.map((m) => ({ toString: () => m })));
    fc.assert(fc.property(fc.oneof(fc.anything(), lookalike), (v) => {
      fc.pre(typeof v !== 'string');
      assert.equal(isDispatchIsolation(v), false);
      assert.equal(isBaseCheckIsolationMode(v), false);
    }));
  });

  test('property: the shell-list parser recovers exactly the alternatives of a bare-word `case` alternation line, in order (round-trip)', () => {
    // The scan below is a parser over workflow markdown; a parser that drops,
    // merges or splits an alternative would pin a list it misread. Its domain
    // is bare-word alternations (`[a-z][a-z-]*`, the vocabulary's shape), not
    // every shell pattern: `foo1|bar)` or `*.js|*.ts)` are valid shell that the
    // scan deliberately does not read. Render a line in that domain from
    // arbitrary distinct words with arbitrary legal spacing,
    // an optional leading `(`, and an optional trailing `;;` or comment, then
    // parse it back.
    const word = fc.stringMatching(/^[a-z][a-z-]{0,20}$/);
    const ws = fc.stringMatching(/^[ \t]{0,3}$/);
    fc.assert(fc.property(
      fc.uniqueArray(word, { minLength: 2, maxLength: 6 }),
      fc.array(fc.tuple(ws, ws), { minLength: 5, maxLength: 5 }),
      ws, fc.boolean(), ws, fc.constantFrom(' ;;', '', ' # trailing note'),
      (words, gaps, indent, paren, beforeClose, tail) => {
        const body = words.reduce((acc, w, i) => (i === 0 ? w : `${acc}${gaps[i - 1][0]}|${gaps[i - 1][1]}${w}`), '');
        const line = `${indent}${paren ? '(' : ''}${body}${beforeClose})${tail}`;
        assert.deepEqual(parseCaseAlternation(line), words, JSON.stringify(line));
      },
    ));
  });

  test('property: a line that is not a multi-alternative pattern parses to null', () => {
    // A single bare word is not a list (`none) ;;` must not be scanned as one),
    // and a comment or prose line naming the modes is not a pattern.
    const word = fc.stringMatching(/^[a-z][a-z-]{0,20}$/);
    fc.assert(fc.property(word, fc.stringMatching(/^[ \t]{0,3}$/), (w, indent) => {
      assert.equal(parseCaseAlternation(`${indent}${w}) ;;`), null);
      assert.equal(parseCaseAlternation(`${indent}# ${w}|${w}-x)`), null);
    }));
  });

  test('the Set views are SEALED at runtime — `ReadonlySet` erases, so the mutators must refuse (pre-create review MISSED, driven)', (t) => {
    const { VALID_DISPATCH_ISOLATION } = require(path.join(__dirname, '../gsd-core/bin/lib/capability-validator.cjs'));
    assert.strictEqual(VALID_DISPATCH_ISOLATION, DISPATCH_ISOLATION_VOCABULARY, 'the validator consumes the owner Set by identity');
    for (const set of [DISPATCH_ISOLATION_VOCABULARY, BASE_CHECK_ISOLATION_VOCABULARY]) {
      assert.throws(() => set.add('bogus-mode'), TypeError);
      assert.throws(() => set.delete('none'), TypeError);
      assert.throws(() => set.clear(), TypeError);
      // The review's continuation drove this path past a shadowed-method seal:
      // a native Set method applied to the view must find no Set internals.
      assert.throws(() => Set.prototype.add.call(set, 'bogus-mode'), TypeError);
      assert.throws(() => Set.prototype.delete.call(set, 'none'), TypeError);
      assert.throws(() => Set.prototype.clear.call(set), TypeError);
      assert.ok(Object.isFrozen(set));
      assert.equal(set.has('bogus-mode'), false, 'a refused add must not have taken effect');
      assert.equal(set.has('none') || set === BASE_CHECK_ISOLATION_VOCABULARY, true, 'a refused delete must not have taken effect');
      assert.ok(set.size > 0, 'a refused clear must not have taken effect');
      assert.deepEqual([...set], [...set.values()], 'iteration and values() agree (spread is what the validator uses)');
    }
    // The view must not do a dynamic Set.prototype lookup at call time — a
    // patched `has` would otherwise receive the backing Set as `this` and leak
    // it (the review's second continuation drove exactly that). Restored via
    // t.after (the repo's test ruleset bars a try-with-cleanup block in a test body) so a
    // failure here cannot poison the rest of this process.
    const originalHas = Set.prototype.has;
    t.after(() => { Set.prototype.has = originalHas; });
    let leaked = null;
    Set.prototype.has = function patchedHas(value) { leaked = this; return originalHas.call(this, value); };
    DISPATCH_ISOLATION_VOCABULARY.has('none');
    Set.prototype.has = originalHas;
    assert.equal(leaked, null, 'a Set.prototype.has patch installed after load must not observe the backing Set');
    assert.equal(isDispatchIsolation('bogus-mode'), false);
    assert.deepEqual(sorted(DISPATCH_ISOLATION_VOCABULARY), sorted(DISPATCH_ISOLATION_MODES), 'membership unchanged after the refused mutations');
    assert.equal(DISPATCH_ISOLATION_VOCABULARY.size, DISPATCH_ISOLATION_MODES.length);
  });

  test('worktree base-check --mode consumes the subset: `none` and a bogus value are rejected with a message derived from the owner', () => {
    const expectedList = BASE_CHECK_ISOLATION_MODES.join(' or ');
    for (const rejected of ['none', 'bogus-mode']) {
      assert.throws(
        () => cmdWorktreeBaseCheck('/repo', ['--mode', rejected], { readFile: () => null, execGit: () => { throw new Error('unreachable'); }, write: () => {}, userClaudeDir: '/nonexistent-hermetic-user-dir' }),
        (err) => err instanceof Error && err.message.includes(`--mode must be ${expectedList}`),
        `--mode ${rejected} must be refused with the owner-derived list`,
      );
    }
  });

  test('a lib built before the owner existed: unrelated gsd-tools commands still run, and a verb that needs the owner names the build:lib remedy', (t) => {
    // ensureRuntimeBuild's fast path keys on one sentinel, so a lib compiled
    // before src/dispatch-isolation.cts existed reads as built. Reproduce that
    // tree with a preload that refuses the owner to the two HAND-WRITTEN
    // consumers only; a stale tree's compiled siblings predate the owner and
    // never ask for it.
    const tmp = createTempDir('gsd-4561-stale-lib-');
    t.after(() => cleanup(tmp));
    const preload = path.join(tmp, 'hide-owner.cjs');
    fs.writeFileSync(preload, [
      "const Module = require('module');",
      'const orig = Module._resolveFilename;',
      'Module._resolveFilename = function (request, parent, ...rest) {',
      "  if (/dispatch-isolation\\.cjs$/.test(request) && parent && /(gsd-tools|capability-validator)\\.cjs$/.test(parent.filename || '')) {",
      "    const e = new Error(`Cannot find module '${request}'`); e.code = 'MODULE_NOT_FOUND'; throw e;",
      '  }',
      '  return orig.call(this, request, parent, ...rest);',
      '};',
      '',
    ].join('\n'));
    const env = { NODE_OPTIONS: `--require ${JSON.stringify(preload)}` };

    const unrelated = runGsdTools(['current-timestamp', '--raw'], tmp, env);
    assert.equal(unrelated.success, true, `a command that never touches the owner must still run on that tree: ${unrelated.error}`);

    // The query and inspect verbs too: their resolver turns errors into a
    // successful `none`, and dispatch-isolation-gate.md reads rc 0 + `none` as
    // "the runtime declares no isolation primitive". A stale lib is a failure
    // to resolve, so it must exit non-zero instead.
    for (const verb of [
      ['record-dispatch-isolation', '--isolation', 'none'],
      ['query', 'dispatch-isolation', '--raw'],
      ['query', 'inspect-dispatch-isolation', '--raw'],
    ]) {
      const needsOwner = runGsdTools(verb, tmp, env);
      assert.equal(needsOwner.success, false, `${verb.join(' ')} cannot answer without the owner: ${needsOwner.output}`);
      assert.match(needsOwner.error, /dispatch-isolation\.cjs is missing[\s\S]*npm run build:lib/, `${verb.join(' ')} names the remedy, not a bare Cannot find module`);
    }
  });
});
