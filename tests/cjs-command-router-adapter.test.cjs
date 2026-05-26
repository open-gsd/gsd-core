'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { routeCjsCommandFamily, routeHubCommandFamily } = require('../get-shit-done/bin/lib/cjs-command-router-adapter.cjs');
const { makeInvalidArgs } = require('../get-shit-done/bin/lib/command-routing-hub.cjs');

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
