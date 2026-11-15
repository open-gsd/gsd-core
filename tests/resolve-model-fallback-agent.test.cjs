'use strict';

/**
 * #6213: `resolve-model <agent> --fallback-agent <role>` resolves a hinted executor that has no
 * `model_overrides` entry and no catalog tier as the fallback role (gsd-executor), instead of the
 * generic profile alias `resolveModelInternal` returns for an unknown agent.
 */

process.env.GSD_TEST_MODE = '1';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { runGsdTools, createTempProject, homeSandboxEnv, cleanup } = require('./helpers.cjs');

const HINTED = 'acme-rails-executor';

describe('#6213 resolve-model --fallback-agent', () => {
  let root;
  before(() => { root = createTempProject('gsd-resolve-model-fallback-'); });
  after(() => { cleanup(root); });

  function setConfig(config) {
    fs.writeFileSync(path.join(root, '.planning', 'config.json'), JSON.stringify(config));
  }

  function resolveModel(...args) {
    const r = runGsdTools(['resolve-model', ...args], root, homeSandboxEnv(root));
    assert.ok(r.success, r.error);
    return r.output;
  }

  function resolveJson(...args) {
    return JSON.parse(resolveModel(...args));
  }

  test('an uncatalogued hint resolves as gsd-executor under every profile', () => {
    for (const profile of ['quality', 'balanced', 'budget']) {
      setConfig({ model_profile: profile });
      const expected = resolveJson('gsd-executor');
      const got = resolveJson(HINTED, '--fallback-agent', 'gsd-executor');
      assert.strictEqual(got.model, expected.model, `${profile} model`);
      assert.strictEqual(got.effort, resolveJson(HINTED).effort, `${profile} effort is the hinted agent's own`);
      assert.strictEqual(got.tier, expected.tier, `${profile} tier`);
      assert.strictEqual(got.fallback_agent, 'gsd-executor', `${profile} fallback_agent`);
      assert.ok(!('unknown_agent' in got), `${profile} resolved as a known role`);
    }
  });

  test('the flag may precede the positional agent', () => {
    setConfig({ model_profile: 'quality' });
    const expected = resolveJson('gsd-executor');
    assert.strictEqual(resolveJson('--fallback-agent', 'gsd-executor', HINTED).model, expected.model);
  });

  test('a stray second positional is a usage error; a flag value is not a positional', () => {
    setConfig({ model_profile: 'quality' });
    const bad = runGsdTools(['resolve-model', 'gsd-executor', 'extra'], root, homeSandboxEnv(root));
    assert.strictEqual(bad.success, false, 'a second positional word is rejected');
    assert.match(bad.error, /resolve-model takes one agent type/);
    const ok = runGsdTools(['resolve-model', '--fallback-agent', 'gsd-executor', 'acme-x'], root, homeSandboxEnv(root));
    assert.ok(ok.success, ok.error);
    assert.strictEqual(JSON.parse(ok.output).fallback_agent, 'gsd-executor');
  });

  test('a model_overrides entry for the hint wins over the fallback', () => {
    setConfig({ model_profile: 'quality', model_overrides: { [HINTED]: 'haiku' } });
    const got = resolveJson(HINTED, '--fallback-agent', 'gsd-executor');
    assert.strictEqual(got.model, 'haiku');
    assert.ok(!('fallback_agent' in got), 'override means the fallback was not applied');
  });

  test('the effort is the hinted agent\'s own, never gsd-executor\'s, when the fallback applies', () => {
    setConfig({ model_profile: 'quality', effort: { agent_overrides: { [HINTED]: 'low', 'gsd-executor': 'high' } } });
    const got = resolveJson(HINTED, '--fallback-agent', 'gsd-executor');
    assert.strictEqual(got.effort, 'low');
    assert.strictEqual(got.model, resolveJson('gsd-executor').model, 'the model still falls back');
    assert.strictEqual(got.fallback_agent, 'gsd-executor');
  });

  test('an empty model_overrides entry for the hint does not block the fallback', () => {
    setConfig({ model_profile: 'quality', model_overrides: { [HINTED]: '' } });
    const expected = resolveJson('gsd-executor');
    const got = resolveJson(HINTED, '--fallback-agent', 'gsd-executor');
    assert.strictEqual(got.model, expected.model);
    assert.strictEqual(got.fallback_agent, 'gsd-executor');
  });

  test('a catalogued agent keeps its own model', () => {
    setConfig({ model_profile: 'quality' });
    const own = resolveJson('gsd-planner');
    const got = resolveJson('gsd-planner', '--fallback-agent', 'gsd-executor');
    assert.deepStrictEqual(got, own);
  });

  test('profile "inherit" yields a tier for every agent, so the fallback is not applied', () => {
    setConfig({ model_profile: 'inherit' });
    const got = resolveJson(HINTED, '--fallback-agent', 'gsd-executor');
    assert.strictEqual(got.model, 'inherit');
    assert.ok(!('fallback_agent' in got));
  });

  test('without the flag the output is unchanged, and a fallback that is not a catalog role is ignored', () => {
    setConfig({ model_profile: 'balanced' });
    const plain = resolveModel(HINTED);
    const parsed = JSON.parse(plain);
    assert.deepStrictEqual(Object.keys(parsed).sort(), ['effort', 'model', 'profile', 'tier', 'unknown_agent']);
    assert.strictEqual(parsed.unknown_agent, true);
    assert.strictEqual(resolveModel(HINTED, '--fallback-agent', 'not-a-gsd-role'), plain);
    assert.strictEqual(resolveModel(HINTED, '--fallback-agent', 'toString'), plain, 'a prototype key is not a catalog role');
  });

  test('--fallback-agent with no value is a usage error, as for every other value flag', () => {
    setConfig({ model_profile: 'balanced' });
    const missing = (...args) => runGsdTools(['resolve-model', ...args], root, homeSandboxEnv(root));
    const reference = runGsdTools(['resolve-execution', 'gsd-planner', '--host'], root, homeSandboxEnv(root));
    assert.strictEqual(reference.success, false, 'the reference value flag rejects a missing value');
    for (const args of [[HINTED, '--fallback-agent'], [HINTED, '--fallback-agent', '--raw'], [HINTED, '--fallback-agent', ''], ['--fallback-agent']]) {
      const r = missing(...args);
      assert.strictEqual(r.success, false, JSON.stringify(args));
      assert.strictEqual(r.exitCode, reference.exitCode, `same exit code as the other value flags: ${JSON.stringify(args)}`);
      assert.ok(r.error.includes('Missing value for --fallback-agent'), r.error);
      assert.strictEqual(r.output, '', 'nothing is printed on stdout');
    }
  });

  test('a repeated --fallback-agent is a usage error, not a silent first-wins', () => {
    setConfig({ model_profile: 'balanced' });
    const reference = runGsdTools(['resolve-execution', 'gsd-planner', '--host'], root, homeSandboxEnv(root));
    for (const args of [
      [HINTED, '--fallback-agent', 'gsd-executor', '--fallback-agent', 'gsd-planner'],
      ['--fallback-agent', 'gsd-executor', HINTED, '--fallback-agent', 'gsd-executor'],
    ]) {
      const r = runGsdTools(['resolve-model', ...args], root, homeSandboxEnv(root));
      assert.strictEqual(r.success, false, JSON.stringify(args));
      assert.strictEqual(r.exitCode, reference.exitCode, 'same exit code as the other usage errors');
      assert.ok(r.error.includes('Duplicate --fallback-agent'), r.error);
      assert.strictEqual(r.output, '', 'nothing is printed on stdout');
    }
    assert.ok(resolveJson(HINTED, '--fallback-agent', 'gsd-executor').fallback_agent, 'a single flag still works');
  });

  test('the unconditional workflow call for gsd-executor itself prints the same model as the plain query', () => {
    for (const profile of ['quality', 'balanced', 'budget', 'inherit']) {
      setConfig({ model_profile: profile });
      assert.strictEqual(
        resolveModel('gsd-executor', '--fallback-agent', 'gsd-executor', '--raw'),
        resolveModel('gsd-executor', '--raw'),
        profile,
      );
    }
  });

  test('--raw prints the fallback model alone', () => {
    setConfig({ model_profile: 'quality' });
    const expected = resolveJson('gsd-executor').model;
    assert.strictEqual(resolveModel(HINTED, '--fallback-agent', 'gsd-executor', '--raw'), String(expected));
  });
});
