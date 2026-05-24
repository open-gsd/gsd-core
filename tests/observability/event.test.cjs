'use strict';

/**
 * Tests for DispatchEvent shape factory (issue #177).
 *
 * Each test exercises the real module code path and asserts on
 * observable behaviour (return values). No mocks, no vacuous truths.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const {
  makeDispatchEvent,
} = require('../../get-shit-done/bin/lib/observability/event.cjs');

describe('makeDispatchEvent — shape', () => {
  test('returns an object with required top-level fields', () => {
    const event = makeDispatchEvent({
      command: 'plan',
      args: ['--tdd'],
      result: { kind: 'ok', data: null },
    });

    assert.ok(typeof event.traceId === 'string', 'traceId must be a string');
    assert.ok(typeof event.command === 'string', 'command must be a string');
    assert.ok(typeof event.timestamp === 'string', 'timestamp must be a string');
    assert.ok('result' in event, 'result must be present');
  });

  test('traceId is a UUID v4 (format check)', () => {
    const event = makeDispatchEvent({
      command: 'plan',
      result: { kind: 'ok', data: null },
    });
    // UUID v4: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
    const uuidV4Re = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    assert.match(event.traceId, uuidV4Re, `traceId '${event.traceId}' is not a valid UUID v4`);
  });

  test('each call produces a unique traceId', () => {
    const a = makeDispatchEvent({ command: 'plan', result: { kind: 'ok', data: null } });
    const b = makeDispatchEvent({ command: 'plan', result: { kind: 'ok', data: null } });
    assert.notEqual(a.traceId, b.traceId, 'consecutive calls must produce different traceIds');
  });

  test('parentTraceId is always undefined in P1.3', () => {
    const event = makeDispatchEvent({
      command: 'plan',
      result: { kind: 'ok', data: null },
      parentTraceId: 'should-be-ignored',
    });
    // P1.3: parentTraceId field exists but is always undefined
    assert.strictEqual(event.parentTraceId, undefined, 'parentTraceId must be undefined in P1.3');
  });

  test('command is set from input', () => {
    const event = makeDispatchEvent({
      command: 'discuss',
      result: { kind: 'ok', data: null },
    });
    assert.equal(event.command, 'discuss');
  });

  test('timestamp is a valid ISO 8601 string', () => {
    const before = Date.now();
    const event = makeDispatchEvent({
      command: 'plan',
      result: { kind: 'ok', data: null },
    });
    const after = Date.now();
    const parsed = Date.parse(event.timestamp);
    assert.ok(!isNaN(parsed), `timestamp '${event.timestamp}' must parse as a date`);
    assert.ok(parsed >= before, 'timestamp must not be in the past');
    assert.ok(parsed <= after + 5, 'timestamp must not be in the future');
  });

  test('result field is passed through', () => {
    const result = { kind: 'UnknownCommand', command: 'bogus' };
    const event = makeDispatchEvent({ command: 'bogus', result });
    assert.deepStrictEqual(event.result, result);
  });
});

describe('makeDispatchEvent — args field', () => {
  test('args is omitted when not provided', () => {
    const event = makeDispatchEvent({
      command: 'plan',
      result: { kind: 'ok', data: null },
    });
    assert.ok(!('args' in event), 'args must not be present when not supplied');
  });

  test('args is omitted when provided (default redaction)', () => {
    // The event factory itself does NOT decide to include args — that is the
    // redaction layer's job. makeDispatchEvent simply stores args as supplied.
    // By default (no includeArgs), args should NOT appear in the returned event.
    const event = makeDispatchEvent({
      command: 'plan',
      args: ['--foo', 'bar'],
      result: { kind: 'ok', data: null },
      includeArgs: false,
    });
    assert.ok(!('args' in event), 'args must be absent when includeArgs is false');
  });

  test('args is included when includeArgs is true', () => {
    const event = makeDispatchEvent({
      command: 'plan',
      args: ['--foo', 'bar'],
      result: { kind: 'ok', data: null },
      includeArgs: true,
    });
    assert.ok('args' in event, 'args must be present when includeArgs is true');
    assert.deepStrictEqual(event.args, ['--foo', 'bar']);
  });
});

describe('makeDispatchEvent — result variants', () => {
  test('ok result shape', () => {
    const event = makeDispatchEvent({
      command: 'plan',
      result: { kind: 'ok', data: 42 },
    });
    assert.equal(event.result.kind, 'ok');
    assert.equal(event.result.data, 42);
  });

  test('UnknownCommand result shape', () => {
    const event = makeDispatchEvent({
      command: 'bogus',
      result: { kind: 'UnknownCommand', command: 'bogus' },
    });
    assert.equal(event.result.kind, 'UnknownCommand');
    assert.equal(event.result.command, 'bogus');
  });

  test('InvalidArgs result shape', () => {
    const event = makeDispatchEvent({
      command: 'plan',
      result: { kind: 'InvalidArgs', arg: '--bad', reason: 'not recognised' },
    });
    assert.equal(event.result.kind, 'InvalidArgs');
    assert.equal(event.result.arg, '--bad');
  });

  test('HandlerFailure result shape', () => {
    const event = makeDispatchEvent({
      command: 'plan',
      result: { kind: 'HandlerFailure', message: 'boom' },
    });
    assert.equal(event.result.kind, 'HandlerFailure');
    assert.equal(event.result.message, 'boom');
  });
});
