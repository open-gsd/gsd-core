const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { cleanup } = require('./helpers.cjs');

const {
  validateWorkstreamName,
  parseCliWorkstream,
  resolveActiveWorkstream,
  applyResolvedWorkstreamEnv,
  createMemoryPointerAdapter,
  getActiveWorkstream,
  setActiveWorkstream,
} = require('../get-shit-done/bin/lib/active-workstream-store.cjs');

describe('active-workstream-store', () => {
  test('validateWorkstreamName accepts canonical names', () => {
    assert.equal(validateWorkstreamName('alpha'), true);
    assert.equal(validateWorkstreamName('alpha_2'), true);
    assert.equal(validateWorkstreamName('alpha-2'), true);
  });

  test('validateWorkstreamName rejects invalid names', () => {
    assert.equal(validateWorkstreamName('alpha beta'), false);
    assert.equal(validateWorkstreamName('../alpha'), false);
    assert.equal(validateWorkstreamName('alpha/beta'), false);
  });

  test('parseCliWorkstream parses --ws=<name>', () => {
    const parsed = parseCliWorkstream(['state', 'json', '--ws=alpha', '--raw']);
    assert.equal(parsed.value, 'alpha');
    assert.equal(parsed.source, 'cli');
    assert.deepEqual(parsed.args, ['state', 'json', '--raw']);
  });

  test('parseCliWorkstream parses --ws <name>', () => {
    const parsed = parseCliWorkstream(['state', 'json', '--ws', 'alpha', '--raw']);
    assert.equal(parsed.value, 'alpha');
    assert.equal(parsed.source, 'cli');
    assert.deepEqual(parsed.args, ['state', 'json', '--raw']);
  });

  test('parseCliWorkstream throws on missing value', () => {
    assert.throws(
      () => parseCliWorkstream(['state', 'json', '--ws']),
      /Missing value for --ws/
    );
  });

  test('resolveActiveWorkstream precedence: cli > env > store', () => {
    const cli = resolveActiveWorkstream('/repo', ['state', 'json', '--ws', 'cli-ws'], {
      GSD_WORKSTREAM: 'env-ws',
    }, {
      getStored: () => 'store-ws',
    });
    assert.equal(cli.ws, 'cli-ws');
    assert.equal(cli.source, 'cli');

    const env = resolveActiveWorkstream('/repo', ['state', 'json'], {
      GSD_WORKSTREAM: 'env-ws',
    }, {
      getStored: () => 'store-ws',
    });
    assert.equal(env.ws, 'env-ws');
    assert.equal(env.source, 'env');

    const store = resolveActiveWorkstream('/repo', ['state', 'json'], {
      GSD_WORKSTREAM: '',
    }, {
      getStored: () => 'store-ws',
    });
    assert.equal(store.ws, 'store-ws');
    assert.equal(store.source, 'store');
  });

  test('resolveActiveWorkstream returns none when no source provides a workstream', () => {
    const resolved = resolveActiveWorkstream('/repo', ['state', 'json'], {
      GSD_WORKSTREAM: '',
    }, {
      getStored: () => null,
    });
    assert.equal(resolved.ws, null);
    assert.equal(resolved.source, 'none');
  });

  test('resolveActiveWorkstream rejects invalid selected name', () => {
    assert.throws(
      () => resolveActiveWorkstream('/repo', ['state', 'json', '--ws', 'bad/name']),
      /Invalid workstream name/
    );
  });

  test('applyResolvedWorkstreamEnv sets env only when ws exists', () => {
    const env = { GSD_WORKSTREAM: 'old' };
    applyResolvedWorkstreamEnv({ ws: null }, env);
    assert.equal(env.GSD_WORKSTREAM, 'old');

    applyResolvedWorkstreamEnv({ ws: 'new-ws' }, env);
    assert.equal(env.GSD_WORKSTREAM, 'new-ws');
  });

  test('getActiveWorkstream uses session adapter over shared adapter when session key exists', () => {
    const savedSession = process.env.GSD_SESSION_KEY;
    process.env.GSD_SESSION_KEY = 'session-123';

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-active-store-precedence-'));
    try {
      fs.mkdirSync(path.join(tmpDir, '.planning', 'workstreams', 'session-ws'), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, '.planning', 'workstreams', 'shared-ws'), { recursive: true });

      const session = createMemoryPointerAdapter('session-ws');
      const shared = createMemoryPointerAdapter('shared-ws');

      const active = getActiveWorkstream(tmpDir, {
        activeWorkstreamAdapters: { session, shared },
      });
      assert.equal(active, 'session-ws');
    } finally {
      if (savedSession !== undefined) process.env.GSD_SESSION_KEY = savedSession;
      else delete process.env.GSD_SESSION_KEY;
      cleanup(tmpDir);
    }
  });

  test('getActiveWorkstream self-heals invalid pointer names', () => {
    const adapter = createMemoryPointerAdapter('bad/name');
    const active = getActiveWorkstream('/fake/repo', { activeWorkstreamAdapter: adapter });
    assert.equal(active, null);
    assert.equal(adapter.read(), null);
  });

  test('getActiveWorkstream self-heals stale pointers', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-active-store-stale-'));
    try {
      fs.mkdirSync(path.join(tmpDir, '.planning', 'workstreams'), { recursive: true });
      const adapter = createMemoryPointerAdapter('ghost');
      const active = getActiveWorkstream(tmpDir, { activeWorkstreamAdapter: adapter });
      assert.equal(active, null);
      assert.equal(adapter.read(), null);
    } finally {
      cleanup(tmpDir);
    }
  });

  test('setActiveWorkstream clears pointer on null value', () => {
    const adapter = createMemoryPointerAdapter('alpha');
    setActiveWorkstream('/fake/repo', null, { activeWorkstreamAdapter: adapter });
    assert.equal(adapter.read(), null);
  });
});
