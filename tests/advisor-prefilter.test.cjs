'use strict';

/**
 * advisor-prefilter.test.cjs — #4795.
 *
 * The optional first-party `advisor-prefilter` capability dispatches one `kind:"step"` hook
 * (`ref.skill:"advisor-prefilter"`) at exactly three loop points — `execute:wave:post`,
 * `verify:post`, `ship:pre` — and only when `workflow.advisor_prefilter` is true (default false).
 *
 * Behavioral: the real generated registry, the pure resolver the three host workflows reach
 * through `gsd_run loop render-hooks`, and that CLI itself in a sandboxed temp project (the
 * shape the shipping callers use). The skill's prose contract lives in
 * scripts/static-checks/text-contracts/advisor-prefilter.cjs.
 */

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { cleanup, runGsdTools, homeSandboxEnv } = require('./helpers.cjs');
const { createHermeticRoot } = require('./helpers/isolated-env.cjs');

const ROOT = path.join(__dirname, '..');

const { resolveLoopHooks } = require('../gsd-core/bin/lib/loop-resolver.cjs');
const { LOOP_HOST_CONTRACT } = require('../gsd-core/bin/lib/loop-host-contract.cjs');
const { isValidConfigKey, getCapabilityConfigSchema } = require('../gsd-core/bin/lib/config-schema.cjs');
const { extractFrontmatter } = require('../gsd-core/bin/lib/frontmatter.cjs');
const registry = require('../gsd-core/bin/lib/capability-registry.cjs');

const CAP_ID = 'advisor-prefilter';
const KEY = 'workflow.advisor_prefilter';
const DECLARED_POINTS = ['execute:wave:post', 'verify:post', 'ship:pre'];
const ALL_POINTS = LOOP_HOST_CONTRACT.flatMap((step) => step.points);

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
});

describe('advisor-prefilter: enabled', () => {
  for (const point of DECLARED_POINTS) {
    test(`enabledEmitsStepAt ${point}`, () => {
      const hooks = mineAt(point, true);
      assert.equal(hooks.length, 1);
      const [hook] = hooks;
      assert.equal(hook.kind, 'step');
      assert.deepEqual(hook.ref, { skill: 'advisor-prefilter' });
      assert.equal(hook.onError, 'skip');
      assert.equal(hook.when, KEY);
    });
  }

  test('stepCarriesNoArtifactContract', () => {
    for (const point of DECLARED_POINTS) {
      const [hook] = mineAt(point, true);
      assert.equal(hook.produces, undefined);
      assert.equal(hook.consumes, undefined);
    }
  });

  test('verifyPostDispatchesEachStepStemOnce', () => {
    const stems = resolve('verify:post', true).activeHooks
      .filter((hook) => hook.kind === 'step')
      .map((hook) => hook.ref && hook.ref.skill);
    assert.ok(stems.includes('advisor-prefilter'));
    assert.equal(new Set(stems).size, stems.length, 'a step stem must not be dispatched twice at one point');
  });

  // limit-1 / limit / limit+1: 2 declared points would miss one, 4 would add a stray one.
  test('declaresExactlyTheThreePoints', () => {
    const emitting = ALL_POINTS.filter((point) => mineAt(point, true).length > 0);
    assert.deepEqual([...emitting].sort(), [...DECLARED_POINTS].sort());
    assert.equal(emitting.length, 3);
    const silent = ALL_POINTS.filter((point) => !DECLARED_POINTS.includes(point));
    assert.ok(silent.length > 0);
    for (const point of silent) assert.deepEqual(mineAt(point, true), [], `${point} must stay silent`);
  });
});

describe('advisor-prefilter: manifest parity', () => {
  test('skillStemParityWithCommandFile', () => {
    const owned = DECLARED_POINTS.flatMap((point) =>
      ((registry.byLoopPoint[point] || {}).steps || []).filter((step) => step.capId === CAP_ID));
    assert.equal(owned.length, 3);
    for (const step of owned) assert.equal(step.ref.skill, 'advisor-prefilter');
    const commandFile = path.join(ROOT, 'commands', 'gsd', 'advisor-prefilter.md');
    assert.ok(fs.existsSync(commandFile), 'ref.skill needs commands/gsd/advisor-prefilter.md');
    const front = extractFrontmatter(fs.readFileSync(commandFile, 'utf8'));
    assert.equal(front.name, 'gsd:advisor-prefilter');
  });

  test('configKeyFederatesWithDefaultFalse', () => {
    assert.equal(isValidConfigKey(KEY), true);
    const entry = getCapabilityConfigSchema()[KEY];
    assert.ok(entry, 'capability config schema carries the key');
    assert.equal(entry.type, 'boolean');
    assert.equal(entry.default, false);
  });
});

describe('advisor-prefilter: shipping caller shape (gsd_run loop render-hooks)', () => {
  test('cliEmitsTheStepWhenTheProjectEnablesIt', () => {
    const dir = makeProject({ workflow: { advisor_prefilter: true } });
    for (const point of DECLARED_POINTS) {
      const hooks = renderHooks(dir, point);
      assert.equal(hooks.length, 1, `${point} must render the step`);
      assert.deepEqual(hooks[0].ref, { skill: 'advisor-prefilter' });
    }
  });

  test('projectsDoNotLeakIntoEachOther', () => {
    const on = makeProject({ workflow: { advisor_prefilter: true } });
    const off = makeProject({ workflow: { advisor_prefilter: false } });
    const unset = makeProject();
    for (const point of DECLARED_POINTS) {
      assert.equal(renderHooks(on, point).length, 1);
      assert.equal(renderHooks(off, point).length, 0);
      assert.equal(renderHooks(unset, point).length, 0);
    }
  });
});
