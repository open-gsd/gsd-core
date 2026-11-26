'use strict';

/**
 * #4669 — install-time readers of a runtime-keyed `model_overrides` entry, the per-runtime merge,
 * the Cline binding, and the parity assertion that the dispatch reader and the install reader can
 * never disagree about the same (entry, runtime) pair (triage constraint: two independent readers
 * of `model_overrides` existed, so widening one without the other reintroduces divergence).
 *
 * Dispatch-side selection is covered in model-overrides-runtime-key.test.cjs.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');
const fs = require('node:fs');
const path = require('node:path');

const { resolveModelOverride } = require('../gsd-core/bin/lib/model-resolver.cjs');
const {
  readGsdEffectiveModelOverrides,
  resolveAgentModelOverride,
} = require('../gsd-core/bin/lib/install-model-override-resolver.cjs');
const capabilityRegistry = require('../gsd-core/bin/lib/capability-registry.cjs');
const { canonicalizeRuntimeName } = require('../gsd-core/bin/lib/runtime-name-policy.cjs');
const { createTempDir, cleanup, scrubConfigLocationEnv } = require('./helpers.cjs');
const { createHermeticRoot, setEnvForTest, withHome } = require('./helpers/isolated-env.cjs');

const AGENT = 'gsd-planner';

// Runtimes the resolver itself recognises, so a name that canonicalizes to `claude` cannot masquerade.
const RUNTIMES = Object.keys(capabilityRegistry.runtimes)
  .filter((id) => canonicalizeRuntimeName(id) === id)
  .sort();

describe('#4669 install-time reader: resolveAgentModelOverride', () => {
  test('selects the object key for the runtime being installed', () => {
    const map = { [AGENT]: { codex: 'gpt-6-astra', opencode: 'oc-model' } };
    assert.equal(resolveAgentModelOverride(AGENT, map, null, 'opencode'), 'oc-model');
    assert.equal(resolveAgentModelOverride(AGENT, map, null, 'codex'), 'gpt-6-astra');
  });

  test('a string entry is returned whatever the target runtime, and without one', () => {
    const map = { [AGENT]: 'gpt-6-astra' };
    assert.equal(resolveAgentModelOverride(AGENT, map, null, 'opencode'), 'gpt-6-astra');
    assert.equal(resolveAgentModelOverride(AGENT, map, null, undefined), 'gpt-6-astra');
    assert.equal(resolveAgentModelOverride(AGENT, map, null), 'gpt-6-astra');
  });

  test('an object entry with no runtime to select by and no resolver does not guess', () => {
    const map = { [AGENT]: { codex: 'gpt-6-astra' } };
    assert.equal(resolveAgentModelOverride(AGENT, map, null), null);
    assert.equal(resolveAgentModelOverride(AGENT, map, undefined, undefined), null);
  });

  test('the profile resolver\'s raw config runtime is never a fallback for selection', () => {
    const resolver = { runtime: 'codex', resolve: () => ({ model: 'tier-model' }) };
    const map = { [AGENT]: { codex: 'gpt-6-astra' } };
    // No target runtime: the object entry selects nothing, so the tier resolver answers.
    assert.equal(resolveAgentModelOverride(AGENT, map, resolver), 'tier-model');
  });

  test('the target runtime selects whatever the profile resolver\'s runtime says', () => {
    const resolver = { runtime: 'codex', resolve: () => null };
    const map = { [AGENT]: { codex: 'gpt-6-astra', opencode: 'oc-model' } };
    assert.equal(resolveAgentModelOverride(AGENT, map, resolver, 'opencode'), 'oc-model');
  });

  test('an object entry without the target key falls through to the tier resolver, then omit', () => {
    const map = { [AGENT]: { codex: 'gpt-6-astra' } };
    const tier = { runtime: 'opencode', resolve: () => ({ model: 'tier-model' }) };
    assert.equal(resolveAgentModelOverride(AGENT, map, tier, 'opencode'), 'tier-model');
    const none = { runtime: 'opencode', resolve: () => null };
    assert.equal(resolveAgentModelOverride(AGENT, map, none, 'opencode'), null);
  });

  test('an unusable value for the target key falls through', () => {
    for (const value of ['', 5, null, {}, []]) {
      const map = { [AGENT]: { opencode: value } };
      assert.equal(resolveAgentModelOverride(AGENT, map, null, 'opencode'), null, JSON.stringify(value));
    }
  });

  test('a prototype-named agent or runtime never selects an inherited member', () => {
    assert.equal(resolveAgentModelOverride('toString', {}, null, 'opencode'), null);
    assert.equal(resolveAgentModelOverride(AGENT, { [AGENT]: { codex: 'x' } }, null, 'constructor'), null);
  });
});

describe('#4669 per-runtime merge of the global and project files', () => {
  /** Write the global defaults and project config for real, then read them the way install does. */
  function effective(t, globalOverrides, projectOverrides) {
    const home = createTempDir('mo-merge-home-');
    t.after(() => cleanup(home));
    withHome(t, home);
    t.after(scrubConfigLocationEnv());
    const root = createHermeticRoot('mo-merge-');
    t.after(() => cleanup(root));
    if (globalOverrides !== undefined) {
      fs.mkdirSync(path.join(home, '.gsd'), { recursive: true });
      fs.writeFileSync(path.join(home, '.gsd', 'defaults.json'),
        JSON.stringify({ model_overrides: globalOverrides }));
    }
    if (projectOverrides !== undefined) {
      fs.writeFileSync(path.join(root, '.planning', 'config.json'),
        JSON.stringify({ model_overrides: projectOverrides }));
    }
    return readGsdEffectiveModelOverrides(root, { homedir: () => home });
  }

  test('a project object replaces a global string', (t) => {
    const merged = effective(t, { [AGENT]: 'opus' }, { [AGENT]: { codex: 'gpt-6-astra' } });
    assert.deepEqual(merged[AGENT], { codex: 'gpt-6-astra' });
  });

  test('a project string replaces a global object', (t) => {
    const merged = effective(t, { [AGENT]: { codex: 'a', claude: 'b' } }, { [AGENT]: 'opus' });
    assert.equal(merged[AGENT], 'opus');
  });

  test('two objects merge per runtime key, the project winning a conflict', (t) => {
    const merged = effective(t,
      { [AGENT]: { claude: 'opus', codex: 'global-codex' } },
      { [AGENT]: { codex: 'project-codex' } });
    assert.deepEqual(merged[AGENT], { claude: 'opus', codex: 'project-codex' });
  });

  test('the merged entry feeds the install reader unchanged', (t) => {
    const merged = effective(t,
      { [AGENT]: { claude: 'opus' } },
      { [AGENT]: { opencode: 'oc-model' } });
    assert.equal(resolveAgentModelOverride(AGENT, merged, null, 'opencode'), 'oc-model');
    assert.equal(resolveAgentModelOverride(AGENT, merged, null, 'claude'), 'opus');
  });
});

describe('#4669 parity: the dispatch reader and the install reader agree', () => {
  /** Run one (entry, runtime) pair through both readers; both must give the same answer. */
  function both(t, entry, runtime) {
    setEnvForTest(t, { GSD_RUNTIME: runtime });
    const dispatched = resolveModelOverride({ model_overrides: { [AGENT]: entry } }, AGENT);
    const installed = resolveAgentModelOverride(AGENT, { [AGENT]: entry }, null, runtime);
    return { dispatched: dispatched ?? null, installed: installed ?? null };
  }

  /** Values the claude mapping leaves untouched, so the comparison is about selection alone. */
  function shapes(runtime) {
    const other = RUNTIMES.find((id) => id !== runtime);
    return [
      'm-string',
      { [runtime]: 'm-keyed' },
      { [other]: 'm-other' },
      { [runtime]: 'm-keyed', [other]: 'm-other' },
      { [runtime]: '' },
      { [runtime]: 5 },
      { [runtime]: null },
      { [runtime]: {} },
      {},
      ['x'],
      5,
      '',
    ];
  }

  test('every entry shape across every recognised runtime gives identical answers', (t) => {
    assert.ok(RUNTIMES.includes('opencode') && RUNTIMES.includes('kilo') && RUNTIMES.includes('codex'),
      'the install-baked runtimes must be among the recognised ones, or this test proves nothing about them');
    for (const runtime of RUNTIMES) {
      for (const entry of shapes(runtime)) {
        const { dispatched, installed } = both(t, entry, runtime);
        assert.deepEqual(dispatched, installed,
          `diverged for ${JSON.stringify(entry)} on ${runtime}`);
      }
    }
  });

  test('a seeded property over arbitrary entries never diverges', (t) => {
    const value = fc.oneof(
      fc.string({ maxLength: 6 }).map((s) => `m-${s}`),
      fc.constant(''),
      fc.integer(),
      fc.constant(null),
    );
    const entry = fc.oneof(
      fc.constant(undefined),
      fc.constant(null),
      value,
      fc.array(fc.string({ maxLength: 3 }), { maxLength: 2 }),
      fc.dictionary(fc.constantFrom(...RUNTIMES, 'other'), value, { maxKeys: 4 }),
    );
    fc.assert(
      fc.property(entry, fc.constantFrom(...RUNTIMES), (e, runtime) => {
        const { dispatched, installed } = both(t, e, runtime);
        assert.deepEqual(dispatched, installed);
      }),
      { seed: 4669, numRuns: 300 },
    );
  });
});
