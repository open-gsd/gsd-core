'use strict';

/**
 * #4696 — a type: tdd plan may run its RED gate and its GREEN/REFACTOR gates on different models.
 * The gate models are `model_overrides` entries named `<executor-type>:tdd-red` and
 * `<executor-type>:tdd-green-refactor`. execute-phase's split step resolves each one with
 * `resolve-model "<key>" --fallback-agent gsd-executor` and reads the answer's `fallback_agent`: its
 * presence means the key set nothing, so that gate uses the routed executor's own model. There is no
 * gate-specific resolver; these tests pin the contract that step depends on.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { runGsdTools, createTempDir, cleanup, scrubConfigLocationEnv } = require('./helpers.cjs');
const { createHermeticRoot, withHome } = require('./helpers/isolated-env.cjs');

const EXECUTOR = 'gsd-executor';
const RED = (type) => `${type}:tdd-red`;
const GREEN = (type) => `${type}:tdd-green-refactor`;

// One home sandbox and one scrub per test context: a second scrub would restore the first scrub's cleared state.
const SANDBOXED = new WeakSet();

function setup(t, config) {
  const root = createHermeticRoot('tdd-gate-');
  t.after(() => cleanup(root));
  if (!SANDBOXED.has(t)) {
    SANDBOXED.add(t);
    const home = createTempDir('tdd-gate-home-');
    t.after(() => cleanup(home));
    withHome(t, home);
    t.after(scrubConfigLocationEnv());
  }
  fs.writeFileSync(path.join(root, '.planning', 'config.json'), JSON.stringify(config));
  return root;
}

/**
 * What the split step reads for one gate: the model the key sets, or null when the key set nothing
 * (the answer carries `fallback_agent`), exactly the call the step file runs. The active runtime
 * reaches the CLI the way a host sets it: GSD_RUNTIME in the call's environment, config.runtime absent.
 */
function gateModel(root, gateKey, runtime = 'claude') {
  const r = runGsdTools(['resolve-model', gateKey, '--fallback-agent', EXECUTOR], root, { GSD_RUNTIME: runtime });
  assert.ok(r.success, r.error);
  const answer = JSON.parse(r.output);
  return 'fallback_agent' in answer ? null : answer.model;
}

describe('#4696 gate-keyed model_overrides', () => {
  test('no gate keys: neither gate sets a model', (t) => {
    const root = setup(t, { model_profile: 'balanced', model_overrides: { [EXECUTOR]: 'sonnet' } });
    assert.equal(gateModel(root, RED(EXECUTOR)), null);
    assert.equal(gateModel(root, GREEN(EXECUTOR)), null);
  });

  test('the red key sets the RED gate only', (t) => {
    const root = setup(t, { model_overrides: { [RED(EXECUTOR)]: 'opus', [EXECUTOR]: 'sonnet' } });
    assert.equal(gateModel(root, RED(EXECUTOR)), 'opus');
    assert.equal(gateModel(root, GREEN(EXECUTOR)), null);
  });

  test('the green key sets the GREEN/REFACTOR gate only', (t) => {
    const root = setup(t, { model_overrides: { [GREEN(EXECUTOR)]: 'haiku', [EXECUTOR]: 'opus' } });
    assert.equal(gateModel(root, RED(EXECUTOR)), null);
    assert.equal(gateModel(root, GREEN(EXECUTOR)), 'haiku');
  });

  test('both keys resolve independently, equal or different', (t) => {
    const distinct = setup(t, { model_overrides: { [RED(EXECUTOR)]: 'opus', [GREEN(EXECUTOR)]: 'haiku' } });
    assert.equal(gateModel(distinct, RED(EXECUTOR)), 'opus');
    assert.equal(gateModel(distinct, GREEN(EXECUTOR)), 'haiku');
    const same = setup(t, { model_overrides: { [RED(EXECUTOR)]: 'opus', [GREEN(EXECUTOR)]: 'opus' } });
    assert.equal(gateModel(same, RED(EXECUTOR)), gateModel(same, GREEN(EXECUTOR)));
  });

  test('a gate key wins over the executor override for its own gate and leaves the other unset', (t) => {
    const root = setup(t, { model_overrides: { [EXECUTOR]: 'haiku', [RED(EXECUTOR)]: 'opus' } });
    assert.equal(gateModel(root, RED(EXECUTOR)), 'opus');
    assert.equal(gateModel(root, GREEN(EXECUTOR)), null);
  });

  test('a specialist executor has its own gate keys', (t) => {
    const hinted = 'acme-rails-executor';
    const root = setup(t, { model_overrides: { [RED(hinted)]: 'opus', [hinted]: 'haiku' } });
    assert.equal(gateModel(root, RED(hinted)), 'opus');
    assert.equal(gateModel(root, GREEN(hinted)), null);
  });

  test('a runtime-keyed gate entry resolves for the active runtime only', (t) => {
    const config = { model_overrides: { [RED(EXECUTOR)]: { claude: 'opus', codex: 'gpt-6-astra' } } };
    const root = setup(t, config);
    assert.equal(gateModel(root, RED(EXECUTOR), 'claude'), 'opus');
    assert.equal(gateModel(root, RED(EXECUTOR), 'codex'), 'gpt-6-astra');
    const other = setup(t, { model_overrides: { [RED(EXECUTOR)]: { codex: 'gpt-6-astra' } } });
    assert.equal(gateModel(other, RED(EXECUTOR), 'claude'), null);
  });

  test('an empty object entry sets nothing', (t) => {
    const root = setup(t, { model_overrides: { [RED(EXECUTOR)]: {} } });
    assert.equal(gateModel(root, RED(EXECUTOR)), null);
  });

  test('inherit is a real value for a gate', (t) => {
    const root = setup(t, { model_overrides: { [RED(EXECUTOR)]: 'inherit', [EXECUTOR]: 'sonnet' } });
    assert.equal(gateModel(root, RED(EXECUTOR)), 'inherit');
  });

  test('the gate key is case-sensitive', (t) => {
    const root = setup(t, { model_overrides: { 'GSD-EXECUTOR:TDD-RED': 'opus', [EXECUTOR]: 'sonnet' } });
    assert.equal(gateModel(root, RED(EXECUTOR)), null);
  });

  test('a prototype-shaped executor type never resolves an inherited member', (t) => {
    const root = setup(t, { model_overrides: { [EXECUTOR]: 'sonnet' } });
    for (const type of ['__proto__', 'constructor', 'toString']) {
      assert.equal(gateModel(root, RED(type)), null, type);
    }
  });

  test('two projects with different configs do not share gate models', (t) => {
    const a = setup(t, { model_overrides: { [RED(EXECUTOR)]: 'opus' } });
    const b = setup(t, { model_overrides: { [EXECUTOR]: 'haiku' } });
    assert.equal(gateModel(a, RED(EXECUTOR)), 'opus');
    assert.equal(gateModel(b, RED(EXECUTOR)), null);
  });
});
