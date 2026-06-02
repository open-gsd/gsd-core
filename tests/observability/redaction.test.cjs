'use strict';

/**
 * Tests for arg redaction policy (issue #177).
 *
 * Redaction decides whether args appear in emitted events based on
 * the GSD_AUDIT_ARGS env var. Tests use real env manipulation and
 * restore state in afterEach. No mocks.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const {
  shouldIncludeArgs,
  redactEvent,
} = require('../../gsd-core/bin/lib/observability/redaction.cjs');

describe('shouldIncludeArgs', () => {
  let originalEnv;

  beforeEach(() => {
    originalEnv = process.env.GSD_AUDIT_ARGS;
    delete process.env.GSD_AUDIT_ARGS;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.GSD_AUDIT_ARGS;
    } else {
      process.env.GSD_AUDIT_ARGS = originalEnv;
    }
  });

  test('returns false when GSD_AUDIT_ARGS is not set', () => {
    assert.strictEqual(shouldIncludeArgs(), false);
  });

  test('returns false when GSD_AUDIT_ARGS is empty string', () => {
    process.env.GSD_AUDIT_ARGS = '';
    assert.strictEqual(shouldIncludeArgs(), false);
  });

  test('returns false when GSD_AUDIT_ARGS is "0"', () => {
    process.env.GSD_AUDIT_ARGS = '0';
    assert.strictEqual(shouldIncludeArgs(), false);
  });

  test('returns true when GSD_AUDIT_ARGS is "1"', () => {
    process.env.GSD_AUDIT_ARGS = '1';
    assert.strictEqual(shouldIncludeArgs(), true);
  });

  test('returns false for any other non-1 value', () => {
    process.env.GSD_AUDIT_ARGS = 'yes';
    assert.strictEqual(shouldIncludeArgs(), false);

    process.env.GSD_AUDIT_ARGS = 'true';
    assert.strictEqual(shouldIncludeArgs(), false);
  });
});

describe('redactEvent', () => {
  let originalEnv;

  beforeEach(() => {
    originalEnv = process.env.GSD_AUDIT_ARGS;
    delete process.env.GSD_AUDIT_ARGS;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.GSD_AUDIT_ARGS;
    } else {
      process.env.GSD_AUDIT_ARGS = originalEnv;
    }
  });

  test('strips args from event when GSD_AUDIT_ARGS is not set', () => {
    const event = Object.freeze({
      traceId: 'abc',
      command: 'plan',
      args: ['--foo', 'bar'],
      result: { kind: 'ok', data: null },
      timestamp: new Date().toISOString(),
    });
    const redacted = redactEvent(event);
    assert.ok(!('args' in redacted), 'args must be absent after redaction');
    assert.equal(redacted.command, 'plan');
    assert.equal(redacted.traceId, 'abc');
  });

  test('preserves all other fields after redaction', () => {
    const event = Object.freeze({
      traceId: 'xyz',
      parentTraceId: undefined,
      command: 'discuss',
      args: ['--mode', 'fast'],
      result: { kind: 'HandlerRefusal', reason: 'nope' },
      timestamp: '2026-01-01T00:00:00.000Z',
    });
    const redacted = redactEvent(event);
    assert.equal(redacted.traceId, 'xyz');
    assert.equal(redacted.command, 'discuss');
    assert.equal(redacted.timestamp, '2026-01-01T00:00:00.000Z');
    assert.deepStrictEqual(redacted.result, { kind: 'HandlerRefusal', reason: 'nope' });
  });

  test('includes args when GSD_AUDIT_ARGS=1', () => {
    process.env.GSD_AUDIT_ARGS = '1';
    const event = Object.freeze({
      traceId: 'abc',
      command: 'plan',
      args: ['--foo', 'bar'],
      result: { kind: 'ok', data: null },
      timestamp: new Date().toISOString(),
    });
    const redacted = redactEvent(event);
    assert.ok('args' in redacted, 'args must be present when GSD_AUDIT_ARGS=1');
    assert.deepStrictEqual(redacted.args, ['--foo', 'bar']);
  });

  test('event without args field stays without args after redaction', () => {
    const event = Object.freeze({
      traceId: 'abc',
      command: 'plan',
      result: { kind: 'ok', data: null },
      timestamp: new Date().toISOString(),
    });
    const redacted = redactEvent(event);
    assert.ok(!('args' in redacted), 'args should not appear if original event had none');
  });

  test('returns a new object, not a mutation of the original frozen event', () => {
    const event = Object.freeze({
      traceId: 'abc',
      command: 'plan',
      args: ['secret'],
      result: { kind: 'ok', data: null },
      timestamp: new Date().toISOString(),
    });
    const redacted = redactEvent(event);
    // Original must still have args
    assert.ok('args' in event);
    // Redacted must not have args
    assert.ok(!('args' in redacted));
    // They must be different object references
    assert.ok(redacted !== event);
  });
});
