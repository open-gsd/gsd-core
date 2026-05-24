'use strict';

/**
 * Behavioral contract tests for the CommandRoutingHub (issue #3788, #175).
 *
 * #175: mode/sdkLoader/SdkDispatchFailed dropped. Hub always routes CJS.
 *
 * Testing rules in force (CONTRIBUTING.md § Testing Standards):
 *   1. No readFileSync of source files. All assertions are on return values
 *      from the hub's dispatch() function.
 *   2. Stub cjsRegistry / manifest — the hub is the unit under test.
 *      No real SDK load, no real CJS handler invocation (except one integration
 *      path in the phase-command-router migration tests).
 *   3. ERROR_KINDS is a frozen enum. Tests switch on its values, not string literals.
 *   4. Hub must never throw. Every error surface arrives as { ok: false, ... }.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { createHub, ERROR_KINDS } = require('../get-shit-done/bin/lib/command-routing-hub.cjs');

// ─── Frozen taxonomy lock ─────────────────────────────────────────────────────
// #175: SdkDispatchFailed and SdkLoadFailed are removed from the closed enum.
// The set shrinks from 6 to 4 values.
const EXPECTED_ERROR_KINDS = Object.freeze(new Set([
  'UnknownCommand',
  'InvalidArgs',
  'HandlerRefusal',
  'HandlerFailure',
]));

describe('CommandRoutingHub — ERROR_KINDS taxonomy', () => {
  test('exports a frozen ERROR_KINDS object', () => {
    assert.ok(Object.isFrozen(ERROR_KINDS), 'ERROR_KINDS must be frozen');
  });

  test('ERROR_KINDS contains exactly the 4 documented values (SdkDispatchFailed and SdkLoadFailed removed)', () => {
    const actual = new Set(Object.values(ERROR_KINDS));
    assert.deepStrictEqual(actual, EXPECTED_ERROR_KINDS);
  });

  test('ERROR_KINDS does NOT contain SdkDispatchFailed', () => {
    assert.ok(!Object.values(ERROR_KINDS).includes('SdkDispatchFailed'),
      'SdkDispatchFailed must not be in ERROR_KINDS after #175');
  });

  test('ERROR_KINDS does NOT contain SdkLoadFailed', () => {
    assert.ok(!Object.values(ERROR_KINDS).includes('SdkLoadFailed'),
      'SdkLoadFailed must not be in ERROR_KINDS after #175');
  });

  test('ERROR_KINDS keys match their values (self-documenting enum)', () => {
    for (const [key, value] of Object.entries(ERROR_KINDS)) {
      assert.equal(key, value, `ERROR_KINDS.${key} should equal '${key}' but got '${value}'`);
    }
  });
});

// ─── createHub validation ──────────────────────────────────────────────────────
// #175: mode param is removed. Hub is constructed without mode.

describe('CommandRoutingHub — createHub validation', () => {
  test('constructs successfully without any mode parameter', () => {
    // Hub no longer requires mode — no throw when mode is absent
    const hub = createHub({ cjsRegistry: {} });
    assert.ok(typeof hub.dispatch === 'function');
  });

  test('mode parameter is ignored — passing mode: sdk does not route to SDK', () => {
    // Even if a legacy caller passes mode:'sdk', the hub must use CJS dispatch.
    const cjsCalls = [];
    const hub = createHub({
      mode: 'sdk',
      cjsRegistry: {
        phase: {
          add: (_ctx) => { cjsCalls.push(true); return { ok: true, data: 'cjs-dispatched' }; },
        },
      },
    });

    const result = hub.dispatch({ family: 'phase', subcommand: 'add', args: [], cwd: '/', raw: false });

    // Must route through CJS, not SDK
    assert.ok(result.ok, `Expected ok:true but got: ${JSON.stringify(result)}`);
    assert.equal(result.data, 'cjs-dispatched', 'Hub must dispatch through CJS regardless of mode parameter');
    assert.equal(cjsCalls.length, 1, 'CJS handler must be called exactly once');
  });

  test('mode parameter is ignored — passing mode: cjs also routes through CJS', () => {
    const cjsCalls = [];
    const hub = createHub({
      mode: 'cjs',
      cjsRegistry: {
        state: {
          load: (_ctx) => { cjsCalls.push(true); return { ok: true, data: 'state-loaded' }; },
        },
      },
    });

    const result = hub.dispatch({ family: 'state', subcommand: 'load', args: [], cwd: '/', raw: false });

    assert.ok(result.ok);
    assert.equal(result.data, 'state-loaded');
    assert.equal(cjsCalls.length, 1);
  });

  test('sdkLoader parameter is inert — passing sdkLoader does not cause SDK dispatch', () => {
    // sdkLoader is removed; passing it must not cause the Hub to call it
    const sdkCalls = [];
    const hub = createHub({
      sdkLoader: () => { sdkCalls.push(true); return () => ({ ok: true, data: 'sdk-data' }); },
      cjsRegistry: {
        phase: {
          add: (_ctx) => ({ ok: true, data: 'cjs-data' }),
        },
      },
    });

    const result = hub.dispatch({ family: 'phase', subcommand: 'add', args: [], cwd: '/', raw: false });

    assert.equal(sdkCalls.length, 0, 'sdkLoader must never be called — it is removed in #175');
    assert.ok(result.ok);
    assert.equal(result.data, 'cjs-data');
  });

  test('constructs successfully with only cjsRegistry', () => {
    const hub = createHub({ cjsRegistry: { phase: { add: () => ({ ok: true, data: null }) } } });
    assert.ok(typeof hub.dispatch === 'function');
  });
});

// ─── Happy path — always CJS ──────────────────────────────────────────────────

describe('CommandRoutingHub — happy path, CJS dispatch', () => {
  test('dispatch returns { ok: true, data } from CJS handler result', () => {
    const hub = createHub({
      cjsRegistry: {
        phase: {
          complete: (_ctx) => ({ ok: true, data: { completed: true } }),
        },
      },
      manifest: { phase: ['complete'] },
    });

    const result = hub.dispatch({ family: 'phase', subcommand: 'complete', args: ['01'], cwd: '/tmp', raw: false });

    assert.ok(result.ok);
    assert.deepEqual(result.data, { completed: true });
  });

  test('dispatch passes full context to CJS handler', () => {
    const received = [];
    const hub = createHub({
      cjsRegistry: {
        roadmap: {
          analyze: (ctx) => { received.push(ctx); return { ok: true, data: null }; },
        },
      },
    });

    hub.dispatch({ family: 'roadmap', subcommand: 'analyze', args: ['--verbose'], cwd: '/myproj', raw: true });

    assert.equal(received.length, 1);
    assert.equal(received[0].family, 'roadmap');
    assert.equal(received[0].subcommand, 'analyze');
    assert.deepEqual(received[0].args, ['--verbose']);
    assert.equal(received[0].cwd, '/myproj');
    assert.equal(received[0].raw, true);
  });

  test('handler returning undefined is treated as ok:true with data:null', () => {
    const hub = createHub({
      cjsRegistry: {
        state: {
          load: (_ctx) => undefined,
        },
      },
    });

    const result = hub.dispatch({ family: 'state', subcommand: 'load', args: [], cwd: '/', raw: false });

    assert.ok(result.ok);
    assert.equal(result.data, null);
  });

  test('handler returning a plain value wraps it as data payload', () => {
    const hub = createHub({
      cjsRegistry: {
        verify: {
          check: (_ctx) => 'all-good',
        },
      },
    });

    const result = hub.dispatch({ family: 'verify', subcommand: 'check', args: [], cwd: '/', raw: false });

    assert.ok(result.ok);
    assert.equal(result.data, 'all-good');
  });
});

// ─── errorKind: UnknownCommand ────────────────────────────────────────────────

describe('CommandRoutingHub — errorKind: UnknownCommand', () => {
  test('unknown family in manifest returns UnknownCommand', () => {
    const hub = createHub({
      cjsRegistry: {},
      manifest: { phase: ['add'] },
    });

    const result = hub.dispatch({ family: 'bogus', subcommand: 'add', args: [], cwd: '/', raw: false });

    assert.ok(!result.ok);
    assert.equal(result.errorKind, ERROR_KINDS.UnknownCommand);
  });

  test('unknown subcommand in manifest returns UnknownCommand', () => {
    const hub = createHub({
      cjsRegistry: {},
      manifest: { phase: ['add'] },
    });

    const result = hub.dispatch({ family: 'phase', subcommand: 'nonexistent', args: [], cwd: '/', raw: false });

    assert.ok(!result.ok);
    assert.equal(result.errorKind, ERROR_KINDS.UnknownCommand);
  });

  test('missing family in cjsRegistry returns UnknownCommand (no manifest)', () => {
    const hub = createHub({
      cjsRegistry: { state: { load: () => ({ ok: true, data: null }) } },
    });

    const result = hub.dispatch({ family: 'bogus-family', subcommand: 'sub', args: [], cwd: '/', raw: false });

    assert.ok(!result.ok);
    assert.equal(result.errorKind, ERROR_KINDS.UnknownCommand);
  });

  test('missing subcommand in cjsRegistry returns UnknownCommand', () => {
    const hub = createHub({
      cjsRegistry: { phase: { add: () => ({ ok: true, data: null }) } },
    });

    const result = hub.dispatch({ family: 'phase', subcommand: 'not-there', args: [], cwd: '/', raw: false });

    assert.ok(!result.ok);
    assert.equal(result.errorKind, ERROR_KINDS.UnknownCommand);
  });
});

// ─── errorKind: InvalidArgs ───────────────────────────────────────────────────

describe('CommandRoutingHub — errorKind: InvalidArgs', () => {
  test('handler returning InvalidArgs result propagates it', () => {
    const hub = createHub({
      cjsRegistry: {
        phase: {
          insert: (_ctx) => ({
            ok: false,
            errorKind: ERROR_KINDS.InvalidArgs,
            message: 'phase insert requires a phase number',
          }),
        },
      },
    });

    const result = hub.dispatch({ family: 'phase', subcommand: 'insert', args: [], cwd: '/', raw: false });

    assert.ok(!result.ok);
    assert.equal(result.errorKind, ERROR_KINDS.InvalidArgs);
    assert.ok(result.message.includes('phase number'));
  });
});

// ─── errorKind: HandlerRefusal ────────────────────────────────────────────────

describe('CommandRoutingHub — errorKind: HandlerRefusal', () => {
  test('handler returning HandlerRefusal result propagates it', () => {
    const hub = createHub({
      cjsRegistry: {
        phase: {
          'list-plans': (_ctx) => ({
            ok: false,
            errorKind: ERROR_KINDS.HandlerRefusal,
            message: 'phase list-plans is SDK-only',
          }),
        },
      },
    });

    const result = hub.dispatch({ family: 'phase', subcommand: 'list-plans', args: [], cwd: '/', raw: false });

    assert.ok(!result.ok);
    assert.equal(result.errorKind, ERROR_KINDS.HandlerRefusal);
  });
});

// ─── errorKind: HandlerFailure ────────────────────────────────────────────────

describe('CommandRoutingHub — errorKind: HandlerFailure', () => {
  test('hub does not throw when CJS handler throws — returns HandlerFailure', () => {
    const hub = createHub({
      cjsRegistry: {
        phase: {
          add: (_ctx) => { throw new Error('handler blew up'); },
        },
      },
    });

    let result;
    assert.doesNotThrow(() => {
      result = hub.dispatch({ family: 'phase', subcommand: 'add', args: ['desc'], cwd: '/', raw: false });
    });

    assert.ok(!result.ok);
    assert.equal(result.errorKind, ERROR_KINDS.HandlerFailure);
    assert.ok(result.message.includes('handler blew up'));
  });

  test('HandlerFailure details.originalError carries the thrown error', () => {
    const originalError = new Error('boom');
    const hub = createHub({
      cjsRegistry: {
        state: {
          load: (_ctx) => { throw originalError; },
        },
      },
    });

    const result = hub.dispatch({ family: 'state', subcommand: 'load', args: [], cwd: '/', raw: false });

    assert.ok(!result.ok);
    assert.equal(result.errorKind, ERROR_KINDS.HandlerFailure);
    assert.strictEqual(result.details.originalError, originalError);
  });
});

// ─── hub never throws ─────────────────────────────────────────────────────────

describe('CommandRoutingHub — hub never throws', () => {
  test('hub does not throw even when cjsRegistry is completely absent', () => {
    const hub = createHub({});

    let result;
    assert.doesNotThrow(() => {
      result = hub.dispatch({ family: 'phase', subcommand: 'add', args: [], cwd: '/', raw: false });
    });

    assert.ok(!result.ok);
    assert.equal(result.errorKind, ERROR_KINDS.UnknownCommand);
  });

  test('hub does not throw when dispatch receives malformed request', () => {
    const hub = createHub({ cjsRegistry: {} });

    let result;
    assert.doesNotThrow(() => {
      // Missing family — would normally throw on string ops
      result = hub.dispatch({ family: undefined, subcommand: 'add', args: [], cwd: '/', raw: false });
    });

    // Result is an error, not a thrown exception
    assert.ok(!result.ok);
  });
});

// ─── No SDK path — single-dispatch invariant ──────────────────────────────────
// #175: Hub is always CJS. There is no SDK path to fall through to.

describe('CommandRoutingHub — single CJS dispatch invariant (#175)', () => {
  test('two dispatches through the same hub produce consistent CJS results', () => {
    const calls = [];
    const hub = createHub({
      cjsRegistry: {
        phase: {
          add: (_ctx) => { calls.push('add'); return { ok: true, data: 'added' }; },
          complete: (_ctx) => { calls.push('complete'); return { ok: true, data: 'done' }; },
        },
      },
    });

    const r1 = hub.dispatch({ family: 'phase', subcommand: 'add', args: [], cwd: '/', raw: false });
    const r2 = hub.dispatch({ family: 'phase', subcommand: 'complete', args: [], cwd: '/', raw: false });

    assert.ok(r1.ok);
    assert.equal(r1.data, 'added');
    assert.ok(r2.ok);
    assert.equal(r2.data, 'done');
    assert.deepEqual(calls, ['add', 'complete']);
  });

  test('manifest check still applies in CJS-only hub', () => {
    const hub = createHub({
      cjsRegistry: { phase: { add: () => ({ ok: true, data: null }) } },
      manifest: { phase: ['add'] },
    });

    const known = hub.dispatch({ family: 'phase', subcommand: 'add', args: [], cwd: '/', raw: false });
    const unknown = hub.dispatch({ family: 'phase', subcommand: 'nonexistent', args: [], cwd: '/', raw: false });

    assert.ok(known.ok);
    assert.ok(!unknown.ok);
    assert.equal(unknown.errorKind, ERROR_KINDS.UnknownCommand);
  });
});
