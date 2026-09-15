'use strict';

/**
 * Tests for #4669 — runtime-keyed per-agent `model_overrides`.
 *
 * `model_overrides.<agent>` may now be a runtime-keyed object as well as a
 * single model id. Two independent readers consume that key:
 *
 *   - dispatch: model-resolver.cjs (resolveModelInternal / resolveModelForTier
 *     / resolveTierFromConfig)
 *   - install:  install-model-override-resolver.cjs (resolveAgentModelOverride),
 *     which bakes a resolved id into agent frontmatter for the runtimes whose
 *     dispatch surface cannot carry an inline model
 *
 * Widening one and not the other would reintroduce exactly the divergence
 * install-model-override-resolver.cts was extracted to end, so the shape is
 * owned by ONE exported function — `selectAgentModelOverride` — and the parity
 * suite below fails if the two surfaces ever disagree about what a config means.
 *
 * Out of scope here, and deliberately: WHICH runtime each surface selects by.
 * Install passes the runtime being installed for; dispatch passes
 * `config['runtime']`, the statically-persisted field #4505 reports as the
 * wrong source on a machine running two runtimes. These tests pin the parser,
 * not that resolution — a test asserting dispatch picks the active runtime
 * would fail for a reason this change does not own.
 */

process.env.GSD_TEST_MODE = '1';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');

const {
  selectAgentModelOverride,
} = require('../gsd-core/bin/lib/model-resolver.cjs');
const {
  resolveAgentModelOverride,
} = require('../gsd-core/bin/lib/install-model-override-resolver.cjs');

describe('#4669 selectAgentModelOverride — the shared shape owner', () => {
  test('a string entry is returned for every runtime, exactly as before', () => {
    assert.strictEqual(selectAgentModelOverride('gpt-6-astra', 'codex'), 'gpt-6-astra');
    assert.strictEqual(selectAgentModelOverride('gpt-6-astra', 'claude'), 'gpt-6-astra');
    // A string answers even when the caller knows of no runtime at all — the
    // pre-#4669 contract, where the value was never runtime-dependent.
    assert.strictEqual(selectAgentModelOverride('gpt-6-astra', null), 'gpt-6-astra');
  });

  test('a runtime-keyed entry selects the named runtime', () => {
    const entry = { codex: 'gpt-6-astra', claude: 'opus' };
    assert.strictEqual(selectAgentModelOverride(entry, 'codex'), 'gpt-6-astra');
    assert.strictEqual(selectAgentModelOverride(entry, 'claude'), 'opus');
  });

  test('a runtime the entry does not name yields null, so the caller falls through to tier', () => {
    const entry = { codex: 'gpt-6-astra' };
    assert.strictEqual(selectAgentModelOverride(entry, 'claude'), null);
    // Enumerating every installed runtime is optional, not a precondition:
    // an unlisted runtime behaves as an agent with no override at all.
    assert.strictEqual(selectAgentModelOverride(entry, 'opencode'), null);
  });

  test('an object entry with no runtime to select by yields null rather than guessing', () => {
    assert.strictEqual(selectAgentModelOverride({ codex: 'gpt-6-astra' }, null), null);
    assert.strictEqual(selectAgentModelOverride({ codex: 'gpt-6-astra' }, undefined), null);
    assert.strictEqual(selectAgentModelOverride({ codex: 'gpt-6-astra' }, ''), null);
  });

  describe('negative space — inputs the selector must refuse', () => {
    test('a prototype-chain runtime name resolves to null, not an inherited member', () => {
      const entry = { codex: 'gpt-6-astra' };
      for (const hostile of ['toString', 'constructor', 'valueOf', 'hasOwnProperty', '__proto__']) {
        assert.strictEqual(selectAgentModelOverride(entry, hostile), null, `runtime "${hostile}" must not resolve`);
      }
    });

    test('an inherited STRING member is refused — the own-property guard, isolated', () => {
      // The case above passes with or without the guard, because every stock
      // Object.prototype member is a function and the string check already
      // rejects it. Only a string-valued inherited member separates the two, so
      // that is what this asserts: without Object.hasOwn, `entry` would appear
      // to carry an override for a runtime it never mentions.
      const entry = { codex: 'gpt-6-astra' };
      Object.prototype.claude = 'INHERITED-NOT-AN-OVERRIDE';
      try {
        assert.strictEqual(selectAgentModelOverride(entry, 'claude'), null);
        // The own key beside it still resolves, so the guard rejects inheritance
        // rather than the lookup as a whole.
        assert.strictEqual(selectAgentModelOverride(entry, 'codex'), 'gpt-6-astra');
      } finally {
        delete Object.prototype.claude;
      }
      assert.strictEqual(Object.prototype.claude, undefined, 'prototype must be restored');
    });

    test('non-string selected values are refused', () => {
      assert.strictEqual(selectAgentModelOverride({ codex: 42 }, 'codex'), null);
      assert.strictEqual(selectAgentModelOverride({ codex: null }, 'codex'), null);
      assert.strictEqual(selectAgentModelOverride({ codex: { model: 'x' } }, 'codex'), null);
      assert.strictEqual(selectAgentModelOverride({ codex: ['x'] }, 'codex'), null);
    });

    test('empty strings are absence, not an override', () => {
      // An empty model= is the #2517 failure this repo already fixed once; the
      // selector must never manufacture one.
      assert.strictEqual(selectAgentModelOverride('', 'codex'), null);
      assert.strictEqual(selectAgentModelOverride({ codex: '' }, 'codex'), null);
    });

    test('arrays and scalars are not runtime maps', () => {
      assert.strictEqual(selectAgentModelOverride(['gpt-6-astra'], 'codex'), null);
      assert.strictEqual(selectAgentModelOverride(42, 'codex'), null);
      assert.strictEqual(selectAgentModelOverride(true, 'codex'), null);
      assert.strictEqual(selectAgentModelOverride(null, 'codex'), null);
      assert.strictEqual(selectAgentModelOverride(undefined, 'codex'), null);
    });
  });

  test('property (fast-check): a selected value is always a non-empty string drawn from the entry', () => {
    const runtimeName = fc.constantFrom('codex', 'claude', 'opencode', 'kilo', 'antigravity');
    fc.assert(
      fc.property(
        fc.dictionary(runtimeName, fc.oneof(fc.string(), fc.integer(), fc.constant(null))),
        runtimeName,
        (entry, runtime) => {
          const selected = selectAgentModelOverride(entry, runtime);
          if (selected === null) return true;
          // Never invents a value, never returns a falsy one, and only ever
          // returns what the entry itself holds under that exact runtime key.
          return typeof selected === 'string'
            && selected.length > 0
            && Object.hasOwn(entry, runtime)
            && entry[runtime] === selected;
        },
      ),
      { numRuns: 300 },
    );
  });

  test('property (fast-check): a string entry is runtime-invariant', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }),
        fc.constantFrom('codex', 'claude', 'opencode', 'kilo'),
        fc.constantFrom('codex', 'claude', 'opencode', 'kilo'),
        (model, runtimeA, runtimeB) => selectAgentModelOverride(model, runtimeA)
          === selectAgentModelOverride(model, runtimeB),
      ),
      { numRuns: 200 },
    );
  });
});

describe('#4669 install-side resolveAgentModelOverride selects by the target runtime', () => {
  const OVERRIDES = {
    'gsd-planner': { codex: 'gpt-6-astra', claude: 'opus' },
    'gsd-verifier': 'gpt-5.6-sol',
    'gsd-debugger': { codex: 'gpt-6-astra' },
  };

  test('the target runtime wins over the statically-configured one', () => {
    // The resolver carries runtime "codex" (what .planning/config.json says)
    // while this install is staging agents for "claude". Before #4669 the
    // target was discarded and every host baked the same id.
    const runtimeResolver = { runtime: 'codex', resolve: () => null };
    assert.strictEqual(
      resolveAgentModelOverride('gsd-planner', OVERRIDES, runtimeResolver, 'claude'),
      'opus',
    );
    assert.strictEqual(
      resolveAgentModelOverride('gsd-planner', OVERRIDES, runtimeResolver, 'codex'),
      'gpt-6-astra',
    );
  });

  test('a flat string entry still resolves for any target runtime', () => {
    const runtimeResolver = { runtime: 'codex', resolve: () => null };
    for (const target of ['codex', 'claude', 'opencode', undefined]) {
      assert.strictEqual(
        resolveAgentModelOverride('gsd-verifier', OVERRIDES, runtimeResolver, target),
        'gpt-5.6-sol',
        `flat entry must resolve for target ${String(target)}`,
      );
    }
  });

  test('an unnamed target runtime falls through to the tier resolver, not to null', () => {
    // gsd-debugger names only codex. Staging for claude must behave exactly as
    // an agent with no override — step 2, not an omitted key.
    const runtimeResolver = { runtime: 'codex', resolve: () => ({ model: 'tier-model' }) };
    assert.strictEqual(
      resolveAgentModelOverride('gsd-debugger', OVERRIDES, runtimeResolver, 'claude'),
      'tier-model',
    );
    assert.strictEqual(
      resolveAgentModelOverride('gsd-debugger', OVERRIDES, runtimeResolver, 'codex'),
      'gpt-6-astra',
    );
  });

  test('omitting targetRuntime preserves the pre-#4669 call contract', () => {
    // Callers that predate the parameter fall back to the resolver's runtime,
    // which is the only runtime they ever had and the right answer when just
    // one is installed.
    const runtimeResolver = { runtime: 'codex', resolve: () => null };
    assert.strictEqual(
      resolveAgentModelOverride('gsd-planner', OVERRIDES, runtimeResolver),
      'gpt-6-astra',
    );
  });

  test('with neither a target nor a resolver runtime, an object entry omits the key', () => {
    assert.strictEqual(resolveAgentModelOverride('gsd-planner', OVERRIDES, null), null);
  });

  test('an agent named after an Object.prototype member is not an override', () => {
    const runtimeResolver = { runtime: 'codex', resolve: () => null };
    assert.strictEqual(resolveAgentModelOverride('toString', OVERRIDES, runtimeResolver, 'codex'), null);
    assert.strictEqual(resolveAgentModelOverride('constructor', OVERRIDES, runtimeResolver, 'codex'), null);
  });
});

describe('#4669 parity — install and dispatch read one config the same way', () => {
  // The mandated assertion: both surfaces route through selectAgentModelOverride,
  // so for any (entry, runtime) the install reader's step 1 must return exactly
  // what the dispatch reader's selector returns. A second hand-rolled parser on
  // either side fails this.
  const ENTRIES = [
    'gpt-6-astra',
    '',
    { codex: 'gpt-6-astra', claude: 'opus' },
    { codex: 'gpt-6-astra' },
    { claude: 'opus' },
    { codex: '' },
    { codex: 42 },
    {},
    [],
    null,
    undefined,
    7,
  ];
  const RUNTIMES = ['codex', 'claude', 'opencode', 'toString', '', null];

  test('every (entry, runtime) pair agrees across both readers', () => {
    let compared = 0;
    for (const entry of ENTRIES) {
      for (const runtime of RUNTIMES) {
        const viaDispatch = selectAgentModelOverride(entry, runtime);
        // No tier resolver, so the install reader can only return its step-1
        // answer or null — isolating the shared parser from tier fallback.
        const viaInstall = resolveAgentModelOverride('gsd-planner', { 'gsd-planner': entry }, null, runtime);
        assert.strictEqual(
          viaInstall,
          viaDispatch,
          `divergence for entry ${JSON.stringify(entry)} @ runtime ${JSON.stringify(runtime)}: `
          + `install=${JSON.stringify(viaInstall)} dispatch=${JSON.stringify(viaDispatch)}`,
        );
        compared += 1;
      }
    }
    // Guards against a refactor that empties the matrix and leaves a green
    // test asserting nothing (TESTING-STANDARDS contract 2).
    assert.strictEqual(compared, ENTRIES.length * RUNTIMES.length);
    assert.ok(compared >= 60, `expected a substantive matrix, compared ${compared}`);
  });

  test('property (fast-check): the two readers agree on arbitrary entries', () => {
    const runtimeName = fc.constantFrom('codex', 'claude', 'opencode', 'kilo');
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string(),
          fc.dictionary(runtimeName, fc.string()),
          fc.constant(null),
        ),
        runtimeName,
        (entry, runtime) => resolveAgentModelOverride('gsd-planner', { 'gsd-planner': entry }, null, runtime)
          === selectAgentModelOverride(entry, runtime),
      ),
      { numRuns: 300 },
    );
  });
});
