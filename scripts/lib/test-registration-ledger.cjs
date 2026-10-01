'use strict';

// Registration ledger preload for scripts/run-tests.cjs (#4031).
//
// Why this exists. The runner passes `--test-force-exit` to every chunk (the
// Windows post-test hang backstop, #1051/#869). Under process isolation each
// test file's child streams its results to the `node --test` parent over a
// pipe, and a force-exit can end the parent while bytes of that pipe are still
// unread (nodejs/node#64833). The reporters never see the lost tail, so the
// run printed a smaller pass count and exited 0: a test that executed and
// passed (or failed) was indistinguishable from one that never existed.
//
// The parent cannot know what it did not receive, so the count of registered
// tests has to come from the child, over a channel that does not share the
// pipe: this module is loaded into each test-file child with `--require`
// (`--test` forwards it to the file children), counts every `test()` / `it()`
// registration made through `node:test`, and appends ONE line to the file named
// by GSD_RUN_TESTS_LEDGER_FILE when the child exits. The runner compares that
// per-file count with the leaf test results its ndjson reporter actually
// received (analyzeChunkAccounting in run-tests.cjs) and fails the chunk when
// registered > reported.
//
// The check is deliberately one-sided. Only module-level registrations are
// counted: a subtest created at run time through `t.test()` is not, so a
// reported total can exceed the registered one, never the reverse, absent a
// loss. A count that errs low can hide a loss; it cannot invent one.
//
// Inert unless it is inside a test-file child (NODE_TEST_CONTEXT is set by
// `node --test` for those, not for the runner parent) AND a ledger path was
// supplied, so requiring it anywhere else is a no-op. Never throws into the
// code it observes.

const fs = require('fs');
const path = require('path');
const Module = require('module');

const MODIFIERS = new Set(['skip', 'todo', 'only']);
// `describe`/`suite` register suites, not tests; the `it`/`test` calls inside
// their bodies go through the wrapped exports like any other.
const REGISTERING = new Set(['test', 'it']);

function install(ledgerPath) {
  let registered = 0;

  // Proxies are cached per target so `t.test === t.test` stays true for code
  // that compares or memoizes the functions it destructured.
  const cache = new WeakMap();
  const counted = (fn) => {
    let proxy = cache.get(fn);
    if (proxy === undefined) {
      proxy = new Proxy(fn, {
        apply(target, thisArg, args) {
          registered += 1;
          return Reflect.apply(target, thisArg, args);
        },
        get(target, prop) {
          const value = Reflect.get(target, prop);
          return typeof prop === 'string' && MODIFIERS.has(prop) && typeof value === 'function'
            ? counted(value)
            : value;
        },
      });
      cache.set(fn, proxy);
    }
    return proxy;
  };

  let wrappedExports = null;
  let wrappedOf = null;
  const wrapNodeTest = (real) => {
    if (wrappedOf === real) return wrappedExports;
    wrappedOf = real;
    // The module export is itself callable (`require('node:test')('name', fn)`).
    wrappedExports = new Proxy(real, {
      apply(target, thisArg, args) {
        registered += 1;
        return Reflect.apply(target, thisArg, args);
      },
      get(target, prop) {
        const value = Reflect.get(target, prop);
        if (typeof value !== 'function' || typeof prop !== 'string') return value;
        return REGISTERING.has(prop) || MODIFIERS.has(prop) ? counted(value) : value;
      },
    });
    return wrappedExports;
  };

  const originalLoad = Module._load;
  Module._load = function loadWithRegistrationCount(request) {
    const loaded = Reflect.apply(originalLoad, this, arguments);
    return request === 'node:test' && typeof loaded === 'function' ? wrapNodeTest(loaded) : loaded;
  };

  process.on('exit', () => {
    try {
      const file = process.argv[1] ? path.resolve(process.argv[1]) : null;
      fs.appendFileSync(ledgerPath, `${JSON.stringify({ type: 'registered', file, count: registered })}\n`);
    } catch {
      // Best-effort: the ledger is a diagnostic channel and must never change
      // the exit status of the test file it observes.
    }
  });
}

const ledgerPath = process.env.GSD_RUN_TESTS_LEDGER_FILE;
if (ledgerPath && process.env.NODE_TEST_CONTEXT) install(ledgerPath);

module.exports = { install };
