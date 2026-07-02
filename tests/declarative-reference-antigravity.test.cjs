'use strict';

/**
 * Declarative reference host — Antigravity (#1682 Slice 2 / ADR-1239 Phase D).
 *
 * Locks in Antigravity as the Declarative-CLI reference host driven through the
 * PUBLIC Host-Integration Interface (the declarative adapter), per #1682 AC:
 *   "invoke a gsd command in the Declarative-CLI reference host (Antigravity)
 *    driven by the embedded engine through the public interface, golden-parity
 *    vs Claude."
 *
 * Byte-identity of adapter output vs today's install is gated globally by
 * golden-install-parity (all 16 runtimes) + adapter-declarative-equivalence.
 * THIS test is the reference-host dogfood: it (1) classifies Antigravity's
 * profile via profileOf, (2) confirms the public adapter classifies it as
 * declarative, and (3) round-trips a real install proving a gsd command surface
 * is emitted through the same engine the adapter delegates to.
 */

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { profileOf } = require('../gsd-core/bin/lib/host-integration.cjs');
const { createDeclarativeAdapter } = require('../gsd-core/bin/lib/adapter-declarative.cjs');
const { cleanup } = require('./helpers.cjs');
const { walk, runMinimalInstall, BUILD_SCRIPT } = require('./helpers/install-shared.cjs');

const DESC = path.join(__dirname, '..', 'capabilities', 'antigravity', 'capability.json');

// hooks/dist is gitignored and built (mirrors golden-install-parity harness).
before(() => {
  execFileSync(process.execPath, [BUILD_SCRIPT], { encoding: 'utf-8', stdio: 'pipe' });
});

test('Antigravity classifies as the declarative-cli reference profile (profileOf)', () => {
  const desc = JSON.parse(fs.readFileSync(DESC, 'utf8'));
  const axes = desc.runtime.hostIntegration;
  assert.ok(axes && axes.embeddingMode, 'antigravity descriptor declares hostIntegration axes');
  assert.equal(profileOf(axes), 'declarative-cli',
    'Antigravity is the Declarative-CLI reference host');
});

test('the public declarative adapter classifies Antigravity as a declarative host', () => {
  const adapter = createDeclarativeAdapter({ runtime: 'antigravity' });
  assert.equal(adapter.kind, 'declarative');
  assert.equal(adapter.runtime, 'antigravity');
  assert.equal(typeof adapter.install, 'function');
  assert.equal(typeof adapter.uninstall, 'function');
});

test('a real Antigravity install emits a gsd command/skill surface (invocable)', () => {
  const { configDir, root } = runMinimalInstall({ runtime: 'antigravity', scope: 'global' });
  try {
    const files = walk(configDir);
    assert.ok(files.length > 0, 'install must emit artifacts');
    // Antigravity uses the nested gsd-ns-* router skill layout as its command
    // surface (CONTEXT.md installer module). Assert a gsd skill/router is present.
    const gsdSurface = files.filter((f) => /gsd/i.test(path.relative(configDir, f)));
    assert.ok(gsdSurface.length > 0,
      'install must emit a gsd command/skill surface (declarative reference)');
  } finally {
    cleanup(root);
  }
});
