// allow-test-rule: structural-regression-guard — AC2 requires asserting no `runtime === 'kimi'` string-equality branch (nor an `isKimi` helper) remains in bin/install.js, src/install-engine.cts, and src/runtime-artifact-conversion.cts — the descriptor-migration contract is a property of the source text, so a source-grep is the only faithful check (#2095)
'use strict';

/**
 * kimi imperative reference host — ADR-1239 Phase D / #2095 (EoS/kimi).
 *
 * Proves kimi is driven through the PUBLIC Host-Integration Interface (the
 * imperative adapter), that its negotiated axes classify + negotiate correctly,
 * that negotiation fails CLOSED on a corrupted descriptor, and that the
 * migration retired the hardcoded `runtime === 'kimi'` / `isKimi` branches
 * across the install engine and artifact conversion modules (folded into
 * descriptor-driven `runtime.hostBehaviors`).
 *
 * kimi contributes two real upgrades covered in tests/kimi-upgrades.test.cjs:
 *
 *   UPGRADE 1 — native hook bus: `hooksSurface` moved from `"none"` to
 *   `"kimi-hooks-toml"` — GSD's lifecycle hooks are now registered as
 *   `[[hooks]]` array-of-tables entries in Kimi's own native
 *   `~/.kimi/config.toml` (Beta feature on Kimi's side), marker-delimited so
 *   reinstall only ever touches GSD's own block.
 *
 *   UPGRADE 2 — background dispatch: `hostIntegration.dispatch.backgroundDispatch`
 *   flipped `false` → `true`, which flips `shouldFlattenDispatch` to `false`
 *   for kimi (joining codex/cursor/opencode as background-eligible).
 *
 * kimi's `dispatch.subagentToolkit` stays `'undocumented'` (no authoritative
 * doc found), so this file also proves that axis degrades closed to
 * `'read-only'` on negotiation rather than being trusted at face value.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createImperativeAdapter } = require('../gsd-core/bin/lib/adapter-imperative.cjs');
const {
  profileOf,
  negotiateHostCapabilities,
  PROFILE_BASELINES,
  UNDOCUMENTED,
} = require('../gsd-core/bin/lib/host-integration.cjs');

const KIMI_CAP = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'capabilities', 'kimi', 'capability.json'), 'utf8'),
);
const KIMI_AXES = KIMI_CAP.runtime.hostIntegration;

// -- AC2: driven through the public interface (imperative adapter) -----------

test('createImperativeAdapter classifies kimi as imperative + composes the registry', () => {
  const adapter = createImperativeAdapter({ runtime: 'kimi' });
  assert.equal(adapter.kind, 'imperative');
  assert.equal(adapter.runtime, 'kimi');
  assert.ok(adapter.registry && typeof adapter.registry === 'object');
  assert.equal(typeof adapter.install, 'function');
  assert.equal(typeof adapter.uninstall, 'function');
});

test('kimi axes classify as the programmatic-cli reference profile', () => {
  assert.equal(profileOf(KIMI_AXES), 'programmatic-cli');
});

// -- AC3: all axes populated + validated -------------------------------------

test('kimi descriptor declares all 8 axes + 6 dispatch sub-axes with exact values', () => {
  assert.equal(KIMI_AXES.embeddingMode, 'imperative');
  assert.equal(KIMI_AXES.commandSurface, 'slash-file');
  assert.equal(KIMI_AXES.modelMode, 'passive');
  assert.equal(KIMI_AXES.hookBus, 'host');
  assert.equal(KIMI_AXES.stateIO, 'filesystem');
  assert.equal(KIMI_AXES.transport, 'mcp');
  assert.equal(KIMI_AXES.runtime, 'python');
  const d = KIMI_AXES.dispatch;
  assert.equal(d.namedDispatch, true);
  assert.equal(d.nested, false);
  assert.equal(d.maxDepth, 1);
  assert.equal(d.background, true);
  assert.equal(d.subagentToolkit, 'undocumented');
  assert.equal(d.backgroundDispatch, true);
});

// -- AC5: negotiation fails CLOSED on a corrupted descriptor ------------------

test('negotiateHostCapabilities never throws for kimi, even fully corrupted', () => {
  assert.doesNotThrow(() => negotiateHostCapabilities({}));
  assert.doesNotThrow(() => negotiateHostCapabilities({ ...KIMI_AXES, embeddingMode: UNDOCUMENTED }));
  assert.doesNotThrow(() => negotiateHostCapabilities({ ...KIMI_AXES, embeddingMode: 'future-unknown' }));
  assert.doesNotThrow(() => negotiateHostCapabilities({ ...KIMI_AXES, dispatch: 'corrupted-not-an-object' }));
  assert.doesNotThrow(() => negotiateHostCapabilities({ ...KIMI_AXES, dispatch: { ...KIMI_AXES.dispatch, maxDepth: 'not-a-number' } }));
});

test('a partial/empty kimi descriptor degrades to the safe floor, not the programmatic-cli baseline', () => {
  const result = negotiateHostCapabilities({});
  assert.equal(result.effective.embeddingMode, 'declarative', 'omitted embeddingMode degrades closed');
  assert.equal(result.effective.hookBus, 'none');
  assert.notDeepEqual(result.effective, PROFILE_BASELINES['programmatic-cli']);
  assert.ok(result.warnings.length > 0);
});

test("kimi's undocumented dispatch.subagentToolkit degrades closed to 'read-only' on negotiation", () => {
  const { effective, warnings } = negotiateHostCapabilities(KIMI_AXES);
  assert.equal(KIMI_AXES.dispatch.subagentToolkit, 'undocumented', 'sanity: the descriptor itself stays undocumented');
  assert.equal(effective.dispatch.subagentToolkit, 'read-only', 'undocumented never propagates as full — degrades closed');
  assert.ok(
    warnings.some((w) => /subagentToolkit is undocumented/.test(w)),
    'a warning must be raised for the undocumented axis',
  );
});

// -- AC2: the folded-in behaviors ---------------------------------------------

test('kimi descriptor declares runtime.hostBehaviors (the folded-in behaviors)', () => {
  const hb = KIMI_CAP.runtime.hostBehaviors;
  assert.ok(hb && typeof hb === 'object');
  assert.equal(hb.reapplyCommand, '/skill:gsd-update --reapply');
  assert.equal(hb.localInstallDeferred, true);
  assert.equal(hb.verificationStyle, 'kimi');
  assert.equal(hb.agentManifestStyle, 'kimi-nested');
  assert.equal(hb.doneBannerStyle, 'kimi-agent-file');
});

// -- boundary/negative: hooksSurface + extendedHookEvents are exactly what's documented

test('capabilities/kimi/capability.json hooksSurface is "kimi-hooks-toml" and extendedHookEvents is exactly the 4 documented events', () => {
  assert.equal(KIMI_CAP.runtime.hooksSurface, 'kimi-hooks-toml');
  const events = KIMI_CAP.runtime.extendedHookEvents;
  assert.deepEqual(events, ['SubagentStop', 'Stop', 'PreCompact', 'SubagentStart']);
  assert.equal(events.length, 4);
});

// -- AC2: the hardcoded branches are retired across all folded modules -------

test('no `runtime === "kimi"` string-equality branch (nor an `isKimi` helper) remains in the descriptor-migrated modules (AC2)', () => {
  const strip = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\r\n]*/g, '')
    .replace(/`[^`]*`/g, '');
  const repoRoot = path.join(__dirname, '..');
  const files = [
    path.join(repoRoot, 'bin', 'install.js'),
    path.join(repoRoot, 'src', 'install-engine.cts'),
    path.join(repoRoot, 'src', 'runtime-artifact-conversion.cts'),
  ];
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    const stripped = strip(src);
    const offenders = stripped.match(/runtime\s*[!=]==\s*'kimi'/g) || [];
    assert.deepEqual(offenders, [],
      `AC2: no hardcoded runtime==='kimi' branch may remain in ${path.relative(repoRoot, file)}; found: ${offenders.join(', ')}`);
    const isKimiHits = stripped.match(/\bisKimi\b/g) || [];
    assert.deepEqual(isKimiHits, [],
      `AC2: no isKimi helper may remain in ${path.relative(repoRoot, file)}; found ${isKimiHits.length} occurrence(s)`);
  }
});
