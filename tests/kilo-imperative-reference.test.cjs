// allow-test-rule: structural-regression-guard — AC2 requires asserting no `runtime === 'kilo'` string-equality branch (nor an `isKilo` logic branch) remains in bin/install.js, src/install-engine.cts, src/runtime-artifact-conversion.cts, and src/runtime-artifact-layout.cts — the descriptor-migration contract is a property of the source text, so a source-grep is the only faithful check (#2093)
'use strict';

/**
 * kilo imperative reference host — ADR-1239 Phase D / #2093 (EoS/kilo).
 *
 * Proves Kilo Code is driven through the PUBLIC Host-Integration Interface
 * (the imperative adapter), that its negotiated axes classify + negotiate
 * correctly, that negotiation fails CLOSED on a corrupted descriptor, and
 * that the migration retired the hardcoded `runtime === 'kilo'` / `isKilo`
 * branches across the install engine, artifact conversion, and artifact
 * layout modules (folded into descriptor-driven `runtime.hostBehaviors`).
 *
 * Kilo is an OpenCode fork (same plugin/extension event bus, same static
 * agent-frontmatter model constraint) but its `dispatch.subagentToolkit` is
 * `'undocumented'` — no authoritative Kilo doc states a default subagent
 * toolkit level — so unlike OpenCode/Qwen/Cursor, Kilo's dispatch interface
 * point degrades to `'degraded'`, not `'full'`, even though every other
 * dispatch axis (namedDispatch/nested/maxDepth/background) matches the
 * unbounded-depth programmatic-cli baseline. This is the fail-closed
 * negotiation contract working as designed (see AC-specific test below).
 * The real upgrades (native `.kilo/plugins/gsd-core.js` hook-bus plugin,
 * active-model routing, MCP companion doc, named agent dispatch) are covered
 * in tests/kilo-upgrades.test.cjs.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createImperativeAdapter } = require('../gsd-core/bin/lib/adapter-imperative.cjs');
const {
  profileOf,
  negotiateHostCapabilities,
  degradationFor,
  extensionEventSurfaceFor,
  PROFILE_BASELINES,
  UNDOCUMENTED,
} = require('../gsd-core/bin/lib/host-integration.cjs');

const KILO_CAP = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'capabilities', 'kilo', 'capability.json'), 'utf8'),
);
const KILO_AXES = KILO_CAP.runtime.hostIntegration;

// -- AC2: driven through the public interface (imperative adapter) -----------

test('createImperativeAdapter classifies kilo as imperative + composes the registry', () => {
  const adapter = createImperativeAdapter({ runtime: 'kilo' });
  assert.equal(adapter.kind, 'imperative');
  assert.equal(adapter.runtime, 'kilo');
  assert.ok(adapter.registry && typeof adapter.registry === 'object');
  assert.equal(typeof adapter.install, 'function');
  assert.equal(typeof adapter.uninstall, 'function');
});

test('kilo axes classify as the programmatic-cli reference profile', () => {
  // Confirmed via `node -e` against the real descriptor before asserting:
  // profileOf(KILO_AXES) === 'programmatic-cli' (embeddingMode: 'imperative').
  assert.equal(profileOf(KILO_AXES), 'programmatic-cli');
});

// -- AC3: all axes populated + validated -------------------------------------

test('kilo descriptor declares all 8 axes + 6 dispatch sub-axes with exact values', () => {
  assert.equal(KILO_AXES.embeddingMode, 'imperative');
  assert.equal(KILO_AXES.commandSurface, 'slash-file');
  assert.equal(KILO_AXES.modelMode, 'active');
  assert.equal(KILO_AXES.hookBus, 'host');
  assert.equal(KILO_AXES.stateIO, 'filesystem');
  assert.equal(KILO_AXES.transport, 'mcp');
  assert.equal(KILO_AXES.runtime, 'bun');
  const d = KILO_AXES.dispatch;
  assert.equal(d.namedDispatch, true);
  assert.equal(d.nested, true);
  assert.equal(d.maxDepth, -1);
  assert.equal(d.background, true);
  assert.equal(d.subagentToolkit, 'undocumented');
  assert.equal(d.backgroundDispatch, false);
});

// -- AC5: negotiation fails CLOSED on a corrupted descriptor ------------------

test('negotiateHostCapabilities never throws for kilo, even fully corrupted', () => {
  assert.doesNotThrow(() => negotiateHostCapabilities({}));
  assert.doesNotThrow(() => negotiateHostCapabilities({ ...KILO_AXES, embeddingMode: UNDOCUMENTED }));
  assert.doesNotThrow(() => negotiateHostCapabilities({ ...KILO_AXES, embeddingMode: 'future-unknown' }));
});

test('AC-SPECIFIC: kilo real axes degrade dispatch to "degraded", not "full", because subagentToolkit is "undocumented"', () => {
  // Confirmed via `node -e` against the real descriptor before asserting:
  // degradationFor('dispatch', { dispatch: KILO_AXES.dispatch }) returns
  // { level: 'degraded', fallback: 'restricted/undocumented subagent toolkit — limited dispatch surface' }.
  //
  // Every OTHER dispatch axis matches the unbounded-depth programmatic-cli
  // baseline (namedDispatch:true, nested:true, maxDepth:-1 = unbounded,
  // background:true) — the degradationFor 'dispatch' interface point would
  // return 'full' for that shape IF subagentToolkit were 'full' (see
  // src/host-integration.cts degradationFor, the `disp.subagentToolkit === 'full'`
  // gate ~line 183). Kilo's subagentToolkit is 'undocumented' (no authoritative
  // default toolkit level is documented for Kilo subagents), so the gate fails
  // closed and dispatch degrades instead of reporting full capability.
  const result = degradationFor('dispatch', { dispatch: KILO_AXES.dispatch });
  assert.equal(result.level, 'degraded');
  assert.notEqual(result.level, 'full');
  assert.match(result.fallback, /undocumented subagent toolkit/);

  // Sanity: if subagentToolkit WERE 'full' (all else equal), the same shape
  // would degrade to 'full' — proving the gate is what flips the result, not
  // some other axis.
  const hypotheticalFull = degradationFor('dispatch', { dispatch: { ...KILO_AXES.dispatch, subagentToolkit: 'full' } });
  assert.equal(hypotheticalFull.level, 'full');
});

test('a partial/empty kilo descriptor degrades to the safe floor, not the programmatic-cli baseline', () => {
  const result = negotiateHostCapabilities({});
  assert.equal(result.effective.embeddingMode, 'declarative', 'omitted embeddingMode degrades closed');
  assert.equal(result.effective.hookBus, 'none');
  assert.notDeepEqual(result.effective, PROFILE_BASELINES['programmatic-cli']);
  assert.ok(result.warnings.length > 0);
});

// -- AC2: the folded-in behaviors ---------------------------------------------

test('kilo descriptor declares runtime.hostBehaviors (the folded-in behaviors)', () => {
  const hb = KILO_CAP.runtime.hostBehaviors;
  assert.ok(hb && typeof hb === 'object');
  assert.equal(hb.attributionConfigResolver, 'kilo');
  assert.equal(hb.flatCommandDir, 'command');
  assert.equal(hb.combinedFamilyInstall, true);
  assert.equal(hb.frontmatterDialect, 'kilo');
  assert.equal(hb.skipUpdateBannerCommand, true);
  assert.equal(hb.skipSharedHooksInstall, true);
  assert.ok(hb.nativePlugin && typeof hb.nativePlugin === 'object');
  assert.equal(hb.nativePlugin.dir, 'plugins');
  assert.equal(hb.nativePlugin.file, 'gsd-core.js');
  assert.equal(hb.nativePlugin.source, '.kilo/plugins/gsd-core.js');
});

// -- UPGRADE 1 dialect: kilo shares OpenCode's extension-event bus -----------

test('kilo declares extensionEvents:"kilo" and its event surface equals OpenCode\'s (Kilo is an OpenCode fork)', () => {
  assert.equal(KILO_CAP.runtime.extensionEvents, 'kilo');
  const kiloSurface = extensionEventSurfaceFor('kilo');
  const opencodeSurface = extensionEventSurfaceFor('opencode');
  assert.ok(Array.isArray(kiloSurface) && kiloSurface.length > 0, 'kilo is a consumed extensionEvents dialect (non-empty surface)');
  assert.deepEqual(kiloSurface, opencodeSurface, 'kilo reuses OPENCODE_EXTENSION_EVENTS verbatim — same bus');
});

// -- AC2: the hardcoded branches are retired across all folded modules -------

test('no `runtime === "kilo"` / `isKilo` logic branch remains in the descriptor-migrated modules (AC2)', () => {
  const strip = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\r\n]*/g, '')
    .replace(/`[^`]*`/g, '');
  const repoRoot = path.join(__dirname, '..');
  const files = [
    path.join(repoRoot, 'bin', 'install.js'),
    path.join(repoRoot, 'src', 'install-engine.cts'),
    path.join(repoRoot, 'src', 'runtime-artifact-conversion.cts'),
    path.join(repoRoot, 'src', 'runtime-artifact-layout.cts'),
  ];
  for (const file of files) {
    const stripped = strip(fs.readFileSync(file, 'utf8'));

    const equalityOffenders = stripped.match(/runtime\s*[!=]==\s*'kilo'/g) || [];
    assert.deepEqual(equalityOffenders, [],
      `AC2: no hardcoded runtime==='kilo' branch may remain in ${path.relative(repoRoot, file)}; found: ${equalityOffenders.join(', ')}`);

    // A plain `isKilo` binding (e.g. destructured off runtimeFlags()) is fine —
    // it's the LOGIC branches keyed on it that must be retired.
    const logicOffenders = [
      ...(stripped.match(/if\s*\(\s*isKilo/g) || []),
      ...(stripped.match(/isKilo\s*[&|?]/g) || []),
      ...(stripped.match(/[&|]\s*isKilo/g) || []),
    ];
    assert.deepEqual(logicOffenders, [],
      `AC2: no isKilo logic branch may remain in ${path.relative(repoRoot, file)}; found: ${logicOffenders.join(', ')}`);
  }
});
