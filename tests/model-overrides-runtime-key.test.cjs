'use strict';

/**
 * #4669 — `model_overrides.<agent>` accepts a runtime-keyed object
 * (`{ "codex": "gpt-6-astra", "claude": "opus" }`) in addition to the string form.
 *
 * Dispatch-time seams, driven through a real temp `.planning/config.json`. The runtime comes from
 * `GSD_RUNTIME` with `config.runtime` ABSENT, which is how a real host reaches the resolver; a test
 * that wrote the runtime into the config would pass for an install where it is never written (#4505).
 *
 * The install-time readers, the merge, the Cline binding and the dispatch/install parity assertion
 * live in model-overrides-runtime-key-install.test.cjs.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  resolveModelInternal,
  resolveTierInternal,
  resolveModelForTier,
  resolveModelOverride,
  selectAgentModelOverride,
} = require('../gsd-core/bin/lib/model-resolver.cjs');
const { createTempDir, cleanup, scrubConfigLocationEnv, runGsdTools } = require('./helpers.cjs');
const { createHermeticRoot, setEnvForTest, withHome } = require('./helpers/isolated-env.cjs');

const AGENT = 'gsd-planner';
const LIGHT_AGENT = 'gsd-codebase-mapper';

/** A hermetic project plus a sandboxed home, with the active runtime set the way hosts set it. */
const SANDBOXED = new WeakSet();

function setup(t, config, runtime) {
  const root = createHermeticRoot('mo-rt-');
  t.after(() => cleanup(root));
  // One sandbox per test context: a second scrub would restore the first scrub's cleared state.
  if (!SANDBOXED.has(t)) {
    SANDBOXED.add(t);
    const home = createTempDir('mo-rt-home-');
    t.after(() => cleanup(home));
    withHome(t, home);
    t.after(scrubConfigLocationEnv());
  }
  setEnvForTest(t, { GSD_RUNTIME: runtime });
  fs.writeFileSync(path.join(root, '.planning', 'config.json'), JSON.stringify(config));
  return root;
}

/** The same config with the agent's entry removed: what "as if it had no override" must equal. */
function withoutEntry(config, agent) {
  const overrides = { ...(config.model_overrides || {}) };
  delete overrides[agent];
  return { ...config, model_overrides: overrides };
}

const TWO_RUNTIMES = { claude: 'opus', codex: 'gpt-6-astra' };

describe('#4669 string entries are unchanged', () => {
  test('a string entry resolves unchanged on claude', (t) => {
    const root = setup(t, { model_overrides: { [AGENT]: 'opus' } }, 'claude');
    assert.equal(resolveModelInternal(root, AGENT), 'opus');
  });

  test('a string entry is runtime-invariant (same value on codex and claude)', (t) => {
    const config = { model_overrides: { [AGENT]: 'gpt-6-astra' } };
    assert.equal(resolveModelInternal(setup(t, config, 'claude'), AGENT), 'gpt-6-astra');
    assert.equal(resolveModelInternal(setup(t, config, 'codex'), AGENT), 'gpt-6-astra');
  });

  test('absent, null and empty model_overrides are no-ops', (t) => {
    const bare = resolveModelInternal(setup(t, {}, 'claude'), AGENT);
    assert.equal(resolveModelInternal(setup(t, { model_overrides: null }, 'claude'), AGENT), bare);
    assert.equal(resolveModelInternal(setup(t, { model_overrides: {} }, 'claude'), AGENT), bare);
  });
});

describe('#4669 a runtime-keyed entry selects by the active runtime', () => {
  test('selects the claude key on claude', (t) => {
    const root = setup(t, { model_overrides: { [AGENT]: TWO_RUNTIMES } }, 'claude');
    assert.equal(resolveModelInternal(root, AGENT), 'opus');
  });

  test('selects the codex key on codex', (t) => {
    const root = setup(t, { model_overrides: { [AGENT]: TWO_RUNTIMES } }, 'codex');
    assert.equal(resolveModelInternal(root, AGENT), 'gpt-6-astra');
  });

  test('the active runtime beats a raw config.runtime that names the other host', (t) => {
    const root = setup(t, { runtime: 'claude', model_overrides: { [AGENT]: TWO_RUNTIMES } }, 'codex');
    assert.equal(resolveModelInternal(root, AGENT), 'gpt-6-astra');
  });

  test('selection follows config.runtime when GSD_RUNTIME is unset', (t) => {
    const root = setup(t, { runtime: 'codex', model_overrides: { [AGENT]: TWO_RUNTIMES } }, undefined);
    assert.equal(resolveModelInternal(root, AGENT), 'gpt-6-astra');
  });

  test('a selected full Claude id maps exactly like the string form does', (t) => {
    const asString = resolveModelInternal(
      setup(t, { model_overrides: { [AGENT]: 'claude-opus-4-8' } }, 'claude'), AGENT);
    const asObject = resolveModelInternal(
      setup(t, { model_overrides: { [AGENT]: { claude: 'claude-opus-4-8' } } }, 'claude'), AGENT);
    assert.equal(asObject, asString);
  });

  test('an agent id with Unicode and spaces selects normally', (t) => {
    const agent = 'gsd-ünï cödé agent';
    const root = setup(t, { model_overrides: { [agent]: TWO_RUNTIMES } }, 'codex');
    assert.equal(resolveModelInternal(root, agent), 'gpt-6-astra');
  });

  test('a CRLF config file selects the same value', (t) => {
    const root = setup(t, {}, 'codex');
    const text = JSON.stringify({ model_overrides: { [AGENT]: TWO_RUNTIMES } }, null, 2).replace(/\n/g, '\r\n');
    fs.writeFileSync(path.join(root, '.planning', 'config.json'), text);
    assert.equal(resolveModelInternal(root, AGENT), 'gpt-6-astra');
  });
});

describe('#4669 a runtime-keyed entry with nothing for the active runtime falls through', () => {
  test('no key for the active runtime resolves as if the agent had no entry', (t) => {
    const config = { model_overrides: { [AGENT]: { codex: 'gpt-6-astra' } } };
    const root = setup(t, config, 'claude');
    const bare = setup(t, withoutEntry(config, AGENT), 'claude');
    assert.equal(resolveModelInternal(root, AGENT), resolveModelInternal(bare, AGENT));
    assert.notEqual(resolveModelInternal(root, AGENT), 'gpt-6-astra');
  });

  test('a claude-only pin does not leak to codex', (t) => {
    const config = { model_overrides: { [AGENT]: { claude: 'fable' } } };
    const root = setup(t, config, 'codex');
    const bare = setup(t, withoutEntry(config, AGENT), 'codex');
    assert.equal(resolveModelInternal(root, AGENT), resolveModelInternal(bare, AGENT));
    assert.notEqual(resolveModelInternal(root, AGENT), 'fable');
  });

  for (const [label, value] of [
    ['an empty string', ''],
    ['a number', 5],
    ['null', null],
    ['an empty object', {}],
    ['an array', []],
    ['a nested runtime object', { model: 'opus' }],
  ]) {
    test(`an unusable value for the active key (${label}) falls through without throwing`, (t) => {
      const config = { model_overrides: { [AGENT]: { claude: value } } };
      const root = setup(t, config, 'claude');
      const bare = setup(t, withoutEntry(config, AGENT), 'claude');
      assert.equal(resolveModelInternal(root, AGENT), resolveModelInternal(bare, AGENT));
    });
  }
});

describe('#4669 hostile keys', () => {
  test('inherited members are never selected as a runtime key', () => {
    for (const runtime of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) {
      assert.equal(selectAgentModelOverride({}, runtime), undefined, runtime);
      assert.equal(selectAgentModelOverride({ claude: 'opus' }, runtime), undefined, runtime);
    }
  });

  test('a prototype-named agent is not an override, whatever the map holds', (t) => {
    const config = { model_overrides: { [AGENT]: TWO_RUNTIMES } };
    const root = setup(t, config, 'claude');
    const bare = setup(t, {}, 'claude');
    for (const agent of ['toString', 'constructor', '__proto__']) {
      assert.equal(resolveModelInternal(root, agent), resolveModelInternal(bare, agent), agent);
      assert.equal(resolveModelOverride({ model_overrides: {} }, agent), null, agent);
    }
  });

  test('a null or missing runtime selects nothing from an object entry', () => {
    assert.equal(selectAgentModelOverride(TWO_RUNTIMES, null), undefined);
    assert.equal(selectAgentModelOverride(TWO_RUNTIMES, undefined), undefined);
    assert.equal(selectAgentModelOverride(TWO_RUNTIMES, ''), undefined);
  });
});

describe('#4669 junk that is not a runtime-keyed object keeps its legacy behavior', () => {
  test('array and number entries pass through resolveModelOverride untouched', (t) => {
    setEnvForTest(t, { GSD_RUNTIME: 'claude' });
    const list = ['x'];
    assert.equal(resolveModelOverride({ model_overrides: { [AGENT]: list } }, AGENT), list);
    assert.equal(resolveModelOverride({ model_overrides: { [AGENT]: 5 } }, AGENT), 5);
  });

  test('selectAgentModelOverride returns every non-object value unchanged', () => {
    const list = ['x'];
    assert.equal(selectAgentModelOverride('opus', 'claude'), 'opus');
    assert.equal(selectAgentModelOverride('', 'claude'), '');
    assert.equal(selectAgentModelOverride(5, 'claude'), 5);
    assert.equal(selectAgentModelOverride(list, 'claude'), list);
    assert.equal(selectAgentModelOverride(null, 'claude'), null);
    assert.equal(selectAgentModelOverride(undefined, 'claude'), undefined);
  });
});

describe('#4669 the tier report and the escalation reader follow the same selection', () => {
  test('resolveTierInternal reports the tier of the selected value', (t) => {
    const asString = resolveTierInternal(
      setup(t, { model_overrides: { [AGENT]: 'opus' } }, 'claude'), AGENT);
    const asObject = resolveTierInternal(
      setup(t, { model_overrides: { [AGENT]: TWO_RUNTIMES } }, 'claude'), AGENT);
    assert.equal(asObject, asString);
    assert.equal(asObject, 'opus');
  });

  test('resolveTierInternal falls through when the entry names only another runtime', (t) => {
    const config = { model_overrides: { [AGENT]: { codex: 'gpt-6-astra' } } };
    const root = setup(t, config, 'claude');
    const bare = setup(t, withoutEntry(config, AGENT), 'claude');
    assert.equal(resolveTierInternal(root, AGENT), resolveTierInternal(bare, AGENT));
  });

  test('resolveModelForTier honours a selected entry on an escalated attempt', (t) => {
    const routing = {
      enabled: true,
      tier_models: { light: 'haiku', standard: 'sonnet', heavy: 'opus' },
      escalate_on_failure: true,
      max_escalations: 1,
    };
    const pinned = setup(t, {
      model_profile: 'balanced',
      dynamic_routing: routing,
      model_overrides: { [LIGHT_AGENT]: { claude: 'haiku', codex: 'gpt-6-astra' } },
    }, 'claude');
    assert.equal(resolveModelForTier(pinned, LIGHT_AGENT, 1), 'haiku', 'the override beats the escalated tier');
  });

  test('resolveModelForTier escalates normally when the entry names only another runtime', (t) => {
    const config = {
      model_profile: 'balanced',
      dynamic_routing: {
        enabled: true,
        tier_models: { light: 'haiku', standard: 'sonnet', heavy: 'opus' },
        escalate_on_failure: true,
        max_escalations: 1,
      },
      model_overrides: { [LIGHT_AGENT]: { codex: 'gpt-6-astra' } },
    };
    const root = setup(t, config, 'claude');
    assert.equal(resolveModelForTier(root, LIGHT_AGENT, 1), 'sonnet');
  });

  test('resolveModelOverride agrees with resolveModelInternal about whether an object entry applies', (t) => {
    setEnvForTest(t, { GSD_RUNTIME: 'claude' });
    const applies = { model_overrides: { [AGENT]: TWO_RUNTIMES } };
    const skips = { model_overrides: { [AGENT]: { codex: 'gpt-6-astra' } } };
    assert.equal(resolveModelOverride(applies, AGENT), 'opus');
    assert.equal(resolveModelOverride(skips, AGENT), null);
  });
});

describe('#4669 the CLI persists and resolves the object form', () => {
  test('config-set stores a JSON object entry and resolve-model answers per runtime', (t) => {
    const root = setup(t, {}, 'codex');
    const set = runGsdTools(
      ['config-set', `model_overrides.${AGENT}`, JSON.stringify(TWO_RUNTIMES)], root);
    assert.ok(set.success, `config-set failed: ${set.error}`);
    const stored = JSON.parse(fs.readFileSync(path.join(root, '.planning', 'config.json'), 'utf8'));
    assert.deepEqual(stored.model_overrides[AGENT], TWO_RUNTIMES);
    assert.equal(resolveModelInternal(root, AGENT), 'gpt-6-astra');
    setEnvForTest(t, { GSD_RUNTIME: 'claude' });
    assert.equal(resolveModelInternal(root, AGENT), 'opus');
  });
});
