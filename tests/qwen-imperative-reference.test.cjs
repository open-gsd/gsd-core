// allow-test-rule: structural-regression-guard — AC2 requires asserting no `runtime === 'qwen'` string-equality branch remains in bin/install.js, src/install-engine.cts, src/runtime-artifact-conversion.cts, and src/runtime-hooks-surface.cts — the descriptor-migration contract is a property of the source text, so a source-grep is the only faithful check (#2092)
'use strict';

/**
 * qwen imperative reference host — ADR-1239 Phase D / #2092 (EoS/qwen).
 *
 * Proves qwen is driven through the PUBLIC Host-Integration Interface (the
 * imperative adapter), that its negotiated axes classify + negotiate correctly,
 * that negotiation fails CLOSED on a corrupted descriptor, and that the
 * migration retired the hardcoded `runtime === 'qwen'` branches across the
 * install engine, artifact conversion, and hooks-surface modules (folded into
 * descriptor-driven `runtime.hostBehaviors`).
 *
 * Unlike hermes (#2091), qwen has NO `extensionEvents` dialect of its own — it
 * still uses the borrowed `hookEvents: "claude"` 6-event surface plus
 * `extendedHookEvents` for the SubagentStop/Stop/PreCompact/SubagentStart
 * lifecycle events, so this file does not assert an extensionEvents dialect.
 * Instead qwen contributes two real upgrades hermes lacked: a native `agents`
 * artifact-layout kind (`.qwen/agents/*.md` subagent projection) and a
 * `SubagentStart` hook — both covered in tests/qwen-upgrades.test.cjs.
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

const QWEN_CAP = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'capabilities', 'qwen', 'capability.json'), 'utf8'),
);
const QWEN_AXES = QWEN_CAP.runtime.hostIntegration;

// -- AC2: driven through the public interface (imperative adapter) -----------

test('createImperativeAdapter classifies qwen as imperative + composes the registry', () => {
  const adapter = createImperativeAdapter({ runtime: 'qwen' });
  assert.equal(adapter.kind, 'imperative');
  assert.equal(adapter.runtime, 'qwen');
  assert.ok(adapter.registry && typeof adapter.registry === 'object');
  assert.equal(typeof adapter.install, 'function');
  assert.equal(typeof adapter.uninstall, 'function');
});

test('qwen axes classify as the programmatic-cli reference profile', () => {
  assert.equal(profileOf(QWEN_AXES), 'programmatic-cli');
});

// -- AC3: all axes populated + validated -------------------------------------

test('qwen descriptor declares all 8 axes + 6 dispatch sub-axes with exact values', () => {
  assert.equal(QWEN_AXES.embeddingMode, 'imperative');
  assert.equal(QWEN_AXES.commandSurface, 'slash-file');
  assert.equal(QWEN_AXES.modelMode, 'passive');
  assert.equal(QWEN_AXES.hookBus, 'host');
  assert.equal(QWEN_AXES.stateIO, 'filesystem');
  assert.equal(QWEN_AXES.transport, 'mcp');
  assert.equal(QWEN_AXES.runtime, 'node');
  const d = QWEN_AXES.dispatch;
  assert.equal(d.namedDispatch, true);
  assert.equal(d.nested, false);
  assert.equal(d.maxDepth, 1);
  assert.equal(d.background, true);
  assert.equal(d.subagentToolkit, 'full');
  assert.equal(d.backgroundDispatch, false);
});

// -- AC5: negotiation fails CLOSED on a corrupted descriptor ------------------

test('negotiateHostCapabilities never throws for qwen, even fully corrupted', () => {
  assert.doesNotThrow(() => negotiateHostCapabilities({}));
  assert.doesNotThrow(() => negotiateHostCapabilities({ ...QWEN_AXES, embeddingMode: UNDOCUMENTED }));
  assert.doesNotThrow(() => negotiateHostCapabilities({ ...QWEN_AXES, embeddingMode: 'future-unknown' }));
});

test('a partial/empty qwen descriptor degrades to the safe floor, not the programmatic-cli baseline', () => {
  const result = negotiateHostCapabilities({});
  assert.equal(result.effective.embeddingMode, 'declarative', 'omitted embeddingMode degrades closed');
  assert.equal(result.effective.hookBus, 'none');
  assert.notDeepEqual(result.effective, PROFILE_BASELINES['programmatic-cli']);
  assert.ok(result.warnings.length > 0);
});

// -- AC2: the folded-in behaviors ---------------------------------------------

test('qwen descriptor declares runtime.hostBehaviors (the folded-in behaviors)', () => {
  const hb = QWEN_CAP.runtime.hostBehaviors;
  assert.ok(hb && typeof hb === 'object');
  assert.equal(hb.skillPriorityFrontmatter, true);
  assert.ok(hb.brandingRewrites && typeof hb.brandingRewrites === 'object');
  assert.equal(hb.brandingRewrites['CLAUDE.md'], 'QWEN.md');
  assert.equal(hb.brandingRewrites['Claude Code'], 'Qwen Code');
  assert.equal(hb.brandingRewrites['.claude/'], '.qwen/');
  assert.equal(hb.legacyCommandsGsdCleanup, true);
  assert.equal(hb.legacyCommandsGsdInstallMigration, true);
  assert.equal(hb.legacyCommandsGsdUninstall, true);
  assert.equal(hb.hyphenNameAgentBody, true);
});

// -- AC2: the hardcoded branches are retired across all folded modules -------

test('no `runtime === "qwen"` string-equality branch remains in the descriptor-migrated modules (AC2)', () => {
  const strip = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\r\n]*/g, '')
    .replace(/`[^`]*`/g, '');
  const repoRoot = path.join(__dirname, '..');
  const files = [
    path.join(repoRoot, 'bin', 'install.js'),
    path.join(repoRoot, 'src', 'install-engine.cts'),
    path.join(repoRoot, 'src', 'runtime-artifact-conversion.cts'),
    path.join(repoRoot, 'src', 'runtime-hooks-surface.cts'),
  ];
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    const offenders = strip(src).match(/runtime\s*[!=]==\s*'qwen'/g) || [];
    assert.deepEqual(offenders, [],
      `AC2: no hardcoded runtime==='qwen' branch may remain in ${path.relative(repoRoot, file)}; found: ${offenders.join(', ')}`);
  }
});
