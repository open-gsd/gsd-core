'use strict';

/**
 * advisor-prefilter.test.cjs — #4795.
 *
 * The optional first-party `advisor-prefilter` capability dispatches one `kind:"contribution"` hook
 * (`into:"orchestrator"`) at exactly two loop points — `verify:post` and `ship:pre` — and only when
 * `workflow.advisor_prefilter` is on (default false). `orchestrator` is published only for discuss,
 * verify and ship, so the execute points cannot carry it.
 *
 * Behavioral: the real generated registry, the pure resolver the host workflows reach through
 * `gsd_run loop render-hooks`, and that CLI itself in a hermetic temp project (the shape the shipping
 * callers use). The fragment's prose contract lives in
 * scripts/static-checks/text-contracts/advisor-prefilter.cjs.
 */

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { cleanup, runGsdTools, homeSandboxEnv } = require('./helpers.cjs');
const { createHermeticRoot } = require('./helpers/isolated-env.cjs');

const { resolveLoopHooks } = require('../gsd-core/bin/lib/loop-resolver.cjs');
const { LOOP_HOST_CONTRACT } = require('../gsd-core/bin/lib/loop-host-contract.cjs');
const { isValidConfigKey, getCapabilityConfigSchema } = require('../gsd-core/bin/lib/config-schema.cjs');
const registry = require('../gsd-core/bin/lib/capability-registry.cjs');

const CAP_ID = 'advisor-prefilter';
const KEY = 'workflow.advisor_prefilter';
const DECLARED_POINTS = ['verify:post', 'ship:pre'];
const ALL_POINTS = LOOP_HOST_CONTRACT.flatMap((step) => step.points);
const ORCHESTRATOR_POINTS = LOOP_HOST_CONTRACT
  .filter((step) => step.agentRoles.includes('orchestrator'))
  .flatMap((step) => step.points);

const tmpDirs = [];
after(() => { for (const dir of tmpDirs) cleanup(dir); });

function resolve(point, advisorPrefilter) {
  const config = advisorPrefilter === undefined ? {} : { workflow: { advisor_prefilter: advisorPrefilter } };
  return resolveLoopHooks({ point, registry, config });
}

function mineAt(point, advisorPrefilter) {
  return resolve(point, advisorPrefilter).activeHooks.filter((hook) => hook.capId === CAP_ID);
}

function makeProject(config) {
  // A hermetic root: GSD's upward `.planning/config.json` search stops here (CONTRIBUTING, #4613).
  const dir = createHermeticRoot('gsd-advisor-prefilter-');
  tmpDirs.push(dir);
  if (config !== undefined) fs.writeFileSync(path.join(dir, '.planning', 'config.json'), JSON.stringify(config), 'utf8');
  return dir;
}

function renderHooks(cwd, point) {
  const result = runGsdTools(['loop', 'render-hooks', point, '--raw'], cwd, homeSandboxEnv(cwd));
  assert.equal(result.success, true, `render-hooks ${point} failed: ${result.error || result.output}`);
  return JSON.parse(result.output).activeHooks.filter((hook) => hook.capId === CAP_ID);
}

describe('advisor-prefilter: default off', () => {
  for (const point of DECLARED_POINTS) {
    test(`defaultOffEmitsNoHookAt ${point}`, () => {
      assert.deepEqual(mineAt(point, undefined), []);
    });
    test(`explicitFalseEmitsNothingAt ${point}`, () => {
      assert.deepEqual(mineAt(point, false), []);
    });
  }

  for (const value of [null, 0, '']) {
    test(`nonBooleanFalsyEmitsNothing (${JSON.stringify(value)})`, () => {
      for (const point of DECLARED_POINTS) assert.deepEqual(mineAt(point, value), []);
    });
  }

  // A hand-edited config can spell the switch as a string; "false" must not turn it on (#4795).
  for (const value of ['false', 'FALSE', ' off ', 'no', '0']) {
    test(`stringOffSpellingEmitsNothing (${JSON.stringify(value)})`, () => {
      for (const point of DECLARED_POINTS) assert.deepEqual(mineAt(point, value), []);
    });
  }
});

describe('advisor-prefilter: enabled', () => {
  for (const point of DECLARED_POINTS) {
    test(`enabledEmitsContributionAt ${point}`, () => {
      const hooks = mineAt(point, true);
      assert.equal(hooks.length, 1);
      const [hook] = hooks;
      assert.equal(hook.kind, 'contribution');
      assert.equal(hook.into, 'orchestrator');
      assert.equal(hook.onError, 'skip');
      assert.equal(hook.when, KEY);
      assert.equal(hook.ref, undefined, 'a contribution carries no ref');
      assert.equal(typeof hook.fragment.inline, 'string');
      assert.ok(hook.fragment.inline.length > 0, 'the fragment text is resolved into the registry');
    });
  }

  for (const value of ['true', 'yes', 1]) {
    test(`truthyEnableSpellingEmitsTheHook (${JSON.stringify(value)})`, () => {
      for (const point of DECLARED_POINTS) assert.equal(mineAt(point, value).length, 1);
    });
  }

  test('contributionCarriesNoArtifactContract', () => {
    for (const point of DECLARED_POINTS) {
      const [hook] = mineAt(point, true);
      assert.equal(hook.produces, undefined);
      assert.equal(hook.consumes, undefined);
    }
  });

  test('theCapabilityContributesNoStepOrGate', () => {
    for (const point of ALL_POINTS) {
      const kinds = resolve(point, true).activeHooks.filter((hook) => hook.capId === CAP_ID).map((hook) => hook.kind);
      assert.ok(kinds.every((kind) => kind === 'contribution'), `${point} emitted ${kinds.join(',')}`);
    }
  });

  // limit-1 / limit / limit+1: one declared point would miss one, three would add a stray one.
  test('declaresExactlyTheTwoPoints', () => {
    const emitting = ALL_POINTS.filter((point) => mineAt(point, true).length > 0);
    assert.deepEqual([...emitting].sort(), [...DECLARED_POINTS].sort());
    assert.equal(emitting.length, 2);
    const silent = ALL_POINTS.filter((point) => !DECLARED_POINTS.includes(point));
    assert.ok(silent.length > 0);
    for (const point of silent) assert.deepEqual(mineAt(point, true), [], `${point} must stay silent`);
  });

  test('everyDeclaredPointPublishesTheOrchestratorRole', () => {
    for (const point of DECLARED_POINTS) {
      assert.ok(ORCHESTRATOR_POINTS.includes(point), `${point} must publish the orchestrator role`);
    }
    assert.ok(!ORCHESTRATOR_POINTS.includes('execute:wave:post'), 'execute points publish no orchestrator role');
  });
});

describe('advisor-prefilter: config key', () => {
  test('configKeyFederatesWithDefaultFalse', () => {
    assert.equal(isValidConfigKey(KEY), true);
    const entry = getCapabilityConfigSchema()[KEY];
    assert.ok(entry, 'capability config schema carries the key');
    assert.equal(entry.type, 'boolean');
    assert.equal(entry.default, false);
  });
});

describe('advisor-prefilter: shipping caller shape (gsd_run loop render-hooks)', () => {
  test('cliEmitsTheContributionWhenTheProjectEnablesIt', () => {
    const dir = makeProject({ workflow: { advisor_prefilter: true } });
    for (const point of DECLARED_POINTS) {
      const hooks = renderHooks(dir, point);
      assert.equal(hooks.length, 1, `${point} must render the contribution`);
      assert.equal(hooks[0].kind, 'contribution');
      assert.equal(hooks[0].into, 'orchestrator');
    }
  });

  test('projectsDoNotLeakIntoEachOther', () => {
    const on = makeProject({ workflow: { advisor_prefilter: true } });
    const off = makeProject({ workflow: { advisor_prefilter: false } });
    const stringOff = makeProject({ workflow: { advisor_prefilter: 'false' } });
    const unset = makeProject();
    for (const point of DECLARED_POINTS) {
      assert.equal(renderHooks(on, point).length, 1);
      assert.equal(renderHooks(off, point).length, 0);
      assert.equal(renderHooks(stringOff, point).length, 0);
      assert.equal(renderHooks(unset, point).length, 0);
    }
  });
});
