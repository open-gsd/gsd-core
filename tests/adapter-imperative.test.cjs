'use strict';
/**
 * Tests for the imperative embedding adapter (ADR-1239 Phase C-1, AC2 / #1680).
 *
 * Pins:
 *   1. KIND — `kind: 'imperative'`, satisfies the same HostIntegrationInterface
 *      as the declarative adapter (both bind one engine).
 *   2. REGISTRY COMPOSITION — the adapter composes loadRegistry({includeInstalled:
 *      true}) and exposes the result as `.registry` (first-party ∪ installed, so
 *      an in-process host gets identical trust semantics to the CLI).
 *   3. DELEGATION — install/uninstall delegate in-process to install-engine
 *      (byte-identity link, same as the declarative adapter).
 *   4. FAIL-CLOSED CONSTRUCTION — missing/invalid runtime throws.
 *
 * Behavioral tests only; delegation + loadRegistry verified via module-ref
 * monkeypatch (Node module cache shares the one module object).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createImperativeAdapter } = require('../gsd-core/bin/lib/adapter-imperative.cjs');
const installEngine = require('../gsd-core/bin/lib/install-engine.cjs');
const capabilityLoader = require('../gsd-core/bin/lib/capability-loader.cjs');
const registry = require('../gsd-core/bin/lib/capability-registry.cjs');

const RUNTIMES = Object.keys(registry.runtimes);

test('imperative adapter: kind === "imperative" + runtime echoed + registry present, for all 15 runtimes', () => {
  for (const r of RUNTIMES) {
    const adapter = createImperativeAdapter({ runtime: r });
    assert.strictEqual(adapter.kind, 'imperative', `${r}: kind must be 'imperative'`);
    assert.strictEqual(adapter.runtime, r, `${r}: adapter must echo the runtime id`);
    assert.ok(adapter.registry && typeof adapter.registry === 'object', `${r}: registry must be present (composed loadRegistry result)`);
    assert.strictEqual(typeof adapter.install, 'function', `${r}: install must be a function`);
    assert.strictEqual(typeof adapter.uninstall, 'function', `${r}: uninstall must be a function`);
  }
});

test('imperative adapter: loadRegistry composed with includeInstalled:true (host gets CLI-equivalent trust semantics)', () => {
  // Restore-able spy on capabilityLoader.loadRegistry (module-ref, shared via Node cache).
  const original = capabilityLoader.loadRegistry;
  const calls = [];
  capabilityLoader.loadRegistry = function (opts) {
    calls.push(opts);
    // Return a minimal stand-in registry so the factory does not crash.
    return { _spy: true, runtimes: registry.runtimes };
  };
  try {
    const adapter = createImperativeAdapter({ runtime: 'opencode' });
    assert.ok(calls.length >= 1, 'loadRegistry must be invoked once during construction');
    assert.strictEqual(calls[0].includeInstalled, true, 'loadRegistry must be called with includeInstalled:true (compose first-party ∪ installed)');
    assert.strictEqual(adapter.registry._spy, true, 'adapter.registry must expose the composed loadRegistry result');
  } finally {
    capabilityLoader.loadRegistry = original;
  }
});

test('imperative adapter: loadOptions forwarded to loadRegistry (cwd/gsdHome/hostVersion pass-through)', () => {
  const original = capabilityLoader.loadRegistry;
  let captured = null;
  capabilityLoader.loadRegistry = function (opts) { captured = opts; return { runtimes: registry.runtimes }; };
  try {
    createImperativeAdapter({ runtime: 'codex' }, { loadOptions: { cwd: '/tmp/proj', hostVersion: '1.7.0' } });
    assert.strictEqual(captured.includeInstalled, true, 'includeInstalled default preserved');
    assert.strictEqual(captured.cwd, '/tmp/proj', 'loadOptions.cwd forwarded');
    assert.strictEqual(captured.hostVersion, '1.7.0', 'loadOptions.hostVersion forwarded');
  } finally {
    capabilityLoader.loadRegistry = original;
  }
});

test('imperative adapter.install/uninstall delegate in-process to install-engine with exact args', () => {
  const origInstall = installEngine.installRuntimeArtifacts;
  const origUninstall = installEngine.uninstallRuntimeArtifacts;
  try {
    for (const r of RUNTIMES) {
      const adapter = createImperativeAdapter({ runtime: r });
      let installArgs = null;
      let uninstallArgs = null;
      installEngine.installRuntimeArtifacts = function (...a) { installArgs = a; return undefined; };
      installEngine.uninstallRuntimeArtifacts = function (...a) { uninstallArgs = a; return undefined; };
      adapter.install({ configDir: '/tmp/imp/' + r, scope: 'global', resolvedProfile: { p: 1 } });
      adapter.uninstall({ configDir: '/tmp/imp/' + r, scope: 'local' });
      assert.deepStrictEqual(installArgs, [r, '/tmp/imp/' + r, 'global', { p: 1 }, undefined], `${r}: install delegation args`);
      assert.deepStrictEqual(uninstallArgs, [r, '/tmp/imp/' + r, 'local'], `${r}: uninstall delegation args`);
    }
  } finally {
    installEngine.installRuntimeArtifacts = origInstall;
    installEngine.uninstallRuntimeArtifacts = origUninstall;
  }
});

test('createImperativeAdapter: throws on missing/invalid runtime (fail-closed construction)', () => {
  for (const bad of ['', undefined, null]) {
    assert.throws(() => createImperativeAdapter({ runtime: bad }), TypeError, `runtime=${JSON.stringify(bad)} must throw`);
  }
  assert.throws(() => createImperativeAdapter({}), TypeError, 'missing runtime must throw');
});
