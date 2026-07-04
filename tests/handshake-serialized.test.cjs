'use strict';

/**
 * handshake-serialized.test.cjs — ADR-1239 Phase E / #1683 Slice 1.
 *
 * The wire-form capability-exchange handshake MUST be consistent with the
 * in-process negotiateHostCapabilities: a request built + serialized here yields
 * the same NegotiationResult the in-process call produces for the same axes.
 * That consistency is what makes the out-of-process SDK handshake safe.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  negotiateHostCapabilities,
  PROTOCOL_VERSION,
} = require('../gsd-core/bin/lib/host-integration.cjs');
const {
  buildHandshakeRequest,
  handleHandshakeRequest,
  HANDSHAKE_METHOD,
} = require('../gsd-core/bin/lib/handshake-serialized.cjs');

test('HANDSHAKE_METHOD is a non-empty initialize-style wire method name', () => {
  assert.equal(typeof HANDSHAKE_METHOD, 'string');
  assert.ok(HANDSHAKE_METHOD.length > 0);
});

test('buildHandshakeRequest: bare-axes form → {protocolVersion, axes}, JSON-safe', () => {
  const req = buildHandshakeRequest({ embeddingMode: 'declarative', commandSurface: 'slash-file' });
  assert.equal(req.protocolVersion, PROTOCOL_VERSION);
  assert.equal(req.axes.embeddingMode, 'declarative');
  assert.deepEqual(req, JSON.parse(JSON.stringify(req)));
});

test('buildHandshakeRequest: {protocolVersion, axes} form honored', () => {
  const req = buildHandshakeRequest({ protocolVersion: 999, axes: { embeddingMode: 'imperative' } });
  assert.equal(req.protocolVersion, 999);
  assert.equal(req.axes.embeddingMode, 'imperative');
});

test('buildHandshakeRequest throws on non-object descriptor', () => {
  assert.throws(() => buildHandshakeRequest(null), /host descriptor/);
  assert.throws(() => buildHandshakeRequest('x'), /host descriptor/);
});

test('handleHandshakeRequest is CONSISTENT with in-process negotiateHostCapabilities', () => {
  // A full declarative-cli descriptor.
  const axes = {
    embeddingMode: 'declarative', commandSurface: 'slash-file', modelMode: 'passive',
    hookBus: 'host', stateIO: 'filesystem', transport: 'mcp', runtime: 'node',
  };
  const inProcess = negotiateHostCapabilities(axes);
  const wire = handleHandshakeRequest(buildHandshakeRequest(axes));
  // The wire result MUST equal the in-process result for the same axes.
  assert.deepEqual(wire.effective, inProcess.effective);
  assert.deepEqual(wire.protocolVersion, inProcess.protocolVersion);
  assert.deepEqual(wire.points, inProcess.points);
});

test('handleHandshakeRequest returns a strictly JSON-serializable NegotiationResult', () => {
  const wire = handleHandshakeRequest({ protocolVersion: 1, axes: { embeddingMode: 'declarative' } });
  assert.deepEqual(wire, JSON.parse(JSON.stringify(wire)));
});

test('full round-trip: host builds → engine handles → negotiated IDE profile', () => {
  const req = buildHandshakeRequest({ embeddingMode: 'imperative', runtime: 'sandboxed-web' });
  const result = handleHandshakeRequest(req);
  assert.ok(result.effective && typeof result.effective === 'object');
  assert.ok(result.points && typeof result.points === 'object');
  assert.ok(Array.isArray(result.warnings));
});

test('handleHandshakeRequest throws on non-object request', () => {
  assert.throws(() => handleHandshakeRequest(null), /request/);
});
