'use strict';
/**
 * Tests for the hook-bus seam (ADR-1239 Phase C-1, AC4 / #1680).
 * Pins the three ownership modes + portable floor + fail-closed.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHookBus, PORTABLE_EVENT_FLOOR } = require('../gsd-core/bin/lib/hook-bus.cjs');

test('PORTABLE_EVENT_FLOOR: the 5 portable events (the claude dialect all hook hosts share)', () => {
  assert.deepStrictEqual([...PORTABLE_EVENT_FLOOR], ['SessionStart', 'PreToolUse', 'PostToolUse', 'Stop', 'SessionEnd']);
});

test('engine bus: in-process pub/sub (subscribe + emit reaches handlers)', () => {
  const bus = createHookBus({ bus: 'engine' });
  assert.strictEqual(bus.bus, 'engine');
  const received = [];
  bus.subscribe('PreToolUse', (p) => received.push(['PreToolUse', p]));
  bus.subscribe('Stop', () => received.push(['Stop']));
  bus.emit('PreToolUse', { tool: 'Edit' });
  bus.emit('SessionStart');
  bus.emit('Stop');
  assert.deepStrictEqual(received, [['PreToolUse', { tool: 'Edit' }], ['Stop']]);
});

test('engine bus: a throwing handler is isolated (does not break the bus or other handlers)', () => {
  const bus = createHookBus({ bus: 'engine' });
  const seen = [];
  bus.subscribe('PostToolUse', () => { throw new Error('boom'); });
  bus.subscribe('PostToolUse', (p) => seen.push(p));
  assert.doesNotThrow(() => bus.emit('PostToolUse', { ok: true }));
  assert.deepStrictEqual(seen, [{ ok: true }]);
});

test('none bus: subscribe + emit are silent no-ops (degrade to rule-text)', () => {
  const bus = createHookBus({ bus: 'none' });
  assert.strictEqual(bus.bus, 'none');
  assert.doesNotThrow(() => bus.subscribe('SessionStart', () => { throw new Error('must not be called'); }));
  assert.doesNotThrow(() => bus.emit('SessionStart', {}));
});

test('host bus: emit delegates to the bound host emitter; fail-closed when unbound', () => {
  const emitted = [];
  const bound = createHookBus({ bus: 'host' }, { hostEmit: (e, p) => emitted.push([e, p]) });
  assert.strictEqual(bound.bus, 'host');
  bound.emit('Stop', { reason: 'done' });
  assert.deepStrictEqual(emitted, [['Stop', { reason: 'done' }]]);
  const unbound = createHookBus({ bus: 'host' });
  assert.throws(() => unbound.emit('Stop'), /no host emitter bound/, 'unbound host emit must fail closed');
});

test('createHookBus: invalid mode throws (fail-closed construction)', () => {
  for (const bad of ['cloud', '', null, undefined, 1]) {
    assert.throws(() => createHookBus({ bus: bad }), TypeError, `bus=${JSON.stringify(bad)} must throw`);
  }
});
