'use strict';

// #6076 — scripts/ci-fix-next-rerun.cjs: re-run only the Base branch health job.
// Every branch is driven through a scripted fake `gh` and a fake clock/sleep.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');

const { rerunBaseHealth, main, BASE_HEALTH_JOB_NAME } = require('../scripts/ci-fix-next-rerun.cjs');

const REPO = 'open-gsd/gsd-core';
const SHA = 'a'.repeat(40);
const PR = '7';

/** Scripted gh: `routes` maps a command prefix key to a response (string, array of strings consumed in order, or Error). */
function fakeGh(routes) {
  const calls = [];
  const counters = new Map();
  const gh = async (args) => {
    calls.push(args);
    const key = args[0] === 'api' ? 'api' : `${args[0]} ${args[1]}`;
    let response = routes[key];
    if (Array.isArray(response)) {
      const i = counters.get(key) ?? 0;
      counters.set(key, i + 1);
      response = response[Math.min(i, response.length - 1)];
    }
    if (response instanceof Error) throw response;
    if (response === undefined) throw new Error(`unscripted gh call: ${args.join(' ')}`);
    return typeof response === 'string' ? response : JSON.stringify(response);
  };
  gh.calls = calls;
  return gh;
}

/** now() replays the scripted values; the last value repeats. */
function fakeClock(values) {
  let i = 0;
  const now = () => values[Math.min(i++, values.length - 1)];
  const sleeps = [];
  const sleep = async (ms) => { sleeps.push(ms); };
  return { now, sleep, sleeps };
}

// `gh run list` bodies are JSON strings: a bare array route would be read by fakeGh as a response SEQUENCE.
const completed = (conclusion = 'success') => JSON.stringify([{ databaseId: 111, status: 'completed', conclusion }]);
const inProgress = JSON.stringify([{ databaseId: 111, status: 'in_progress', conclusion: '' }]);
const jobsBody = { jobs: [{ name: 'Lint', databaseId: 5 }, { name: BASE_HEALTH_JOB_NAME, databaseId: 222 }] };

function run(routes, clockValues = [0], extra = {}) {
  const gh = fakeGh(routes);
  const clock = fakeClock(clockValues);
  const promise = rerunBaseHealth({
    gh, repo: REPO, headSha: SHA, prNumber: PR, now: clock.now, sleep: clock.sleep,
    deadlineMs: 100, pollMs: 30, ...extra,
  });
  return promise.then((result) => ({ result, gh, clock }));
}

describe('rerunBaseHealth', () => {
  test('no Tests run for the sha -> skip no-run, nothing else called', async () => {
    const { result, gh } = await run({ 'run list': '[]' });
    assert.deepEqual(result, { action: 'skip', reason: 'no-run' });
    assert.equal(gh.calls.length, 1);
  });

  test('completed success -> exact rerun argv', async () => {
    const { result, gh } = await run({
      'run list': completed(),
      api: `${SHA}\n`,
      'run view': jobsBody,
      'run rerun': '',
    });
    assert.deepEqual(result, { action: 'rerun', reason: 'rerun', runId: '111', jobId: '222' });
    assert.deepEqual(gh.calls[0], [
      'run', 'list', '--workflow', 'test.yml', '--commit', SHA, '--event', 'pull_request',
      '--limit', '1', '--json', 'databaseId,status,conclusion',
    ]);
    assert.deepEqual(gh.calls[1], ['api', `repos/${REPO}/pulls/${PR}`, '--jq', '.head.sha']);
    assert.deepEqual(gh.calls.at(-1), ['run', 'rerun', '111', '--job', '222']);
  });

  test('completed failure also re-runs (only cancelled is skipped)', async () => {
    const { result } = await run({
      'run list': completed('failure'), api: SHA, 'run view': jobsBody, 'run rerun': '',
    });
    assert.equal(result.action, 'rerun');
  });

  test('in_progress then completed -> sleeps pollMs once, then re-runs', async () => {
    const { result, clock } = await run({
      'run list': [inProgress, completed()], api: SHA, 'run view': jobsBody, 'run rerun': '',
    }, [0, 10]);
    assert.equal(result.action, 'rerun');
    assert.deepEqual(clock.sleeps, [30]);
  });

  test('deadline boundary: now = deadline-1 keeps polling', async () => {
    const { result, clock } = await run({
      'run list': [inProgress, completed()], api: SHA, 'run view': jobsBody, 'run rerun': '',
    }, [0, 99]);
    assert.equal(result.action, 'rerun');
    assert.equal(clock.sleeps.length, 1);
  });

  test('deadline boundary: now = deadline -> error timeout', async () => {
    const { result, clock } = await run({ 'run list': inProgress }, [0, 100]);
    assert.deepEqual(result, { action: 'error', reason: 'timeout', runId: '111' });
    assert.equal(clock.sleeps.length, 0);
  });

  test('deadline boundary: now = deadline+1 -> error timeout', async () => {
    const { result } = await run({ 'run list': inProgress }, [0, 101]);
    assert.equal(result.reason, 'timeout');
  });

  test('cancelled conclusion -> skip run-cancelled, no rerun and no head read', async () => {
    const { result, gh } = await run({ 'run list': completed('cancelled') });
    assert.deepEqual(result, { action: 'skip', reason: 'run-cancelled', runId: '111' });
    assert.ok(!gh.calls.some((c) => c[0] === 'run' && c[1] === 'rerun'));
    assert.ok(!gh.calls.some((c) => c[0] === 'api'));
  });

  test('action_required -> skip run-awaiting-approval, no rerun and no head read', async () => {
    const { result, gh } = await run({ 'run list': completed('action_required') });
    assert.deepEqual(result, { action: 'skip', reason: 'run-awaiting-approval', runId: '111' });
    assert.ok(!gh.calls.some((c) => c[0] === 'run' && c[1] === 'rerun'));
    assert.ok(!gh.calls.some((c) => c[0] === 'api'));
  });

  test('head matches on the first read but moves before the rerun -> skip head-moved, no rerun', async () => {
    const { result, gh } = await run({
      'run list': completed(), api: [SHA, 'b'.repeat(40)], 'run view': jobsBody, 'run rerun': '',
    });
    assert.deepEqual(result, { action: 'skip', reason: 'head-moved', runId: '111' });
    assert.equal(gh.calls.filter((c) => c[0] === 'api').length, 2);
    assert.ok(!gh.calls.some((c) => c[1] === 'rerun'));
  });

  test('PR head moved -> skip head-moved, no rerun', async () => {
    const { result, gh } = await run({ 'run list': completed(), api: `${'b'.repeat(40)}\n` });
    assert.deepEqual(result, { action: 'skip', reason: 'head-moved', runId: '111' });
    assert.ok(!gh.calls.some((c) => c[1] === 'rerun'));
  });

  test('job missing -> error no-job, no rerun', async () => {
    const { result, gh } = await run({
      'run list': completed(), api: SHA, 'run view': { jobs: [{ name: 'Lint', databaseId: 5 }] },
    });
    assert.deepEqual(result, { action: 'error', reason: 'no-job', runId: '111' });
    assert.ok(!gh.calls.some((c) => c[1] === 'rerun'));
  });

  test('job name must match exactly', async () => {
    const { result } = await run({
      'run list': completed(), api: SHA, 'run view': { jobs: [{ name: 'Base branch health (x)', databaseId: 9 }] },
    });
    assert.equal(result.reason, 'no-job');
  });

  test('gh throws -> error gh-failed', async () => {
    const { result } = await run({ 'run list': new Error('boom') });
    assert.equal(result.action, 'error');
    assert.match(result.reason, /^gh-failed: boom/);
  });

  test('rerun call throws -> error', async () => {
    const { result } = await run({
      'run list': completed(), api: SHA, 'run view': jobsBody, 'run rerun': new Error('403'),
    });
    assert.equal(result.action, 'error');
  });

  test('property: any completed non-cancelled conclusion re-runs when head matches', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('success', 'failure', 'timed_out', 'skipped'),
        fc.integer({ min: 1, max: 1e9 }),
        async (conclusion, id) => {
          const { result } = await run({
            'run list': JSON.stringify([{ databaseId: id, status: 'completed', conclusion }]),
            api: SHA,
            'run view': jobsBody,
            'run rerun': '',
          });
          return result.action === 'rerun' && result.runId === String(id);
        },
      ),
      { seed: 6076, numRuns: 50 },
    );
  });
});

describe('main() env validation', () => {
  const baseEnv = { GH_REPO: REPO, PR_NUMBER: PR, HEAD_SHA: SHA };
  const harness = (env, routes = { 'run list': '[]' }) => {
    const out = [];
    const err = [];
    return {
      out,
      err,
      gh: fakeGh(routes),
      exec(gh) {
        return main({
          env, gh, stdout: (s) => out.push(s), stderr: (s) => err.push(s), now: () => 0, sleep: async () => {},
        });
      },
    };
  };

  for (const [value, ok] of [['0', false], ['1', true], ['abc', false], ['-1', false], ['07', false], ['', false]]) {
    test(`PR_NUMBER=${JSON.stringify(value)} -> ${ok ? 'accepted' : 'error exit 1'}`, async () => {
      const h = harness({ ...baseEnv, PR_NUMBER: value });
      const code = await h.exec(h.gh);
      assert.equal(code, ok ? 0 : 1);
      if (!ok) {
        assert.match(h.err.join(''), /::error::PR_NUMBER/);
        assert.equal(h.gh.calls.length, 0);
      }
    });
  }

  test('PR_NUMBER " 7 " is trimmed and accepted', async () => {
    const h = harness({ ...baseEnv, PR_NUMBER: ' 7 ' }, {
      'run list': completed(), api: SHA, 'run view': jobsBody, 'run rerun': '',
    });
    assert.equal(await h.exec(h.gh), 0);
    assert.equal(h.err.join(''), '');
    const apiCall = h.gh.calls.find((c) => c[0] === 'api');
    assert.ok(apiCall, 'pulls read must happen');
    assert.ok(apiCall.includes(`repos/${REPO}/pulls/7`), apiCall.join(' '));
  });

  for (const [len, ok] of [[39, false], [40, true], [41, false]]) {
    test(`HEAD_SHA of ${len} hex chars -> ${ok ? 'accepted' : 'error exit 1'}`, async () => {
      const h = harness({ ...baseEnv, HEAD_SHA: 'c'.repeat(len) });
      const code = await h.exec(h.gh);
      assert.equal(code, ok ? 0 : 1);
      if (!ok) assert.match(h.err.join(''), /::error::HEAD_SHA/);
    });
  }

  test('non-hex 40-char HEAD_SHA -> error', async () => {
    const h = harness({ ...baseEnv, HEAD_SHA: 'z'.repeat(40) });
    assert.equal(await h.exec(h.gh), 1);
  });

  test('invalid GH_REPO -> error', async () => {
    const h = harness({ ...baseEnv, GH_REPO: 'nope' });
    assert.equal(await h.exec(h.gh), 1);
  });

  test('skip outcome -> exit 0 with a notice', async () => {
    const h = harness(baseEnv);
    assert.equal(await h.exec(h.gh), 0);
    assert.match(h.out.join(''), /::notice::.*no-run/);
  });

  test('error outcome -> exit 1 with ::error::', async () => {
    const h = harness(baseEnv, { 'run list': new Error('down') });
    assert.equal(await h.exec(h.gh), 1);
    assert.match(h.err.join(''), /::error::/);
  });

  test('rerun outcome -> exit 0', async () => {
    const h = harness(baseEnv, {
      'run list': completed(), api: SHA, 'run view': jobsBody, 'run rerun': '',
    });
    assert.equal(await h.exec(h.gh), 0);
    assert.match(h.out.join(''), /Re-ran/);
  });
});
