'use strict';

/**
 * SDK smoke test — ADR-1239 Phase E / #1683 Slice 2.
 *
 * Proves the Host-Integration Interface is PUBLISHED: an external developer can
 * author + wire a new host-plugin against the SDK surface ONLY (no imports of
 * gsd-core internal paths). This test imports exclusively from the SDK entry —
 * if a host-plugin author needs a symbol that ISN'T here, the SDK is incomplete.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

// EXTERNAL-AUTHOR CONTRACT: import ONLY from the published SDK entry.
const SDK = require('../gsd-core/bin/lib/host-integration-sdk.cjs');

test('SDK exports the full public surface a host-plugin author needs', () => {
  assert.equal(typeof SDK.PROTOCOL_VERSION, 'number');
  assert.ok(SDK.HOST_INTEGRATION_AXES, 'negotiated schema (axes)');
  assert.ok(SDK.INTERFACE_POINTS, 'interface points');
  assert.ok(SDK.PROFILE_BASELINES, 'profile baselines');

  const fns = [
    'negotiateHostCapabilities', 'profileOf', 'degradationFor',
    'hookEventSurfaceFor', 'extensionEventSurfaceFor', 'shouldFlattenDispatch',
    'createDeclarativeAdapter', 'createImperativeAdapter',
    'createModelAdapter', 'createHookBus', 'createStateIO',
    'buildHandshakeRequest', 'handleHandshakeRequest',
  ];
  for (const fn of fns) {
    assert.equal(typeof SDK[fn], 'function', `SDK must export function: ${fn}`);
  }
  assert.equal(typeof SDK.HANDSHAKE_METHOD, 'string');
});

test('the SDK surface is frozen (immutable public contract)', () => {
  assert.equal(Object.isFrozen(SDK), true);
});

test('an external author can build a host-plugin against the SDK surface ONLY', () => {
  // Compose a minimal host-plugin using EXCLUSIVELY the SDK entry — mirrors what
  // an external author writes. No require() of any internal path succeeds here.
  const model = SDK.createModelAdapter({ modelMode: 'passive' });
  const bus = SDK.createHookBus({ bus: 'engine' });
  const io = SDK.createStateIO({ io: 'filesystem' });
  const adapter = SDK.createImperativeAdapter({ runtime: 'my-third-party-host' });

  // Negotiate this host's capabilities via the SDK handshake.
  const req = SDK.buildHandshakeRequest({ embeddingMode: 'imperative', runtime: 'node' });
  const result = SDK.handleHandshakeRequest(req);
  const profile = SDK.profileOf(result.effective);

  assert.equal(model.mode, 'passive');
  assert.equal(bus.bus, 'engine');
  assert.equal(io.io, 'filesystem');
  assert.equal(adapter.kind, 'imperative');
  assert.equal(adapter.runtime, 'my-third-party-host');
  assert.equal(profile, 'programmatic-cli');
  assert.ok(result.effective && result.points, 'handshake yields a negotiated result');
});

test('the SDK handshake round-trips for a declarative host authored externally', () => {
  const req = SDK.buildHandshakeRequest({ embeddingMode: 'declarative', commandSurface: 'slash-file' });
  const result = SDK.handleHandshakeRequest(req);
  assert.equal(SDK.profileOf(result.effective), 'declarative-cli');
});
