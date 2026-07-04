'use strict';
/**
 * Tests for the model adapter seam (ADR-1239 Phase C-1, AC3 / #1680).
 *
 * Pins:
 *   1. PASSIVE — `resolveModel` delegates to model-resolver's tier routing
 *      (reproduces today's behavior).
 *   2. ACTIVE — `sendRequest` calls the host-supplied primitive; FAIL-CLOSED
 *      (throws) when no provider is bound.
 *   3. FACTORY GATING — invalid modelMode throws.
 *
 * Behavioral tests only; delegation verified via module-ref monkeypatch.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createModelAdapter } = require('../gsd-core/bin/lib/model-adapter.cjs');
const modelResolver = require('../gsd-core/bin/lib/model-resolver.cjs');

test('passive model adapter: resolveModel delegates to model-resolver tier routing (reproduces today behavior)', () => {
  const adapter = createModelAdapter({ modelMode: 'passive' });
  assert.strictEqual(adapter.mode, 'passive');
  const original = modelResolver.resolveModelForTier;
  let captured = null;
  modelResolver.resolveModelForTier = function (...a) { captured = a; return 'sonnet'; };
  try {
    const out = adapter.resolveModel({ cwd: '/tmp/proj', agentType: 'planner', attempt: 2 });
    assert.strictEqual(out, 'sonnet', 'resolveModel must return the resolver result');
    assert.deepStrictEqual(captured, ['/tmp/proj', 'planner', 2], 'must delegate (cwd, agentType, attempt) verbatim');
  } finally {
    modelResolver.resolveModelForTier = original;
  }
});

test('passive model adapter: attempt is optional (delegates undefined when omitted)', () => {
  const adapter = createModelAdapter({ modelMode: 'passive' });
  const original = modelResolver.resolveModelForTier;
  let captured = null;
  modelResolver.resolveModelForTier = function (...a) { captured = a; return 'haiku'; };
  try {
    adapter.resolveModel({ cwd: '/tmp/proj', agentType: 'executor' });
    assert.deepStrictEqual(captured, ['/tmp/proj', 'executor', undefined], 'attempt defaults to undefined');
  } finally {
    modelResolver.resolveModelForTier = original;
  }
});

test('active model adapter: sendRequest invokes the bound host provider', () => {
  const calls = [];
  const adapter = createModelAdapter(
    { modelMode: 'active' },
    { sendRequest: (req) => { calls.push(req); return { ok: true, echo: req }; } },
  );
  assert.strictEqual(adapter.mode, 'active');
  const out = adapter.sendRequest({ prompt: 'hi' });
  assert.deepStrictEqual(calls, [{ prompt: 'hi' }], 'host provider invoked with the request');
  assert.deepStrictEqual(out, { ok: true, echo: { prompt: 'hi' } }, 'host provider return value passed through');
});

test('active model adapter: FAIL-CLOSED when no host provider is bound (sendRequest throws)', () => {
  const adapter = createModelAdapter({ modelMode: 'active' });
  assert.throws(
    () => adapter.sendRequest({ prompt: 'hi' }),
    /no host provider bound/,
    'sendRequest must throw when no provider is bound (fail-closed, never silently no-op)',
  );
});

test('createModelAdapter: invalid modelMode throws (fail-closed construction)', () => {
  for (const bad of ['host', 'dynamic', '', null, undefined, 3]) {
    assert.throws(() => createModelAdapter({ modelMode: bad }), TypeError, `modelMode=${JSON.stringify(bad)} must throw TypeError`);
  }
});
