// allow-test-rule: AC2 requires asserting no `runtime === 'opencode'` string-equality branch remains in bin/install.js/src — the descriptor-migration contract is a property of the source text, so a source-grep is the only faithful check (#2087)
'use strict';

/**
 * opencode imperative reference host — ADR-1239 Phase D / #2087 (EoS/opencode).
 *
 * Proves opencode is driven through the PUBLIC Host-Integration Interface (the
 * imperative adapter), that its negotiated axes classify + negotiate correctly,
 * that negotiation fails CLOSED on a corrupted descriptor, that the Context7-
 * verified dispatch UPGRADE (background subagents, v1.15/v1.17) changes
 * `shouldFlattenDispatch`, and that the migration retired the hardcoded
 * `runtime === 'opencode'` / `isOpencode` branches (folded into descriptor-driven
 * `runtime.hostBehaviors` + the combined-family engine install path).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createImperativeAdapter } = require('../gsd-core/bin/lib/adapter-imperative.cjs');
const {
  profileOf,
  negotiateHostCapabilities,
  shouldFlattenDispatch,
  extensionEventSurfaceFor,
  PROFILE_BASELINES,
  UNDOCUMENTED,
} = require('../gsd-core/bin/lib/host-integration.cjs');

const OC_CAP = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'capabilities', 'opencode', 'capability.json'), 'utf8'),
);
const OC_AXES = OC_CAP.runtime.hostIntegration;

// -- AC2: driven through the public interface (imperative adapter) -----------

test('createImperativeAdapter classifies opencode as imperative + composes the registry', () => {
  const adapter = createImperativeAdapter({ runtime: 'opencode' });
  assert.equal(adapter.kind, 'imperative');
  assert.equal(adapter.runtime, 'opencode');
  assert.ok(adapter.registry && typeof adapter.registry === 'object');
  assert.equal(typeof adapter.install, 'function');
  assert.equal(typeof adapter.uninstall, 'function');
});

test('opencode axes classify as the programmatic-cli reference profile', () => {
  assert.equal(profileOf(OC_AXES), 'programmatic-cli');
});

// -- AC4: the Context7-verified UPGRADE (background dispatch) -----------------

test('opencode descriptor declares background dispatch true/true (v1.15/v1.17 upgrade)', () => {
  assert.equal(OC_AXES.dispatch.background, true, 'background subagents (v1.15 param, v1.17 default-on)');
  assert.equal(OC_AXES.dispatch.backgroundDispatch, true);
});

test('background UPGRADE changes shouldFlattenDispatch: false now (may background), true for the old axes', () => {
  // Post-upgrade: opencode may run subagents concurrently → NOT force-flattened.
  assert.equal(shouldFlattenDispatch(OC_AXES.dispatch), false,
    'with background:true+backgroundDispatch:true, GSD must NOT force-flatten opencode dispatch');
  // Pin the behavioral change: the pre-#2087 axes DID force-flatten.
  const preUpgrade = { ...OC_AXES.dispatch, background: false, backgroundDispatch: 'undocumented' };
  assert.equal(shouldFlattenDispatch(preUpgrade), true,
    'pre-upgrade (background:false) opencode was force-flattened — this is the behavioral change #2087 lands');
});

test('opencode extension-event surface includes the #2087 additions (permission + session.error)', () => {
  const surface = extensionEventSurfaceFor('opencode');
  assert.ok(surface, 'opencode is a consumed extensionEvents dialect');
  for (const ev of ['permission.asked', 'permission.replied', 'session.error']) {
    assert.ok(surface.includes(ev), `#2087 adds ${ev} to the opencode extension-event surface`);
  }
  // The engine still owns phase sequencing — no workflow-phase events on the bus.
  assert.ok(!surface.some((e) => /plan:|verify:|ship:/.test(e)));
});

// -- AC5: negotiation fails CLOSED on a corrupted descriptor ------------------

test('negotiateHostCapabilities never throws for opencode, even fully corrupted', () => {
  assert.doesNotThrow(() => negotiateHostCapabilities({}));
  assert.doesNotThrow(() => negotiateHostCapabilities({ ...OC_AXES, embeddingMode: UNDOCUMENTED }));
  assert.doesNotThrow(() => negotiateHostCapabilities({ ...OC_AXES, embeddingMode: 'future-unknown' }));
});

test('a partial/empty opencode descriptor degrades to the safe floor, not the programmatic-cli baseline', () => {
  const result = negotiateHostCapabilities({});
  assert.equal(result.effective.embeddingMode, 'declarative', 'omitted embeddingMode degrades closed');
  assert.equal(result.effective.hookBus, 'none');
  assert.notDeepEqual(result.effective, PROFILE_BASELINES['programmatic-cli']);
  assert.ok(result.warnings.length > 0);
});

// -- AC2: the hardcoded branches are retired ---------------------------------

test('opencode descriptor declares runtime.hostBehaviors (the folded-in behaviors)', () => {
  const hb = OC_CAP.runtime.hostBehaviors;
  assert.ok(hb && typeof hb === 'object');
  assert.equal(hb.combinedFamilyInstall, true, 'commands+skills+plugin install runs through the engine (adapter)');
  assert.equal(hb.reapplyCommand, '/gsd-update --reapply');
  assert.equal(hb.attributionConfigResolver, 'opencode');
  assert.equal(hb.flatCommandDir, 'command');
  assert.equal(hb.frontmatterDialect, 'opencode');
  assert.equal(hb.skipHomePrefixSubstitution, true);
  assert.equal(hb.skipSettingsUi, true);
  assert.equal(hb.skipUpdateBannerCommand, true);
  assert.equal(hb.skipCodexSkillsManifest, true);
  assert.equal(hb.nativePlugin.file, 'gsd-core.js');
  assert.equal(hb.nativePlugin.source, '.opencode/plugins/gsd-core.js');
});

test('no `runtime === "opencode"` string-equality branch remains in the install source (AC2)', () => {
  const strip = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\r\n]*/g, '')
    .replace(/`[^`]*`/g, '');
  for (const rel of ['bin/install.js', 'src/install-engine.cts', 'src/runtime-artifact-conversion.cts']) {
    const src = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
    const offenders = strip(src).match(/runtime\s*[!=]==\s*'opencode'/g) || [];
    assert.deepEqual(offenders, [], `AC2: no hardcoded runtime==='opencode' branch may remain in ${rel}; found: ${offenders.join(', ')}`);
  }
});
