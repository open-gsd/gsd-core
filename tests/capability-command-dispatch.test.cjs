'use strict';

/**
 * capability-command-dispatch.test.cjs — unit tests for dispatchCapabilityCommand.
 *
 * ADR-959 phase 4d-impl-1.
 * Tests use synthetic registry + requireModule injections — no real bin/lib/ modules loaded.
 * Covers: happy path dispatch, unknown command fallback, empty/missing registry, prototype
 * pollution guard, router-not-a-function handling, module-load failure handling.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { dispatchCapabilityCommand } = require('../gsd-core/bin/gsd-tools.cjs');

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a synthetic registry with a single commandFamilies entry.
 */
function makeRegistry(families) {
  return { commandFamilies: families };
}

/**
 * Build a requireModule that returns a module with a named router function.
 * The router records its call ctx into `calls` array.
 */
function makeRequireModule(moduleName, routerName, calls) {
  return function requireModule(m) {
    if (m !== moduleName) throw new Error('unexpected module: ' + m);
    const mod = {};
    mod[routerName] = function (ctx) { calls.push(ctx); };
    return mod;
  };
}

// ─── 1. Happy path dispatch ───────────────────────────────────────────────────

describe('dispatchCapabilityCommand — happy path', () => {
  test('dispatches to the registered router and returns true', () => {
    const calls = [];
    const registry = makeRegistry({
      foo: { capId: 'x', module: 'fake.cjs', router: 'routeFoo' },
    });
    const requireModule = makeRequireModule('fake.cjs', 'routeFoo', calls);

    const result = dispatchCapabilityCommand({
      command: 'foo',
      args: ['bar', '--baz'],
      cwd: '/some/path',
      raw: false,
      error: () => {},
      registry,
      requireModule,
    });

    assert.strictEqual(result, true, 'dispatch should return true');
    assert.strictEqual(calls.length, 1, 'router should have been called once');
    assert.deepEqual(calls[0].args, ['bar', '--baz'], 'args forwarded');
    assert.strictEqual(calls[0].cwd, '/some/path', 'cwd forwarded');
    assert.strictEqual(calls[0].raw, false, 'raw forwarded');
    assert.strictEqual(typeof calls[0].error, 'function', 'error function forwarded');
  });

  test('returns true and dispatches when raw=true', () => {
    const calls = [];
    const registry = makeRegistry({
      myCmd: { capId: 'c1', module: 'mycmd.cjs', router: 'routeMyCmd' },
    });
    const requireModule = makeRequireModule('mycmd.cjs', 'routeMyCmd', calls);

    const result = dispatchCapabilityCommand({
      command: 'myCmd',
      args: [],
      cwd: '/proj',
      raw: true,
      error: () => {},
      registry,
      requireModule,
    });

    assert.strictEqual(result, true);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].raw, true);
  });
});

// ─── 2. Unknown command → returns false ──────────────────────────────────────

describe('dispatchCapabilityCommand — unknown command', () => {
  test('returns false when command not in registry', () => {
    const registry = makeRegistry({
      foo: { capId: 'x', module: 'fake.cjs', router: 'routeFoo' },
    });
    const requireModule = () => { throw new Error('should not load'); };

    const result = dispatchCapabilityCommand({
      command: 'nonexistent',
      args: [],
      cwd: '/p',
      raw: false,
      error: () => {},
      registry,
      requireModule,
    });

    assert.strictEqual(result, false);
  });

  test('returns false when commandFamilies is empty ({})', () => {
    const registry = makeRegistry({});
    const requireModule = () => { throw new Error('should not load'); };

    const result = dispatchCapabilityCommand({
      command: 'anything',
      args: [],
      cwd: '/p',
      raw: false,
      error: () => {},
      registry,
      requireModule,
    });

    assert.strictEqual(result, false);
  });
});

// ─── 3. Missing/empty registry → false, no throw ─────────────────────────────

describe('dispatchCapabilityCommand — missing/empty registry', () => {
  test('registry=null → false, no throw', () => {
    assert.doesNotThrow(() => {
      const result = dispatchCapabilityCommand({
        command: 'foo',
        args: [],
        cwd: '/p',
        raw: false,
        error: () => {},
        registry: null,
        requireModule: () => {},
      });
      assert.strictEqual(result, false);
    });
  });

  test('registry with no commandFamilies property → false, no throw', () => {
    assert.doesNotThrow(() => {
      const result = dispatchCapabilityCommand({
        command: 'foo',
        args: [],
        cwd: '/p',
        raw: false,
        error: () => {},
        registry: { version: '1' },
        requireModule: () => {},
      });
      assert.strictEqual(result, false);
    });
  });

  test('registry.commandFamilies=null → false, no throw', () => {
    assert.doesNotThrow(() => {
      const result = dispatchCapabilityCommand({
        command: 'foo',
        args: [],
        cwd: '/p',
        raw: false,
        error: () => {},
        registry: { commandFamilies: null },
        requireModule: () => {},
      });
      assert.strictEqual(result, false);
    });
  });
});

// ─── 4. Prototype pollution guard ────────────────────────────────────────────

describe('dispatchCapabilityCommand — prototype pollution guard', () => {
  test('__proto__ command → false, no pollution', () => {
    const result = dispatchCapabilityCommand({
      command: '__proto__',
      args: [],
      cwd: '/p',
      raw: false,
      error: () => {},
      registry: makeRegistry({}),
      requireModule: () => {},
    });
    assert.strictEqual(result, false, '__proto__ must return false');
  });

  test('constructor command → false, no pollution', () => {
    const result = dispatchCapabilityCommand({
      command: 'constructor',
      args: [],
      cwd: '/p',
      raw: false,
      error: () => {},
      registry: makeRegistry({}),
      requireModule: () => {},
    });
    assert.strictEqual(result, false, 'constructor must return false');
  });

  test('prototype command → false, no pollution', () => {
    const result = dispatchCapabilityCommand({
      command: 'prototype',
      args: [],
      cwd: '/p',
      raw: false,
      error: () => {},
      registry: makeRegistry({}),
      requireModule: () => {},
    });
    assert.strictEqual(result, false, 'prototype must return false');
  });
});

// ─── 5. Router not a function → handled, no throw ────────────────────────────

describe('dispatchCapabilityCommand — router not a function', () => {
  test('router export is missing → does not throw, returns true (consumed)', () => {
    const errors = [];
    const registry = makeRegistry({
      foo: { capId: 'x', module: 'fake.cjs', router: 'routeNotPresent' },
    });
    const requireModule = () => ({ somethingElse: 'not-a-function' });

    let result;
    assert.doesNotThrow(() => {
      result = dispatchCapabilityCommand({
        command: 'foo',
        args: [],
        cwd: '/p',
        raw: false,
        error: (msg) => errors.push(msg),
        registry,
        requireModule,
      });
    });
    // Per ADR-959 design: router-not-a-function is a consumed dispatch (returns true)
    // with a diagnostic error, so we don't fall through to "Unknown command"
    assert.strictEqual(result, true, 'consumed dispatch even when router is not a function');
    assert.ok(errors.length > 0, 'should emit a diagnostic error');
  });

  test('router export is null → does not throw', () => {
    const registry = makeRegistry({
      foo: { capId: 'x', module: 'fake.cjs', router: 'routeFoo' },
    });
    const requireModule = () => ({ routeFoo: null });

    assert.doesNotThrow(() => {
      dispatchCapabilityCommand({
        command: 'foo',
        args: [],
        cwd: '/p',
        raw: false,
        error: () => {},
        registry,
        requireModule,
      });
    });
  });
});

// ─── 6. Module load failure → handled, no uncaught throw ─────────────────────

describe('dispatchCapabilityCommand — module load failure', () => {
  test('requireModule throws → does not propagate, returns true (consumed)', () => {
    const errors = [];
    const registry = makeRegistry({
      foo: { capId: 'x', module: 'nonexistent.cjs', router: 'routeFoo' },
    });
    const requireModule = () => { throw new Error('MODULE_NOT_FOUND'); };

    let result;
    assert.doesNotThrow(() => {
      result = dispatchCapabilityCommand({
        command: 'foo',
        args: [],
        cwd: '/p',
        raw: false,
        error: (msg) => errors.push(msg),
        registry,
        requireModule,
      });
    });
    assert.strictEqual(result, true, 'module-load failure returns true (consumed)');
    assert.ok(errors.length > 0, 'should emit a diagnostic error');
  });
});

// ─── 7. Module confinement — default requireModule refuses out-of-lib paths ───

describe('dispatchCapabilityCommand — module confinement (default requireModule)', () => {
  test('entry.module "../../evil.cjs" does not escape bin/lib/ — returns true (consumed), no require', () => {
    // Bypasses the generator's validation by hand-crafting a registry entry.
    // The default requireModule must refuse the path and treat it as a load failure
    // (returns true = consumed, emits a diagnostic error) rather than require()ing it.
    const errors = [];
    const registry = makeRegistry({
      foo: { capId: 'x', module: '../../evil.cjs', router: 'routeFoo' },
    });

    // Use NO injected requireModule so the real default loader (with confinement check) runs.
    // But we cannot actually hit the real require() since the path wouldn't exist;
    // we verify the confinement check fires before any require by checking the error message.
    let result;
    assert.doesNotThrow(() => {
      result = dispatchCapabilityCommand({
        command: 'foo',
        args: [],
        cwd: '/p',
        raw: false,
        error: (msg) => errors.push(msg),
        registry,
        // requireModule NOT injected → real default loader runs
      });
    });

    // Confinement violation: treated as a load failure → consumed (true), diagnostic emitted
    assert.strictEqual(result, true, 'confinement violation must return true (consumed)');
    assert.ok(errors.length > 0, 'confinement violation must emit a diagnostic error');
    // The diagnostic must mention the module (not a generic node MODULE_NOT_FOUND)
    assert.ok(
      errors[0].includes('../../evil.cjs') || errors[0].includes('evil.cjs'),
      'diagnostic should reference the offending module; got: ' + errors[0],
    );
  });

  test('entry.module "../sibling.cjs" also refused by confinement check', () => {
    const errors = [];
    const registry = makeRegistry({
      bar: { capId: 'y', module: '../sibling.cjs', router: 'routeBar' },
    });

    let result;
    assert.doesNotThrow(() => {
      result = dispatchCapabilityCommand({
        command: 'bar',
        args: [],
        cwd: '/p',
        raw: false,
        error: (msg) => errors.push(msg),
        registry,
        // requireModule NOT injected → real default loader runs
      });
    });

    assert.strictEqual(result, true, 'confinement violation must return true (consumed)');
    assert.ok(errors.length > 0, 'confinement violation must emit a diagnostic error');
  });
});

// ─── 7b. FIX 1: bare .cjs basename validation (no extension → refused) ─────────

describe('dispatchCapabilityCommand — FIX 1: bare .cjs basename enforcement (default requireModule)', () => {
  test('entry.module "foo" (no .cjs) is refused by default requireModule — returns true (consumed), no require of foo.js', () => {
    // A hand-edited registry entry with module: "foo" (no extension) must be
    // rejected by the basename pattern check BEFORE any filesystem access.
    // The confinement test in section 7 verifies path-traversal; this verifies
    // the extension/basename invariant that prevents node resolving foo.js or
    // foo/index.js from inside bin/lib/.
    const errors = [];
    const registry = makeRegistry({
      foo: { capId: 'x', module: 'foo', router: 'routeFoo' },
    });

    let result;
    assert.doesNotThrow(() => {
      result = dispatchCapabilityCommand({
        command: 'foo',
        args: [],
        cwd: '/p',
        raw: false,
        error: (msg) => errors.push(msg),
        registry,
        // requireModule NOT injected → real default loader runs
      });
    });

    // Refused → consumed (true), diagnostic emitted
    assert.strictEqual(result, true, 'bare-module-no-cjs must return true (consumed)');
    assert.ok(errors.length > 0, 'must emit a diagnostic error');
    // Diagnostic must mention the offending module name
    assert.ok(
      errors[0].includes('foo'),
      'diagnostic should reference the offending module name; got: ' + errors[0],
    );
  });

  test('entry.module "foo.js" (wrong extension) is also refused', () => {
    const errors = [];
    const registry = makeRegistry({
      bar: { capId: 'y', module: 'foo.js', router: 'routeBar' },
    });

    let result;
    assert.doesNotThrow(() => {
      result = dispatchCapabilityCommand({
        command: 'bar',
        args: [],
        cwd: '/p',
        raw: false,
        error: (msg) => errors.push(msg),
        registry,
      });
    });

    assert.strictEqual(result, true, 'wrong-extension must return true (consumed)');
    assert.ok(errors.length > 0, 'must emit a diagnostic error');
  });
});

// ─── 7c. FIX 2: own-property guard on router export ───────────────────────────

describe('dispatchCapabilityCommand — FIX 2: own-property guard on router export', () => {
  test('entry.router "constructor" (inherited prototype property) is not invoked — treated as miss, returns true (consumed)', () => {
    // A registry entry with router: "constructor" must be refused by the own-
    // property guard. The module's own exports do NOT include "constructor" as
    // an own property, but Object.prototype does via the prototype chain.
    // Without the guard, mod["constructor"] would return Function (the Object
    // constructor) — typeof Function === 'function' — and it would be invoked.
    const errors = [];
    const registry = makeRegistry({
      foo: { capId: 'x', module: 'fake.cjs', router: 'constructor' },
    });
    // Injected module whose OWN exports do NOT include 'constructor'
    const requireModule = () => ({ someOwnProp: () => {} });

    let result;
    assert.doesNotThrow(() => {
      result = dispatchCapabilityCommand({
        command: 'foo',
        args: [],
        cwd: '/p',
        raw: false,
        error: (msg) => errors.push(msg),
        registry,
        requireModule,
      });
    });

    assert.strictEqual(result, true, 'inherited-constructor router must return true (consumed)');
    assert.ok(errors.length > 0, 'must emit a diagnostic error');
  });

  test('entry.router "toString" (inherited prototype method) is not invoked', () => {
    const errors = [];
    const registry = makeRegistry({
      bar: { capId: 'y', module: 'fake.cjs', router: 'toString' },
    });
    const requireModule = () => ({ realRouter: () => {} });

    let result;
    assert.doesNotThrow(() => {
      result = dispatchCapabilityCommand({
        command: 'bar',
        args: [],
        cwd: '/p',
        raw: false,
        error: (msg) => errors.push(msg),
        registry,
        requireModule,
      });
    });

    assert.strictEqual(result, true, 'inherited-toString router must return true (consumed)');
    assert.ok(errors.length > 0, 'must emit a diagnostic error');
  });

  test('entry.router that IS an own property is still dispatched normally', () => {
    // Regression: ensure the own-property guard does not break the happy path.
    const calls = [];
    const registry = makeRegistry({
      foo: { capId: 'x', module: 'fake.cjs', router: 'routeFoo' },
    });
    const requireModule = makeRequireModule('fake.cjs', 'routeFoo', calls);

    const result = dispatchCapabilityCommand({
      command: 'foo',
      args: [],
      cwd: '/p',
      raw: false,
      error: () => {},
      registry,
      requireModule,
    });

    assert.strictEqual(result, true, 'own-property router must still dispatch');
    assert.strictEqual(calls.length, 1, 'router must have been called');
  });
});

// ─── 8. Router throws — structured error handling ────────────────────────────

const { ExitError } = require('../gsd-core/bin/lib/cli-exit.cjs');

describe('dispatchCapabilityCommand — non-ExitError from router → structured error via error()', () => {
  test('router throws TypeError → injected error() called with attributed message, raw error does NOT propagate', () => {
    // A capability plug-in command's unexpected failure must surface as a
    // structured, attributed error (honoring --json-errors / SDK consumers),
    // not a raw stack trace bypassing the error formatter.
    const errorCalls = [];
    const registry = makeRegistry({
      foo: { capId: 'x', module: 'fake.cjs', router: 'routeFoo' },
    });
    const requireModule = () => ({
      routeFoo: () => { throw new TypeError('boom'); },
    });

    // Must NOT throw — the raw TypeError must be caught and routed through error()
    assert.doesNotThrow(() => {
      dispatchCapabilityCommand({
        command: 'foo',
        args: [],
        cwd: '/p',
        raw: false,
        error: (msg, reason) => { errorCalls.push({ msg, reason }); },
        registry,
        requireModule,
      });
    });

    assert.strictEqual(errorCalls.length, 1, 'error() should be called exactly once');
    const { msg, reason } = errorCalls[0];
    // Message must name the command, router, module, and original error message
    assert.ok(msg.includes('foo'), 'message must name the command; got: ' + msg);
    assert.ok(msg.includes('routeFoo'), 'message must name the router; got: ' + msg);
    assert.ok(msg.includes('fake.cjs'), 'message must name the module; got: ' + msg);
    assert.ok(msg.includes('boom'), 'message must include original error message; got: ' + msg);
    // Reason must be SDK_FAIL_FAST
    const { ERROR_REASON } = require('../gsd-core/bin/lib/core.cjs');
    assert.strictEqual(reason, ERROR_REASON.SDK_FAIL_FAST, 'reason must be SDK_FAIL_FAST');
  });

  test('router throws a generic Error → same structured attribution, does not propagate', () => {
    const errorCalls = [];
    const registry = makeRegistry({
      bar: { capId: 'y', module: 'bar.cjs', router: 'routeBar' },
    });
    const requireModule = () => ({
      routeBar: () => { throw new Error('unexpected failure'); },
    });

    assert.doesNotThrow(() => {
      dispatchCapabilityCommand({
        command: 'bar',
        args: [],
        cwd: '/p',
        raw: false,
        error: (msg, reason) => { errorCalls.push({ msg, reason }); },
        registry,
        requireModule,
      });
    });

    assert.strictEqual(errorCalls.length, 1, 'error() should be called exactly once');
    assert.ok(errorCalls[0].msg.includes('bar'), 'message must name the command');
    assert.ok(errorCalls[0].msg.includes('unexpected failure'), 'message must include original error');
  });

  test('router throws an ExitError → propagates unchanged, error() is NOT called', () => {
    // An ExitError comes from the router calling its own error() (intentional
    // structured exit). It must propagate untouched so message/code/json-mode
    // are preserved.
    const errorCalls = [];
    const thrown = new ExitError(1, 'intentional-exit');
    const registry = makeRegistry({
      foo: { capId: 'x', module: 'fake.cjs', router: 'routeFoo' },
    });
    const requireModule = () => ({
      routeFoo: () => { throw thrown; },
    });

    let caught;
    try {
      dispatchCapabilityCommand({
        command: 'foo',
        args: [],
        cwd: '/p',
        raw: false,
        error: (msg, reason) => { errorCalls.push({ msg, reason }); },
        registry,
        requireModule,
      });
    } catch (e) {
      caught = e;
    }

    // The exact ExitError must have been rethrown
    assert.strictEqual(caught, thrown, 'the original ExitError must propagate unchanged');
    // error() must NOT have been called
    assert.strictEqual(errorCalls.length, 0, 'error() must not be called when an ExitError propagates');
  });

  test('router returns normally → returns true, error() not called', () => {
    const errorCalls = [];
    const calls = [];
    const registry = makeRegistry({
      foo: { capId: 'x', module: 'fake.cjs', router: 'routeFoo' },
    });
    const requireModule = makeRequireModule('fake.cjs', 'routeFoo', calls);

    const result = dispatchCapabilityCommand({
      command: 'foo',
      args: ['a'],
      cwd: '/p',
      raw: false,
      error: (msg, reason) => { errorCalls.push({ msg, reason }); },
      registry,
      requireModule,
    });

    assert.strictEqual(result, true, 'successful dispatch must return true');
    assert.strictEqual(errorCalls.length, 0, 'error() must not be called on success');
    assert.strictEqual(calls.length, 1, 'router must have been called once');
  });
});

// ─── 10. Async router (thenable) → structured error ─────────────────────────

describe('dispatchCapabilityCommand — async router returns a Promise → structured error', () => {
  const { ERROR_REASON } = require('../gsd-core/bin/lib/core.cjs');

  test('router returns Promise.resolve() → error() called with "must be synchronous" + SDK_FAIL_FAST', () => {
    const errorCalls = [];
    const registry = makeRegistry({
      foo: { capId: 'x', module: 'fake.cjs', router: 'routeFoo' },
    });
    const requireModule = () => ({
      routeFoo: () => Promise.resolve(),
    });

    // Must NOT throw — the thenable check surfaces via error(), not an exception
    assert.doesNotThrow(() => {
      dispatchCapabilityCommand({
        command: 'foo',
        args: [],
        cwd: '/p',
        raw: false,
        error: (msg, reason) => { errorCalls.push({ msg, reason }); },
        registry,
        requireModule,
      });
    });

    assert.strictEqual(errorCalls.length, 1, 'error() should be called exactly once');
    const { msg, reason } = errorCalls[0];
    assert.ok(msg.includes('must be synchronous'), 'message must say "must be synchronous"; got: ' + msg);
    assert.ok(msg.includes('foo'), 'message must name the command; got: ' + msg);
    assert.ok(msg.includes('routeFoo'), 'message must name the router; got: ' + msg);
    assert.ok(msg.includes('fake.cjs'), 'message must name the module; got: ' + msg);
    assert.strictEqual(reason, ERROR_REASON.SDK_FAIL_FAST, 'reason must be SDK_FAIL_FAST');
  });

  test('router returns Promise.reject() → error() called with "must be synchronous", async rejection does NOT escape', () => {
    const errorCalls = [];
    const registry = makeRegistry({
      bar: { capId: 'y', module: 'bar.cjs', router: 'routeBar' },
    });
    // Attach .catch(()=>{}) immediately so the test process does not log an
    // unhandled-rejection warning for the returned (un-awaited) rejected Promise.
    const rejectedPromise = Promise.reject(new Error('async failure'));
    rejectedPromise.catch(() => {});
    const requireModule = () => ({
      routeBar: () => rejectedPromise,
    });

    assert.doesNotThrow(() => {
      dispatchCapabilityCommand({
        command: 'bar',
        args: [],
        cwd: '/p',
        raw: false,
        error: (msg, reason) => { errorCalls.push({ msg, reason }); },
        registry,
        requireModule,
      });
    });

    assert.strictEqual(errorCalls.length, 1, 'error() should be called exactly once');
    const { msg, reason } = errorCalls[0];
    assert.ok(msg.includes('must be synchronous'), 'message must say "must be synchronous"; got: ' + msg);
    assert.ok(msg.includes('bar'), 'message must name the command; got: ' + msg);
    assert.ok(msg.includes('routeBar'), 'message must name the router; got: ' + msg);
    assert.ok(msg.includes('bar.cjs'), 'message must name the module; got: ' + msg);
    assert.strictEqual(reason, ERROR_REASON.SDK_FAIL_FAST, 'reason must be SDK_FAIL_FAST');
  });

  test('sync router that returns undefined (normal) still dispatches without error', () => {
    // Regression: ensure the thenable guard does not fire on undefined return
    const errorCalls = [];
    const calls = [];
    const registry = makeRegistry({
      foo: { capId: 'x', module: 'fake.cjs', router: 'routeFoo' },
    });
    const requireModule = makeRequireModule('fake.cjs', 'routeFoo', calls);

    const result = dispatchCapabilityCommand({
      command: 'foo',
      args: [],
      cwd: '/p',
      raw: false,
      error: (msg, reason) => { errorCalls.push({ msg, reason }); },
      registry,
      requireModule,
    });

    assert.strictEqual(result, true, 'sync router must return true');
    assert.strictEqual(errorCalls.length, 0, 'error() must not be called for sync router');
    assert.strictEqual(calls.length, 1, 'router must have been called');
  });

  test('sync router that returns a non-thenable object does not trigger thenable guard', () => {
    // A router that returns a plain object (not a Promise) must not be rejected.
    const errorCalls = [];
    const registry = makeRegistry({
      foo: { capId: 'x', module: 'fake.cjs', router: 'routeFoo' },
    });
    const requireModule = () => ({
      routeFoo: () => ({ status: 'ok' }), // plain object, not thenable
    });

    const result = dispatchCapabilityCommand({
      command: 'foo',
      args: [],
      cwd: '/p',
      raw: false,
      error: (msg, reason) => { errorCalls.push({ msg, reason }); },
      registry,
      requireModule,
    });

    assert.strictEqual(result, true, 'sync router returning plain object must return true');
    assert.strictEqual(errorCalls.length, 0, 'error() must not be called');
  });
});

// ─── 9. Behavior-preservation: real registry has empty commandFamilies ────────

describe('dispatchCapabilityCommand — real registry behavior-preservation', () => {
  test('real capability-registry.cjs commandFamilies is {} (no capability declares commands)', () => {
    const realRegistry = require('../gsd-core/bin/lib/capability-registry.cjs');
    assert.ok(realRegistry.commandFamilies, 'commandFamilies must be exported');
    assert.deepEqual(
      Object.keys(realRegistry.commandFamilies),
      [],
      'real registry commandFamilies must be empty today',
    );
  });

  test('unknown command against real registry returns false (behavior-preserving)', () => {
    const realRegistry = require('../gsd-core/bin/lib/capability-registry.cjs');

    const result = dispatchCapabilityCommand({
      command: 'some-unknown-command-xyz',
      args: [],
      cwd: process.cwd(),
      raw: false,
      error: () => {},
      registry: realRegistry,
      requireModule: () => { throw new Error('should not load'); },
    });

    assert.strictEqual(result, false, 'unknown command against real registry must return false');
  });
});
