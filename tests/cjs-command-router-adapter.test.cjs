'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { routeCjsCommandFamily, routeHubCommandFamily } = require('../gsd-core/bin/lib/cjs-command-router-adapter.cjs');
const { makeInvalidArgs } = require('../gsd-core/bin/lib/command-routing-hub.cjs');

describe('cjs-command-router-adapter routeHubCommandFamily', () => {
  test('routes known subcommand handler through the hub', () => {
    let calls = 0;
    let errorMessage = null;

    routeHubCommandFamily({
      family: 'unit',
      args: ['unit', 'ok'],
      subcommands: ['ok'],
      handlers: {
        ok: () => {
          calls += 1;
        },
      },
      unknownMessage: (subcommand, available) => `Unknown ${subcommand}. Available: ${available.join(', ')}`,
      error: (message) => {
        errorMessage = message;
      },
      cwd: '/tmp/proj',
      raw: false,
    });

    assert.equal(calls, 1);
    assert.equal(errorMessage, null);
  });

  test('maps unknown subcommands via unknownMessage and filtered availability', () => {
    let errorMessage = null;

    routeHubCommandFamily({
      family: 'unit',
      args: ['unit', 'missing'],
      subcommands: ['ok', 'legacy'],
      unsupported: { legacy: 'legacy disabled' },
      handlers: { ok: () => {} },
      unknownMessage: (subcommand, available) => `Unknown ${subcommand}. Available: ${available.join(', ')}`,
      error: (message) => {
        errorMessage = message;
      },
      cwd: '/tmp/proj',
      raw: false,
    });

    assert.equal(errorMessage, 'Unknown missing. Available: ok');
  });

  test('returns unsupported subcommand error before dispatch', () => {
    let errorMessage = null;

    routeHubCommandFamily({
      family: 'unit',
      args: ['unit', 'legacy'],
      subcommands: ['ok', 'legacy'],
      unsupported: { legacy: 'legacy disabled' },
      handlers: { ok: () => {} },
      unknownMessage: () => 'should not be used',
      error: (message) => {
        errorMessage = message;
      },
      cwd: '/tmp/proj',
      raw: false,
    });

    assert.equal(errorMessage, 'legacy disabled');
  });

  test('projects InvalidArgs result reason via error callback', () => {
    let errorMessage = null;

    routeHubCommandFamily({
      family: 'unit',
      args: ['unit', 'invalid'],
      subcommands: ['invalid'],
      handlers: {
        invalid: () => makeInvalidArgs('--phase', '--phase must be an integer'),
      },
      unknownMessage: () => 'should not be used',
      error: (message) => {
        errorMessage = message;
      },
      cwd: '/tmp/proj',
      raw: false,
    });

    assert.equal(errorMessage, '--phase must be an integer');
  });

  test('projects InvalidArgs exitReason as second error() arg when present (#1644)', () => {
    let capturedMessage = null;
    let capturedExitReason = null;
    let callCount = 0;

    routeHubCommandFamily({
      family: 'unit',
      args: ['unit', 'invalid'],
      subcommands: ['invalid'],
      handlers: {
        invalid: () => makeInvalidArgs('--phase', '--phase must be an integer', 'USAGE'),
      },
      unknownMessage: () => 'should not be used',
      error: (message, exitReason) => {
        callCount += 1;
        capturedMessage = message;
        capturedExitReason = exitReason;
      },
      cwd: '/tmp/proj',
      raw: false,
    });

    assert.equal(callCount, 1);
    assert.equal(capturedMessage, '--phase must be an integer',
      `error() message must be the InvalidArgs.reason; got: ${JSON.stringify(capturedMessage)}`);
    assert.equal(capturedExitReason, 'USAGE',
      `error() exitReason must be passed as second arg; got: ${JSON.stringify(capturedExitReason)}`);
  });

  test('omits second error() arg when InvalidArgs has no exitReason (byte-identical with prior behavior)', () => {
    let capturedArgs = null;

    routeHubCommandFamily({
      family: 'unit',
      args: ['unit', 'invalid'],
      subcommands: ['invalid'],
      handlers: {
        invalid: () => makeInvalidArgs('--phase', '--phase must be an integer'),
      },
      unknownMessage: () => 'should not be used',
      error: (...args) => {
        capturedArgs = args;
      },
      cwd: '/tmp/proj',
      raw: false,
    });

    assert.equal(capturedArgs.length, 1,
      `error() must be called with EXACTLY one arg when exitReason absent (preserve byte-identical prior behavior); got ${capturedArgs.length} args`);
    assert.equal(capturedArgs[0], '--phase must be an integer');
  });

  test('projects thrown handler exceptions as HandlerFailure message', () => {
    let errorMessage = null;

    routeHubCommandFamily({
      family: 'unit',
      args: ['unit', 'boom'],
      subcommands: ['boom'],
      handlers: {
        boom: () => {
          throw new Error('boom');
        },
      },
      unknownMessage: () => 'should not be used',
      error: (message) => {
        errorMessage = message;
      },
      cwd: '/tmp/proj',
      raw: false,
    });

    assert.equal(errorMessage, 'boom');
  });
});

describe('cjs-command-router-adapter routeCjsCommandFamily', () => {
  test('routes known subcommand handler via the legacy adapter', () => {
    let calls = 0;
    let errorMessage = null;

    routeCjsCommandFamily({
      args: ['unit', 'ok'],
      subcommands: ['ok'],
      handlers: {
        ok: () => {
          calls += 1;
        },
      },
      unknownMessage: (subcommand, available) => `Unknown ${subcommand}. Available: ${available.join(', ')}`,
      error: (message) => {
        errorMessage = message;
      },
      cwd: '/tmp/proj',
      raw: false,
    });

    assert.equal(calls, 1);
    assert.equal(errorMessage, null);
  });

  test('honors defaultSubcommand when args[1] is absent', () => {
    let calls = 0;
    let errorMessage = null;

    routeCjsCommandFamily({
      args: ['unit'],
      subcommands: ['load'],
      defaultSubcommand: 'load',
      handlers: {
        load: () => {
          calls += 1;
        },
      },
      unknownMessage: (subcommand, available) => `Unknown ${subcommand}. Available: ${available.join(', ')}`,
      error: (message) => {
        errorMessage = message;
      },
      cwd: '/tmp/proj',
      raw: false,
    });

    assert.equal(calls, 1);
    assert.equal(errorMessage, null);
  });

  test('converts thrown handler exceptions into error callback messages', () => {
    let errorMessage = null;

    routeCjsCommandFamily({
      args: ['unit', 'boom'],
      subcommands: ['boom'],
      handlers: {
        boom: () => {
          throw new Error('boom');
        },
      },
      unknownMessage: () => 'should not be used',
      error: (message) => {
        errorMessage = message;
      },
      cwd: '/tmp/proj',
      raw: false,
    });

    assert.equal(errorMessage, 'boom');
  });
});
