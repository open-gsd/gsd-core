'use strict';

// Red-`next` recovery under the merge queue (research memo:
// docs/research/merge-queue-red-next-recovery.md).
//
// Two holes in the #4422 base-health gate, both seen on 2026-10-27:
//   1. merge_group events carry no labels, so `fix-next` could not rescue the
//      queued fix-forward and a red `next` deadlocked its own fix.
//   2. The gate listed only `status=completed` runs, so a mid-flight re-run of
//      the red run dropped out of the list and the gate read the older green
//      run — an accidental, indiscriminate bypass.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  VERDICT,
  classifyBaseRuns,
  parseQueueRef,
  evaluateQueueBypass,
  resolveNextHealth,
} = require('../scripts/ci-next-health.cjs');

const SHA = 'd90964063dda1a2b3c4d5e6f708192a3b4c5d6e7';
const REF = `gh-readonly-queue/next/pr-5755-${SHA}`;

const run = (over) => ({ id: 1, html_url: 'https://example.test/run/1', ...over });
const done = (conclusion, over) => run({ status: 'completed', conclusion, ...over });

describe('ci-next-health: classifyBaseRuns', () => {
  test('a completed green newest run is CLEAN, a completed red one RED', () => {
    assert.equal(classifyBaseRuns({ workflow_runs: [done('success')] }).verdict, VERDICT.CLEAN);
    assert.equal(classifyBaseRuns({ workflow_runs: [done('failure')] }).verdict, VERDICT.RED);
  });

  test('a run without a status field is treated as completed', () => {
    assert.equal(classifyBaseRuns({ workflow_runs: [{ conclusion: 'failure' }] }).verdict, VERDICT.RED);
  });

  test('attempt 2 in flight after a failed attempt 1 is RED, not the older green run', () => {
    const rerun = run({ id: 2, status: 'in_progress', conclusion: null, run_attempt: 2,
      previous_attempt_conclusion: 'failure' });
    const older = done('success', { id: 1 });
    const out = classifyBaseRuns({ workflow_runs: [rerun, older] });
    assert.equal(out.verdict, VERDICT.RED);
    assert.equal(out.reason, 'rerun-in-flight-after-failure');
    assert.equal(out.run.id, 2);
  });

  test('a fresh push run in flight falls back to the newest settled run', () => {
    const fresh = run({ id: 3, status: 'queued', run_attempt: 1 });
    assert.equal(classifyBaseRuns({ workflow_runs: [fresh, done('success')] }).verdict, VERDICT.CLEAN);
    const red = classifyBaseRuns({ workflow_runs: [fresh, done('failure', { id: 2 })] });
    assert.equal(red.verdict, VERDICT.RED);
    assert.equal(red.run.id, 2, 'evidence is the red run, not the in-flight one');
  });

  test('a re-run whose previous attempt succeeded does not turn RED', () => {
    const rerun = run({ status: 'in_progress', run_attempt: 2, previous_attempt_conclusion: 'success' });
    assert.equal(classifyBaseRuns({ workflow_runs: [rerun, done('success', { id: 9 })] }).verdict, VERDICT.CLEAN);
  });

  test('in flight with no settled history (brand-new branch) is CLEAN', () => {
    const out = classifyBaseRuns({ workflow_runs: [run({ status: 'in_progress' })] });
    assert.equal(out.verdict, VERDICT.CLEAN);
  });

  test('malformed payloads are INDETERMINATE; empty is CLEAN', () => {
    for (const bad of [null, undefined, 'x', {}, { workflow_runs: 'x' }]) {
      assert.equal(classifyBaseRuns(bad).verdict, VERDICT.INDETERMINATE);
    }
    assert.equal(classifyBaseRuns({ workflow_runs: [] }).verdict, VERDICT.CLEAN);
  });
});

describe('ci-next-health: parseQueueRef', () => {
  test('parses plain and refs/heads-prefixed queue refs, multi-digit PRs, slashed bases', () => {
    assert.deepEqual(parseQueueRef(REF), { base: 'next', prNumber: 5755 });
    assert.deepEqual(parseQueueRef(`refs/heads/${REF}`), { base: 'next', prNumber: 5755 });
    assert.deepEqual(
      parseQueueRef(`gh-readonly-queue/release/1.0/pr-12-${SHA}`),
      { base: 'release/1.0', prNumber: 12 },
    );
  });

  test('rejects anything that is not a queue ref', () => {
    for (const bad of [
      '', undefined, null, 'next', 'refs/heads/next',
      'gh-readonly-queue/next/pr-abc-' + SHA,
      'gh-readonly-queue/next/pr-5755-deadbeef',
      `gh-readonly-queue/next/pr-5755-${SHA}/extra`,
      `x/gh-readonly-queue/next/pr-5755-${SHA}`,
    ]) {
      assert.equal(parseQueueRef(bad), null, String(bad));
    }
  });
});

function fakeGh(routes) {
  const calls = [];
  const fn = async (path) => {
    calls.push(path);
    const key = Object.keys(routes).find((k) => path.startsWith(k));
    if (!key) throw new Error(`unexpected GET ${path}`);
    const value = routes[key];
    if (value instanceof Error) throw value;
    return typeof value === 'function' ? value(path) : value;
  };
  fn.calls = calls;
  return fn;
}

const R = '/repos/o/r';
const goodRoutes = (over = {}) => ({
  [`${R}/compare/`]: { total_commits: 1 },
  [`${R}/issues/5755/labels`]: [{ name: 'fix-next' }],
  [`${R}/issues/5755/events`]: [
    { event: 'labeled', label: { name: 'other' }, actor: { login: 'someone' } },
    { event: 'labeled', label: { name: 'fix-next' }, actor: { login: 'trek-e' } },
  ],
  [`${R}/collaborators/trek-e/permission`]: { permission: 'admin' },
  ...over,
});
const evalQueue = (ghGet, over = {}) => evaluateQueueBypass({
  headRef: REF, baseSha: 'b'.repeat(40), headSha: SHA, repo: 'o/r', ghGet, ...over,
});

describe('ci-next-health: evaluateQueueBypass', () => {
  test('authorizes a single-PR group whose label was applied by an admin', async () => {
    const out = await evalQueue(fakeGh(goodRoutes()));
    assert.deepEqual(out, { authorized: true, reason: 'queue-label', actor: 'trek-e', prNumber: 5755 });
  });

  test('write permission is enough; read and none are not', async () => {
    for (const [permission, ok] of [['write', true], ['maintain', true], ['read', false], ['none', false]]) {
      const out = await evalQueue(fakeGh(goodRoutes({ [`${R}/collaborators/trek-e/permission`]: { permission } })));
      assert.equal(out.authorized, ok, permission);
      if (!ok) assert.equal(out.reason, 'label-applier-lacks-write');
    }
  });

  test('uses the LATEST labeled event for the applier', async () => {
    const out = await evalQueue(fakeGh(goodRoutes({
      [`${R}/issues/5755/events`]: [
        { event: 'labeled', label: { name: 'fix-next' }, actor: { login: 'rando' } },
        { event: 'unlabeled', label: { name: 'fix-next' }, actor: { login: 'rando' } },
        { event: 'labeled', label: { name: 'fix-next' }, actor: { login: 'trek-e' } },
      ],
    })));
    assert.equal(out.actor, 'trek-e');
  });

  test('refuses a multi-PR group', async () => {
    const out = await evalQueue(fakeGh(goodRoutes({ [`${R}/compare/`]: { total_commits: 2 } })));
    assert.equal(out.authorized, false);
    assert.equal(out.reason, 'multi-pr-group');
  });

  test('refuses when the PR is not labelled', async () => {
    const out = await evalQueue(fakeGh(goodRoutes({ [`${R}/issues/5755/labels`]: [{ name: 'bug' }] })));
    assert.equal(out.reason, 'no-label');
    assert.equal(out.authorized, false);
  });

  test('refuses when no labeled event names an actor', async () => {
    const out = await evalQueue(fakeGh(goodRoutes({ [`${R}/issues/5755/events`]: [] })));
    assert.equal(out.reason, 'label-applier-unknown');
  });

  test('refuses on an unparseable ref or missing shas without calling the API', async () => {
    const gh = fakeGh(goodRoutes());
    assert.equal((await evalQueue(gh, { headRef: 'refs/heads/next' })).reason, 'queue-ref-unparseable');
    assert.equal((await evalQueue(gh, { baseSha: '' })).reason, 'no-group-shas');
    assert.equal(gh.calls.length, 0);
  });

  test('an API error is "not authorized" (RED), never an accidental pass', async () => {
    const out = await evalQueue(fakeGh(goodRoutes({ [`${R}/issues/5755/labels`]: new Error('boom') })));
    assert.equal(out.authorized, false);
    assert.match(out.reason, /bypass-check-failed: boom/);
  });
});

describe('ci-next-health: resolveNextHealth on merge_group', () => {
  const redRuns = { workflow_runs: [done('failure', { html_url: 'https://example.test/red' })] };
  const fetchLatestRun = async () => redRuns;

  test('an authorized queue label BYPASSES a red next and records the actor', async () => {
    const out = await resolveNextHealth({
      fetchLatestRun, eventName: 'merge_group', baseRef: 'next',
      evaluateQueueBypass: async () => ({ authorized: true, reason: 'queue-label', actor: 'trek-e' }),
    });
    assert.equal(out.verdict, VERDICT.BYPASSED);
    assert.equal(out.actor, 'trek-e');
  });

  test('an unauthorized queue label stays RED and says why', async () => {
    const out = await resolveNextHealth({
      fetchLatestRun, eventName: 'merge_group', baseRef: 'next',
      evaluateQueueBypass: async () => ({ authorized: false, reason: 'multi-pr-group' }),
    });
    assert.equal(out.verdict, VERDICT.RED);
    assert.match(out.reason, /multi-pr-group/);
  });

  test('a throwing evaluator stays RED', async () => {
    const out = await resolveNextHealth({
      fetchLatestRun, eventName: 'merge_group', baseRef: 'next',
      evaluateQueueBypass: async () => { throw new Error('x'); },
    });
    assert.equal(out.verdict, VERDICT.RED);
  });

  test('the evaluator is not consulted when next is healthy', async () => {
    let called = false;
    const out = await resolveNextHealth({
      fetchLatestRun: async () => ({ workflow_runs: [done('success')] }),
      eventName: 'merge_group', baseRef: 'next',
      evaluateQueueBypass: async () => { called = true; return { authorized: true }; },
    });
    assert.equal(out.verdict, VERDICT.CLEAN);
    assert.equal(called, false);
  });

  test('the pull_request label path still works and ignores the evaluator', async () => {
    const out = await resolveNextHealth({
      fetchLatestRun, eventName: 'pull_request', baseRef: 'next', labels: ['fix-next'],
      evaluateQueueBypass: async () => { throw new Error('must not run'); },
    });
    assert.equal(out.verdict, VERDICT.BYPASSED);
  });

  test('the 2026-10-27 incident: a re-run in flight over a red run is RED, evidence is the re-run', async () => {
    const out = await resolveNextHealth({
      fetchLatestRun: async () => ({
        workflow_runs: [
          run({ id: 40515019525, status: 'in_progress', run_attempt: 2, previous_attempt_conclusion: 'failure',
            html_url: 'https://example.test/rerun' }),
          done('success', { id: 40474964784 }),
        ],
      }),
      eventName: 'merge_group', baseRef: 'next',
    });
    assert.equal(out.verdict, VERDICT.RED);
    assert.match(out.reason, /rerun-in-flight-after-failure/);
    assert.equal(out.payload.workflow_runs[0].id, 40515019525);
  });
});

describe('ci-next-health: review follow-ups', () => {
  test('a re-run of a succeeded attempt is CLEAN even over an older red run', () => {
    const rerun = run({ status: 'in_progress', run_attempt: 2, previous_attempt_conclusion: 'success' });
    const out = classifyBaseRuns({ workflow_runs: [rerun, done('failure', { id: 9 })] });
    assert.equal(out.verdict, VERDICT.CLEAN);
  });

  test('an unreadable previous attempt ("unknown") reads RED', () => {
    const rerun = run({ status: 'in_progress', run_attempt: 2, previous_attempt_conclusion: 'unknown' });
    assert.equal(classifyBaseRuns({ workflow_runs: [rerun, done('success')] }).verdict, VERDICT.RED);
  });

  test('a full 10th page of label events fails closed (applier unknown)', async () => {
    const full = Array.from({ length: 100 }, () => ({ event: 'subscribed' }));
    full[0] = { event: 'labeled', label: { name: 'fix-next' }, actor: { login: 'trek-e' } };
    const out = await evalQueue(fakeGh(goodRoutes({ [`${R}/issues/5755/events`]: full })));
    assert.equal(out.authorized, false);
    assert.equal(out.reason, 'label-applier-unknown');
  });

  test('a queue ref for a different base branch is refused', async () => {
    const out = await evalQueue(fakeGh(goodRoutes()), { baseRef: 'release/1.0' });
    assert.equal(out.reason, 'queue-base-mismatch');
    assert.equal((await evalQueue(fakeGh(goodRoutes()), { baseRef: 'next' })).authorized, true);
  });
});
