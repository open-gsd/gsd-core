'use strict';

/**
 * #4696 — a type: tdd plan may run its RED gate and its GREEN/REFACTOR gates on different models.
 * The gate models are `model_overrides` entries named `<executor-type>:tdd-red` and
 * `<executor-type>:tdd-green-refactor`, resolved exactly the way execute-phase's split step resolves
 * them: `resolve-model "<type>:tdd-<gate>" --fallback-agent <type>`. There is no gate-specific resolver;
 * these tests pin the contract the workflow depends on.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { runGsdTools, createTempDir, cleanup, scrubConfigLocationEnv } = require('./helpers.cjs');
const { createHermeticRoot, setEnvForTest, withHome } = require('./helpers/isolated-env.cjs');

const EXECUTOR = 'gsd-executor';
const RED = (type) => `${type}:tdd-red`;
const GREEN = (type) => `${type}:tdd-green-refactor`;

function setup(t, config, runtime = 'claude') {
  const root = createHermeticRoot('tdd-gate-');
  t.after(() => cleanup(root));
  const home = createTempDir('tdd-gate-home-');
  t.after(() => cleanup(home));
  withHome(t, home);
  t.after(scrubConfigLocationEnv());
  setEnvForTest(t, { GSD_RUNTIME: runtime });
  fs.writeFileSync(path.join(root, '.planning', 'config.json'), JSON.stringify(config));
  return root;
}

/** The model the split step would use for one gate, via the exact call the step file runs. */
function gateModel(root, type, gateKey) {
  const r = runGsdTools(['resolve-model', gateKey, '--fallback-agent', type, '--raw'], root);
  assert.ok(r.success, r.error);
  return r.output.trim();
}

describe('#4696 gate-keyed model_overrides', () => {
  test('no gate keys: both gates resolve to the executor model, so no split', (t) => {
    const root = setup(t, { model_profile: 'balanced', model_overrides: { [EXECUTOR]: 'sonnet' } });
    assert.equal(gateModel(root, EXECUTOR, RED(EXECUTOR)), 'sonnet');
    assert.equal(gateModel(root, EXECUTOR, GREEN(EXECUTOR)), 'sonnet');
  });

  test('the red key wins for the RED gate and the green gate falls back to the executor', (t) => {
    const root = setup(t, { model_overrides: { [RED(EXECUTOR)]: 'opus', [EXECUTOR]: 'sonnet' } });
    assert.equal(gateModel(root, EXECUTOR, RED(EXECUTOR)), 'opus');
    assert.equal(gateModel(root, EXECUTOR, GREEN(EXECUTOR)), 'sonnet');
  });

  test('the green key alone leaves RED on the executor model', (t) => {
    const root = setup(t, { model_overrides: { [GREEN(EXECUTOR)]: 'haiku', [EXECUTOR]: 'opus' } });
    assert.equal(gateModel(root, EXECUTOR, RED(EXECUTOR)), 'opus');
    assert.equal(gateModel(root, EXECUTOR, GREEN(EXECUTOR)), 'haiku');
  });

  test('both keys set to different models resolve independently', (t) => {
    const root = setup(t, { model_overrides: { [RED(EXECUTOR)]: 'opus', [GREEN(EXECUTOR)]: 'haiku' } });
    assert.equal(gateModel(root, EXECUTOR, RED(EXECUTOR)), 'opus');
    assert.equal(gateModel(root, EXECUTOR, GREEN(EXECUTOR)), 'haiku');
  });

  test('both keys set to the same model resolve equal', (t) => {
    const root = setup(t, { model_overrides: { [RED(EXECUTOR)]: 'opus', [GREEN(EXECUTOR)]: 'opus' } });
    assert.equal(gateModel(root, EXECUTOR, RED(EXECUTOR)), gateModel(root, EXECUTOR, GREEN(EXECUTOR)));
  });

  test('a gate key beats the executor override for its own gate only', (t) => {
    const root = setup(t, { model_overrides: { [EXECUTOR]: 'haiku', [RED(EXECUTOR)]: 'opus' } });
    assert.equal(gateModel(root, EXECUTOR, RED(EXECUTOR)), 'opus');
    assert.equal(gateModel(root, EXECUTOR, GREEN(EXECUTOR)), 'haiku');
  });

  test('a specialist executor resolves its own gate keys and falls back to its own override', (t) => {
    const hinted = 'acme-rails-executor';
    const root = setup(t, {
      model_overrides: { [RED(hinted)]: 'opus', [hinted]: 'haiku', [EXECUTOR]: 'sonnet' },
    });
    assert.equal(gateModel(root, hinted, RED(hinted)), 'opus');
    assert.equal(gateModel(root, hinted, GREEN(hinted)), 'haiku');
  });

  test('a runtime-keyed gate entry resolves for the active runtime', (t) => {
    const config = { model_overrides: { [RED(EXECUTOR)]: { claude: 'opus', codex: 'gpt-6-astra' }, [EXECUTOR]: 'sonnet' } };
    assert.equal(gateModel(setup(t, config, 'claude'), EXECUTOR, RED(EXECUTOR)), 'opus');
    assert.equal(gateModel(setup(t, config, 'codex'), EXECUTOR, RED(EXECUTOR)), 'gpt-6-astra');
  });

  test('a runtime-keyed gate entry without the active runtime falls back to the executor', (t) => {
    const root = setup(t, { model_overrides: { [RED(EXECUTOR)]: { codex: 'gpt-6-astra' }, [EXECUTOR]: 'sonnet' } }, 'claude');
    assert.equal(gateModel(root, EXECUTOR, RED(EXECUTOR)), 'sonnet');
  });

  test('a gate entry that is not a model string falls back to the executor, never throws', (t) => {
    for (const bad of [5, ['opus'], null, true, {}]) {
      const root = setup(t, { model_overrides: { [RED(EXECUTOR)]: bad, [EXECUTOR]: 'sonnet' } });
      assert.equal(gateModel(root, EXECUTOR, RED(EXECUTOR)), 'sonnet', JSON.stringify(bad));
    }
  });

  test('an empty or whitespace-only gate entry falls back to the executor', (t) => {
    for (const bad of ['', '  ']) {
      const root = setup(t, { model_overrides: { [RED(EXECUTOR)]: bad, [EXECUTOR]: 'sonnet' } });
      assert.equal(gateModel(root, EXECUTOR, RED(EXECUTOR)), 'sonnet', JSON.stringify(bad));
    }
  });

  test('the gate key is case-sensitive', (t) => {
    const root = setup(t, { model_overrides: { 'GSD-EXECUTOR:TDD-RED': 'opus', [EXECUTOR]: 'sonnet' } });
    assert.equal(gateModel(root, EXECUTOR, RED(EXECUTOR)), 'sonnet');
  });

  test('a prototype-shaped executor type never resolves an inherited member', (t) => {
    const root = setup(t, { model_overrides: { [EXECUTOR]: 'sonnet' } });
    for (const type of ['__proto__', 'constructor', 'toString']) {
      assert.equal(gateModel(root, EXECUTOR, RED(type)), 'sonnet', type);
    }
  });

  test('two projects with different configs do not share gate models', (t) => {
    const a = setup(t, { model_overrides: { [RED(EXECUTOR)]: 'opus', [EXECUTOR]: 'sonnet' } });
    const b = setup(t, { model_overrides: { [EXECUTOR]: 'haiku' } });
    assert.equal(gateModel(a, EXECUTOR, RED(EXECUTOR)), 'opus');
    assert.equal(gateModel(b, EXECUTOR, RED(EXECUTOR)), 'haiku');
  });
});
