/**
 * #5473 — time the 112KB validate-commit rows INSIDE the real macOS conformance
 * tier, varying the hook's environment and spawn mode (see
 * scripts/diagnose-validate-commit-in-tier.cjs for what and why).
 *
 * This file is in the macOS tier on purpose: the tier's shell step runs zsh, and
 * that signal is what puts a test file there, so it runs beside the very files
 * whose contention is under study. It asserts no timing. The pure helpers are
 * tested everywhere; the measurement runs only on macOS (os.type() is 'Darwin').
 * TEMPORARY: delete this file and the module once #5473 is resolved.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const { cleanup } = require('./helpers.cjs');

const {
  describeEnv,
  without,
  envVariants,
  runDetached,
  inTierReport,
  SHOWN_ENV,
} = require('../scripts/diagnose-validate-commit-in-tier.cjs');
const { makeProject, hookEnv } = require('../scripts/diagnose-validate-commit-phases.cjs');

describe('describeEnv', () => {
  test('names are sorted; only allowlisted values are shown', () => {
    const { names, shown } = describeEnv({ ZED: '1', GITHUB_TOKEN: 'secret', NODE_OPTIONS: '--x', ALPHA: '2' });
    assert.deepEqual(names, ['ALPHA', 'GITHUB_TOKEN', 'NODE_OPTIONS', 'ZED']);
    assert.deepEqual(shown, { NODE_OPTIONS: '--x' });
    assert.ok(!JSON.stringify(shown).includes('secret'));
  });

  test('every allowlisted name is shown when present and none are invented when absent', () => {
    const all = Object.fromEntries(SHOWN_ENV.map((k) => [k, 'v']));
    assert.deepEqual(Object.keys(describeEnv(all).shown).sort(), [...SHOWN_ENV].sort());
    assert.deepEqual(describeEnv({}).shown, {});
  });

  test('an inherited property is not a variable', () => {
    const env = Object.create({ NODE_OPTIONS: 'inherited' });
    assert.deepEqual(describeEnv(env).shown, {});
  });
});

describe('without', () => {
  test('drops exactly the variables whose name starts with a prefix, and does not mutate its input', () => {
    const env = { NODE_A: '1', NODEX: '2', GSD_B: '3', RUN_TESTS_C: '4', PATH: '/bin' };
    assert.deepEqual(without(env, ['NODE_']), { NODEX: '2', GSD_B: '3', RUN_TESTS_C: '4', PATH: '/bin' });
    assert.deepEqual(without(env, ['GSD_', 'RUN_TESTS_']), { NODE_A: '1', NODEX: '2', PATH: '/bin' });
    assert.deepEqual(without(env, []), env);
    assert.equal(env.NODE_A, '1');
  });
});

describe('envVariants', () => {
  const base = { PATH: '/p', HOME: '/h', NODE_TEST_CONTEXT: 'child', GSD_X: '1', RUN_TESTS_Y: '2', OTHER: '3' };
  const variants = envVariants(base);

  test('four variants, the first being the real row\'s environment unchanged', () => {
    assert.equal(variants.length, 4);
    assert.deepEqual(variants[0].env, base);
  });

  test('the minimal variant is exactly PATH and HOME, with a missing HOME as the empty string', () => {
    assert.deepEqual(variants[1].env, { PATH: '/p', HOME: '/h' });
    assert.deepEqual(envVariants({ PATH: '/p' })[1].env, { PATH: '/p', HOME: '' });
  });

  test('each of the other two removes one family and nothing else', () => {
    assert.deepEqual(Object.keys(variants[2].env).sort(), ['GSD_X', 'HOME', 'OTHER', 'PATH', 'RUN_TESTS_Y']);
    assert.deepEqual(Object.keys(variants[3].env).sort(), ['HOME', 'NODE_TEST_CONTEXT', 'OTHER', 'PATH']);
  });
});

describe('runDetached', () => {
  test('resolves with the hook\'s exit status and a wall time, without hanging', { skip: os.type() !== 'Darwin' && 'macOS-only' }, async () => {
    const project = makeProject();
    try {
      const ok = await runDetached(project, 'git commit -m "feat: add thing"', hookEnv());
      assert.equal(ok.status, 0);
      assert.equal(ok.killed, false);
      assert.ok(Number.isInteger(ok.wallMs) && ok.wallMs >= 0);
      const blocked = await runDetached(project, 'git commit -m "wibble wobble"', hookEnv());
      assert.equal(blocked.status, 2);
    } finally {
      cleanup(project);
    }
  });
});

describe('inTierReport', () => {
  test('measures inside the tier and prints the report (no timing asserted)', { skip: os.type() !== 'Darwin' && 'macOS-only' }, async () => {
    const { text, ok } = await inTierReport();
    // The report is the deliverable: it goes to the job log and the job summary.
    console.log(text);
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
    assert.ok(ok, text);
    assert.match(text, /INSIDE the conformance tier/);
    assert.match(text, /async \+ detached \+ group kill/);
  });
});
