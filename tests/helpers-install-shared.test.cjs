'use strict';

/**
 * #4688 — installRuntimeFixture / createRuntimeFixtureCache.
 *
 * Unit tests inject a fake `install`/`remove`; nothing here spawns the installer.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');

const {
  installRuntimeFixture,
  createRuntimeFixtureCache,
} = require('./helpers/install-shared.cjs');

function makeHarness() {
  const installCalls = [];
  const removed = [];
  let counter = 0;
  const harness = {
    installCalls,
    removed,
    install(opts) {
      installCalls.push(opts);
      counter += 1;
      return {
        root: `/tmp/fixture-${counter}`,
        configDir: `/tmp/fixture-${counter}/cfg`,
        manifest: { files: { 'a.md': 'h' } },
        stdout: '',
        stderr: '',
      };
    },
    remove(root) {
      removed.push(root);
    },
  };
  harness.cache = createRuntimeFixtureCache({
    install: harness.install,
    remove: harness.remove,
  });
  return harness;
}

test('installRuntimeFixture and createRuntimeFixtureCache are exported functions', () => {
  assert.strictEqual(typeof installRuntimeFixture, 'function');
  assert.strictEqual(typeof createRuntimeFixtureCache, 'function');
});

test('no call installs nothing and release is a no-op', () => {
  const h = makeHarness();
  assert.strictEqual(h.cache.size(), 0);
  h.cache.release();
  assert.strictEqual(h.installCalls.length, 0);
  assert.strictEqual(h.removed.length, 0);
  assert.strictEqual(h.cache.size(), 0);
});

test("first call installs once with the caller's options", () => {
  const h = makeHarness();
  const result = h.cache.get({ runtime: 'claude', scope: 'global' });
  assert.strictEqual(h.installCalls.length, 1);
  assert.deepStrictEqual(h.installCalls[0], {
    runtime: 'claude',
    scope: 'global',
    extraArgs: [],
    extraEnv: {},
  });
  assert.strictEqual(result.root, '/tmp/fixture-1');
  assert.strictEqual(h.cache.size(), 1);
});

test('a repeat call with the same key reuses the install', () => {
  const h = makeHarness();
  const first = h.cache.get({ runtime: 'claude', scope: 'global' });
  const second = h.cache.get({ runtime: 'claude', scope: 'global' });
  assert.strictEqual(h.installCalls.length, 1);
  assert.strictEqual(first, second);
});

test('a different runtime or scope gets its own install', () => {
  const h = makeHarness();
  const a = h.cache.get({ runtime: 'claude', scope: 'global' });
  const b = h.cache.get({ runtime: 'kilo', scope: 'global' });
  const c = h.cache.get({ runtime: 'claude', scope: 'local' });
  assert.strictEqual(h.installCalls.length, 3);
  assert.notStrictEqual(a, b);
  assert.notStrictEqual(a, c);
  assert.notStrictEqual(b, c);
  assert.strictEqual(h.cache.size(), 3);
});

test('extraArgs order is part of the key', () => {
  const h = makeHarness();
  const a = h.cache.get({ runtime: 'claude', scope: 'global', extraArgs: ['--x', '--y'] });
  const b = h.cache.get({ runtime: 'claude', scope: 'global', extraArgs: ['--y', '--x'] });
  assert.strictEqual(h.installCalls.length, 2);
  assert.notStrictEqual(a, b);
});

test('extraEnv key order does not split the cache', () => {
  const h = makeHarness();
  const a = h.cache.get({ runtime: 'claude', scope: 'global', extraEnv: { A: '1', B: '2' } });
  const b = h.cache.get({ runtime: 'claude', scope: 'global', extraEnv: { B: '2', A: '1' } });
  assert.strictEqual(h.installCalls.length, 1);
  assert.strictEqual(a, b);
});

test('omitted and empty extras share a key', () => {
  const h = makeHarness();
  const a = h.cache.get({ runtime: 'claude', scope: 'global' });
  const b = h.cache.get({ runtime: 'claude', scope: 'global', extraArgs: [], extraEnv: {} });
  assert.strictEqual(h.installCalls.length, 1);
  assert.strictEqual(a, b);
});

test('a caller-supplied root is rejected', () => {
  const h = makeHarness();
  assert.throws(
    () => h.cache.get({ runtime: 'claude', scope: 'global', root: '/tmp/mine' }),
    TypeError,
  );
  assert.strictEqual(h.installCalls.length, 0);
});

test('a failed install is not cached', () => {
  let calls = 0;
  const cache = createRuntimeFixtureCache({
    install() {
      calls += 1;
      if (calls === 1) throw new Error('installer exited with status 1');
      return {
        root: '/tmp/fixture-ok',
        configDir: '/tmp/fixture-ok/cfg',
        manifest: { files: {} },
        stdout: '',
        stderr: '',
      };
    },
    remove() {},
  });
  assert.throws(
    () => cache.get({ runtime: 'claude', scope: 'global' }),
    { message: 'installer exited with status 1' },
  );
  assert.strictEqual(cache.size(), 0);
  const result = cache.get({ runtime: 'claude', scope: 'global' });
  assert.strictEqual(calls, 2);
  assert.strictEqual(result.root, '/tmp/fixture-ok');
  assert.strictEqual(cache.size(), 1);
});

test('the shared result is deep-frozen', () => {
  const h = makeHarness();
  const result = h.cache.get({ runtime: 'claude', scope: 'global' });
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.manifest));
  assert.ok(Object.isFrozen(result.manifest.files));
  assert.throws(() => { result.root = '/tmp/other'; }, TypeError);
  assert.throws(() => { result.manifest = null; }, TypeError);
  assert.throws(() => { result.manifest.files['b.md'] = 'x'; }, TypeError);
});

test('release removes every cached root', () => {
  const h = makeHarness();
  h.cache.get({ runtime: 'claude', scope: 'global' });
  h.cache.get({ runtime: 'kilo', scope: 'global' });
  h.cache.release();
  assert.deepStrictEqual([...h.removed].sort(), ['/tmp/fixture-1', '/tmp/fixture-2']);
  assert.strictEqual(h.cache.size(), 0);
});

test('release keeps going when one removal fails', () => {
  const removed = [];
  let counter = 0;
  const cache = createRuntimeFixtureCache({
    install() {
      counter += 1;
      return {
        root: `/tmp/fixture-${counter}`,
        configDir: `/tmp/fixture-${counter}/cfg`,
        manifest: { files: {} },
        stdout: '',
        stderr: '',
      };
    },
    remove(root) {
      if (root === '/tmp/fixture-1') throw new Error('EBUSY');
      removed.push(root);
    },
  });
  cache.get({ runtime: 'claude', scope: 'global' });
  cache.get({ runtime: 'kilo', scope: 'global' });
  assert.doesNotThrow(() => cache.release());
  assert.deepStrictEqual(removed, ['/tmp/fixture-2']);
  assert.strictEqual(cache.size(), 0);
});

test('release empties the cache', () => {
  const h = makeHarness();
  const first = h.cache.get({ runtime: 'claude', scope: 'global' });
  h.cache.release();
  const second = h.cache.get({ runtime: 'claude', scope: 'global' });
  assert.strictEqual(h.installCalls.length, 2);
  assert.notStrictEqual(first, second);
});

test('runtime and scope must be non-empty strings', () => {
  const h = makeHarness();
  const bad = [
    {},
    { scope: 'global' },
    { runtime: 'claude' },
    { runtime: '', scope: 'global' },
    { runtime: 'claude', scope: '' },
    { runtime: 42, scope: 'global' },
    { runtime: 'claude', scope: 42 },
    { runtime: null, scope: 'global' },
    { runtime: 'claude', scope: null },
  ];
  for (const opts of bad) {
    assert.throws(() => h.cache.get(opts), TypeError);
  }
  assert.throws(() => h.cache.get(), TypeError);
  assert.strictEqual(h.installCalls.length, 0);
});

test('property: installs equal distinct keys', () => {
  const keyArb = fc.record({
    runtime: fc.constantFrom('claude', 'kilo', 'kimi'),
    scope: fc.constantFrom('global', 'local'),
    extraArgs: fc.array(fc.constantFrom('--x', '--y'), { maxLength: 2 }),
  });
  fc.assert(
    fc.property(fc.array(keyArb, { maxLength: 20 }), (keys) => {
      const h = makeHarness();
      const seen = new Map();
      for (const k of keys) {
        const result = h.cache.get({ ...k, extraArgs: [...k.extraArgs] });
        const id = JSON.stringify([k.runtime, k.scope, k.extraArgs]);
        if (seen.has(id)) {
          assert.strictEqual(result, seen.get(id));
        } else {
          seen.set(id, result);
        }
      }
      assert.strictEqual(h.installCalls.length, seen.size);
    }),
    { seed: 4688, numRuns: 200 },
  );
});
