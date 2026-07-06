'use strict';
/**
 * Equivalence test for the declarative embedding adapter (ADR-1239 Phase C-1,
 * AC1 / #1680).
 *
 * The declarative adapter NAMES + BOUNDS today's projection path behind
 * `HostIntegrationInterface`. This test pins the three load-bearing properties:
 *
 *   1. KIND — every runtime's adapter classifies as `kind: 'declarative'` and
 *      echoes its runtime id.
 *   2. DELEGATION (the byte-identity link) — `install`/`uninstall` delegate
 *      IN-PROCESS to install-engine's `installRuntimeArtifacts` /
 *      `uninstallRuntimeArtifacts` with the EXACT args passed through. Because
 *      the adapter calls the SAME engine functions `bin/install.js` uses, its
 *      output is byte-identical to today's install — the 15-runtime byte
 *      identity is gated by `tests/golden-install-parity.test.cjs` (which
 *      exercises these engine functions end-to-end). Asserting the delegation
 *      link here proves the adapter never diverges from the reference path.
 *   3. FAIL-CLOSED CONSTRUCTION — missing/invalid runtime throws (no silent
 *      default adapter).
 *
 * Behavioral tests only; delegation verified via module-ref monkeypatch (the
 * install-engine.cts:31-38 stub-compatible pattern — Node module cache shares
 * the one module object, so patching it here is seen by the adapter).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createDeclarativeAdapter } = require('../gsd-core/bin/lib/adapter-declarative.cjs');
const installEngine = require('../gsd-core/bin/lib/install-engine.cjs');
const registry = require('../gsd-core/bin/lib/capability-registry.cjs');

const RUNTIMES = Object.keys(registry.runtimes);

test('declarative adapter: kind === "declarative" + runtime echoed, for every registry runtime', () => {
  assert.ok(RUNTIMES.length > 0, `expected at least one runtime in registry, got ${RUNTIMES.length}`);
  for (const r of RUNTIMES) {
    const adapter = createDeclarativeAdapter({ runtime: r });
    assert.strictEqual(adapter.kind, 'declarative', `${r}: kind must be 'declarative'`);
    assert.strictEqual(adapter.runtime, r, `${r}: adapter must echo the runtime id`);
    assert.strictEqual(typeof adapter.install, 'function', `${r}: install must be a function`);
    assert.strictEqual(typeof adapter.uninstall, 'function', `${r}: uninstall must be a function`);
  }
});

test('declarative adapter.install delegates in-process to installRuntimeArtifacts with exact args (byte-identity link)', () => {
  const original = installEngine.installRuntimeArtifacts;
  try {
    for (const r of RUNTIMES) {
      const adapter = createDeclarativeAdapter({ runtime: r });
      let captured = null;
      installEngine.installRuntimeArtifacts = function (...args) { captured = args; return undefined; };
      const resolveAttribution = () => 'attr-' + r;
      const intent = {
        configDir: '/tmp/adapter-eq/' + r,
        scope: 'global',
        resolvedProfile: { profile: r },
        resolveAttribution,
      };
      assert.doesNotThrow(() => adapter.install(intent), `${r}: install threw`);
      assert.ok(captured, `${r}: install did not delegate to installRuntimeArtifacts`);
      assert.deepStrictEqual(
        captured,
        [r, '/tmp/adapter-eq/' + r, 'global', { profile: r }, resolveAttribution],
        `${r}: install delegation args diverged from the engine signature`,
      );
    }
  } finally {
    installEngine.installRuntimeArtifacts = original;
  }
});

test('declarative adapter.uninstall delegates in-process to uninstallRuntimeArtifacts with exact args', () => {
  const original = installEngine.uninstallRuntimeArtifacts;
  try {
    for (const r of RUNTIMES) {
      const adapter = createDeclarativeAdapter({ runtime: r });
      let captured = null;
      installEngine.uninstallRuntimeArtifacts = function (...args) { captured = args; return undefined; };
      assert.doesNotThrow(() => adapter.uninstall({ configDir: '/tmp/adapter-eq/' + r, scope: 'local' }), `${r}: uninstall threw`);
      assert.ok(captured, `${r}: uninstall did not delegate to uninstallRuntimeArtifacts`);
      assert.deepStrictEqual(
        captured,
        [r, '/tmp/adapter-eq/' + r, 'local'],
        `${r}: uninstall delegation args diverged from the engine signature`,
      );
    }
  } finally {
    installEngine.uninstallRuntimeArtifacts = original;
  }
});

test('createDeclarativeAdapter: throws on missing/invalid runtime (fail-closed construction)', () => {
  for (const bad of ['', undefined, null]) {
    assert.throws(
      () => createDeclarativeAdapter({ runtime: bad }),
      TypeError,
      `runtime=${JSON.stringify(bad)} must throw TypeError`,
    );
  }
  assert.throws(() => createDeclarativeAdapter({}), TypeError, 'missing runtime must throw TypeError');
});
