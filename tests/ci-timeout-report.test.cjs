'use strict';

/**
 * tests/ci-timeout-report.test.cjs
 *
 * Unit tests for scripts/ci-timeout-report.cjs's pure exports (#4036).
 * main() is impure orchestration requiring a live Octokit/GitHub Actions
 * context and is intentionally NOT covered here.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveJobTimeoutMinutes,
  parseJobRecord,
  buildReportLines,
  dedupeAgainstHistory,
} = require('../scripts/ci-timeout-report.cjs');

test('resolveJobTimeoutMinutes', async (t) => {
  await t.test('static job: resolves timeout-minutes from workflow YAML', () => {
    const yamlText = [
      'jobs:',
      '  test:',
      '    timeout-minutes: 15',
      '',
    ].join('\n');

    const result = resolveJobTimeoutMinutes({
      jobName: 'test (ubuntu-latest, 24, shard 1/3)',
      workflowFile: 'test.yml',
      workflowYamlText: yamlText,
      covered: null,
    });

    assert.equal(result, 15);
  });

  await t.test('mutation job: resolves override timeoutMinutes from COVERED', () => {
    const result = resolveJobTimeoutMinutes({
      jobName: 'Stryker (frontmatter)',
      workflowFile: 'mutation.yml',
      workflowYamlText: null,
      covered: { frontmatter: { timeoutMinutes: 20 }, 'adr-parser': {} },
    });

    assert.equal(result, 20);
  });

  await t.test('mutation job: falls back to default 15 when no override', () => {
    const result = resolveJobTimeoutMinutes({
      jobName: 'Stryker (adr-parser)',
      workflowFile: 'mutation.yml',
      workflowYamlText: null,
      covered: { frontmatter: { timeoutMinutes: 20 }, 'adr-parser': {} },
    });

    assert.equal(result, 15);
  });

  await t.test('mutation job: unknown module returns null', () => {
    const result = resolveJobTimeoutMinutes({
      jobName: 'Stryker (totally-unknown-module)',
      workflowFile: 'mutation.yml',
      workflowYamlText: null,
      covered: { frontmatter: { timeoutMinutes: 20 }, 'adr-parser': {} },
    });

    assert.equal(result, null);
  });

  await t.test('test-inert resolves against the test-inert job key, not test', () => {
    const yamlText = [
      'jobs:',
      '  test:',
      '    timeout-minutes: 15',
      '  test-inert:',
      '    timeout-minutes: 2',
      '',
    ].join('\n');

    const result = resolveJobTimeoutMinutes({
      jobName: 'test (inert CI)',
      workflowFile: 'test.yml',
      workflowYamlText: yamlText,
      covered: null,
    });

    assert.equal(result, 2);
  });
});

test('parseJobRecord', async (t) => {
  await t.test('still-running job (completed_at null) returns null', () => {
    const result = parseJobRecord({
      job: {
        name: 'test (ubuntu-latest, 24, shard 1/3)',
        completed_at: null,
        started_at: '2026-08-29T00:00:00Z',
        run_id: 1,
        head_sha: 'abc123',
        runEvent: 'pull_request',
      },
      workflowFile: 'test.yml',
      workflowYamlText: 'jobs:\n  test:\n    timeout-minutes: 15\n',
      covered: null,
    });

    assert.equal(result, null);
  });

  await t.test('untracked job name returns null', () => {
    for (const jobName of ['preflight', 'changes', 'lint-tests']) {
      const result = parseJobRecord({
        job: {
          name: jobName,
          completed_at: '2026-08-29T00:10:00Z',
          started_at: '2026-08-29T00:00:00Z',
          run_id: 1,
          head_sha: 'abc123',
          runEvent: 'pull_request',
        },
        workflowFile: 'test.yml',
        workflowYamlText: 'jobs:\n  test:\n    timeout-minutes: 15\n',
        covered: null,
      });

      assert.equal(result, null, `expected null for job name ${jobName}`);
    }
  });

  await t.test('valid smoke job returns a full record', () => {
    const yamlText = [
      'jobs:',
      '  smoke:',
      '    timeout-minutes: 12',
      '',
    ].join('\n');

    const result = parseJobRecord({
      job: {
        name: 'smoke (ubuntu-latest)',
        started_at: '2026-08-29T00:00:00Z',
        completed_at: '2026-08-29T00:06:00Z',
        run_id: 42,
        head_sha: 'deadbeef',
        runEvent: 'push',
      },
      workflowFile: 'install-smoke.yml',
      workflowYamlText: yamlText,
      covered: null,
    });

    assert.ok(result);
    assert.equal(result.jobName, 'smoke (ubuntu-latest)');
    assert.equal(result.workflowFile, 'install-smoke.yml');
    assert.equal(result.runId, 42);
    assert.equal(result.sha, 'deadbeef');
    assert.equal(result.runEvent, 'push');
    assert.equal(result.timeoutMinutes, 12);
    assert.equal(typeof result.pct, 'number');
  });
});

test('dedupeAgainstHistory', async (t) => {
  await t.test('excludes only the record already present in history', () => {
    const records = [
      { runId: 1, jobName: 'test (ubuntu-latest, 24, shard 1/3)', pct: 0.5 },
      { runId: 2, jobName: 'test (ubuntu-latest, 24, shard 2/3)', pct: 0.6 },
    ];
    const historyText = `${JSON.stringify({ runId: 1, jobName: 'test (ubuntu-latest, 24, shard 1/3)' })}\n`;

    const result = dedupeAgainstHistory(records, historyText);

    assert.equal(result.length, 1);
    assert.equal(result[0].runId, 2);
  });

  await t.test('same runId, different jobName: both kept when history is empty', () => {
    const records = [
      { runId: 1, jobName: 'test (ubuntu-latest, 24, shard 1/3)', pct: 0.5 },
      { runId: 1, jobName: 'test (ubuntu-latest, 24, shard 2/3)', pct: 0.6 },
    ];

    const result = dedupeAgainstHistory(records, '');

    assert.equal(result.length, 2);
  });

  await t.test('malformed history lines are skipped, not thrown', () => {
    const records = [
      { runId: 1, jobName: 'test (ubuntu-latest, 24, shard 1/3)', pct: 0.5 },
      { runId: 2, jobName: 'test (ubuntu-latest, 24, shard 2/3)', pct: 0.6 },
    ];
    const historyText = [
      JSON.stringify({ runId: 1, jobName: 'test (ubuntu-latest, 24, shard 1/3)' }),
      '',
      'not json{',
      '',
    ].join('\n');

    const result = dedupeAgainstHistory(records, historyText);

    assert.equal(result.length, 1);
    assert.equal(result[0].runId, 2);
  });
});

test('buildReportLines', async (t) => {
  await t.test('end-to-end: only tracked+completed jobs produce records', () => {
    const workflowYamlText = [
      'jobs:',
      '  test:',
      '    timeout-minutes: 15',
      '',
    ].join('\n');

    const runs = [
      {
        run: { id: 1, head_sha: 'sha1', event: 'pull_request' },
        jobs: [
          {
            name: 'test (ubuntu-latest, 24, shard 1/3)',
            started_at: '2026-08-29T00:00:00Z',
            completed_at: '2026-08-29T00:05:00Z',
          },
          {
            name: 'test (ubuntu-latest, 24, shard 2/3)',
            started_at: '2026-08-29T00:00:00Z',
            completed_at: null,
          },
          {
            name: 'lint-tests',
            started_at: '2026-08-29T00:00:00Z',
            completed_at: '2026-08-29T00:01:00Z',
          },
        ],
      },
      {
        run: { id: 2, head_sha: 'sha2', event: 'push' },
        jobs: [
          {
            name: 'test (ubuntu-latest, 24, shard 3/3)',
            started_at: '2026-08-29T00:00:00Z',
            completed_at: '2026-08-29T00:07:00Z',
          },
        ],
      },
    ];

    const result = buildReportLines(runs, { workflowFile: 'test.yml', workflowYamlText, covered: null });

    assert.equal(result.length, 2);
    const names = result.map((r) => r.jobName).sort();
    assert.deepEqual(names, [
      'test (ubuntu-latest, 24, shard 1/3)',
      'test (ubuntu-latest, 24, shard 3/3)',
    ]);
    for (const name of names) {
      assert.equal(names.filter((n) => n === name).length, 1);
    }
  });
});

// #5088: GitHub's jobs API reports `completed_at` one second BEFORE
// `started_at` for a job that never executed (every observed case was
// `skipped` or `cancelled`), and a skipped job also carries a `completed_at`.
// parseJobRecord used to hand those timestamps to computeElapsedPct, which
// throws on negative elapsed time — and nothing above it catches, so ONE
// such job discarded the whole scheduled report. A job that never ran has no
// duration to report; a cancelled job that DID run (the timeout-killed case
// this report exists to catch) must still be recorded.
test('parseJobRecord skips jobs that never executed (#5088)', async (t) => {
  const yamlText = 'jobs:\n  test:\n    timeout-minutes: 45\n';
  const parse = (job) => parseJobRecord({
    job: { name: 'test (ubuntu-latest, 24, shard 1/3)', run_id: 7, head_sha: 'abc', runEvent: 'push', ...job },
    workflowFile: 'test.yml',
    workflowYamlText: yamlText,
    covered: null,
  });

  await t.test('skipped job with completed_at 1s before started_at returns null', () => {
    assert.equal(parse({ conclusion: 'skipped', started_at: '2026-09-28T11:19:38Z', completed_at: '2026-09-28T11:19:37Z' }), null);
  });

  await t.test('cancelled-before-start job with inverted timestamps returns null', () => {
    assert.equal(parse({ conclusion: 'cancelled', started_at: '2026-09-28T11:18:56Z', completed_at: '2026-09-28T11:18:55Z' }), null);
  });

  await t.test('skipped job with non-inverted timestamps still returns null', () => {
    assert.equal(parse({ conclusion: 'skipped', started_at: '2026-09-28T11:19:38Z', completed_at: '2026-09-28T11:19:38Z' }), null);
  });

  await t.test('missing or unparseable started_at returns null instead of throwing', () => {
    for (const started_at of [null, undefined, '', 'not-a-date']) {
      assert.equal(parse({ conclusion: 'cancelled', started_at, completed_at: '2026-09-28T11:18:55Z' }), null, String(started_at));
    }
  });

  await t.test('unparseable completed_at returns null instead of throwing', () => {
    assert.equal(parse({ conclusion: 'success', started_at: '2026-09-28T11:00:00Z', completed_at: 'garbage' }), null);
  });

  await t.test('boundary: completed_at == started_at is treated as never executed', () => {
    // One-second timestamp resolution: no job that ran starts and ends in the same second.
    assert.equal(parse({ conclusion: 'cancelled', started_at: '2026-09-28T11:00:00Z', completed_at: '2026-09-28T11:00:00Z' }), null);
  });

  await t.test('a record without a string name returns null instead of throwing', () => {
    for (const name of [undefined, null, 42]) {
      assert.equal(parse({ name, conclusion: 'success', started_at: '2026-09-28T10:00:00Z', completed_at: '2026-09-28T10:10:00Z' }), null, String(name));
    }
  });

  await t.test('boundary: completed_at 1s after started_at is recorded', () => {
    const rec = parse({ conclusion: 'success', started_at: '2026-09-28T11:00:00Z', completed_at: '2026-09-28T11:00:01Z' });
    assert.ok(rec);
    assert.equal(rec.pct, 1000 / (45 * 60000));
  });

  await t.test('a cancelled job that ran to its cap is still recorded (the timeout-killed case)', () => {
    const rec = parse({ conclusion: 'cancelled', started_at: '2026-09-28T10:00:00Z', completed_at: '2026-09-28T10:45:00Z' });
    assert.ok(rec);
    assert.equal(rec.pct, 1);
  });
});

test('buildReportLines keeps every real record when one job never executed (#5088)', () => {
  const yamlText = 'jobs:\n  test:\n    timeout-minutes: 45\n';
  const jobs = [
    { name: 'test (ubuntu-latest, 24, shard 1/3)', conclusion: 'success', started_at: '2026-09-28T10:00:00Z', completed_at: '2026-09-28T10:10:00Z' },
    { name: 'test (ubuntu-latest, 24, shard 2/3)', conclusion: 'skipped', started_at: '2026-09-28T10:00:01Z', completed_at: '2026-09-28T10:00:00Z' },
    { name: 'test (ubuntu-latest, 24, shard 3/3)', conclusion: 'failure', started_at: '2026-09-28T10:00:00Z', completed_at: '2026-09-28T10:20:00Z' },
  ];
  const records = buildReportLines([{ run: { id: 36393086320, head_sha: '9ebd2b006', event: 'schedule' }, jobs }], {
    workflowFile: 'test.yml',
    workflowYamlText: yamlText,
    covered: null,
  });
  assert.deepEqual(records.map((r) => r.jobName), [
    'test (ubuntu-latest, 24, shard 1/3)',
    'test (ubuntu-latest, 24, shard 3/3)',
  ]);
});

/**
 * shard balance (#5101) — Windows conformance shard-balance check.
 * Fixtures follow the GitHub jobs-API shape: `{ run: {id, created_at,
 * head_sha, event}, jobs }` for the pure pipeline (extractShardSamples /
 * evaluateShardBalance), and flat `{id, created_at, head_sha, event}` runs
 * plus a run-id -> jobs map for the impure checkShardBalance orchestration,
 * matching what the real Octokit calls hand back.
 */

const {
  SHARD_BALANCE,
  jobSpanMs,
  median,
  percentile,
  extractShardSamples,
  evaluateShardBalance,
  formatShardBalanceSummary,
  checkShardBalance,
} = require('../scripts/ci-timeout-report.cjs');

function addMs(iso, ms) {
  return new Date(new Date(iso).getTime() + ms).toISOString();
}

function winJobFromMs(i, n, ms, { conclusion = 'success', start = '2026-09-29T10:00:00Z' } = {}) {
  return {
    name: `conformance test (windows-latest, 24, shard ${i}/${n})`,
    conclusion,
    started_at: start,
    completed_at: addMs(start, ms),
  };
}

function winJob(i, n, minutes, opts = {}) {
  return winJobFromMs(i, n, Math.round(minutes * 60000), opts);
}

function runAt(id, createdAt, jobs) {
  return { run: { id, created_at: createdAt, head_sha: `sha${id}`, event: 'push' }, jobs };
}

// Builds `n` runs from one ms-array per shard (shardMsLists[shardIdx][runIdx]),
// spaced `stepMs` apart starting at `base`, so callers can control every
// shard/run combination precisely (constant arrays => constant medians/p90s).
function buildRunsFromShardLists(shardMsLists, { startId = 1, base = '2026-09-29T00:00:00Z', stepMs = 3600000 } = {}) {
  const total = shardMsLists.length;
  const n = shardMsLists[0].length;
  const runs = [];
  for (let k = 0; k < n; k += 1) {
    const id = startId + k;
    const createdAt = addMs(base, k * stepMs);
    const jobs = shardMsLists.map((list, idx) => winJobFromMs(idx + 1, total, list[k], { start: createdAt }));
    runs.push(runAt(id, createdAt, jobs));
  }
  return runs;
}

function constantRuns(n, shardMsValues, opts = {}) {
  return buildRunsFromShardLists(shardMsValues.map((ms) => new Array(n).fill(ms)), opts);
}

test('shard balance (#5101)', async (t) => {
  await t.test('median and percentile use the documented definitions', () => {
    assert.equal(median([5]), 5);
    assert.equal(median([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), 5.5);
    assert.equal(median([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]), 6);

    assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9), 9);
    assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], 0.9), 10);
    assert.equal(percentile([7], 0.9), 7);
  });

  await t.test('jobSpanMs returns null for a job that never executed', () => {
    const normal = winJob(1, 3, 5);
    assert.equal(jobSpanMs(normal), 300000);

    const skipped = winJobFromMs(1, 3, 300000, { conclusion: 'skipped' });
    assert.equal(jobSpanMs(skipped), null);

    const equal = { ...winJob(1, 3, 0) };
    assert.equal(jobSpanMs(equal), null);

    const inverted = {
      name: 'conformance test (windows-latest, 24, shard 1/3)',
      conclusion: 'success',
      started_at: '2026-09-29T10:05:00Z',
      completed_at: '2026-09-29T10:00:00Z',
    };
    assert.equal(jobSpanMs(inverted), null);

    const missing = {
      name: 'conformance test (windows-latest, 24, shard 1/3)',
      conclusion: 'success',
      started_at: null,
      completed_at: '2026-09-29T10:05:00Z',
    };
    assert.equal(jobSpanMs(missing), null);

    const garbage = {
      name: 'conformance test (windows-latest, 24, shard 1/3)',
      conclusion: 'success',
      started_at: 'not-a-date',
      completed_at: 'also-not-a-date',
    };
    assert.equal(jobSpanMs(garbage), null);
  });

  await t.test('extractShardSamples keeps only Windows conformance shards', () => {
    const start = '2026-09-29T10:00:00Z';
    const runs = [runAt(1, start, [
      winJob(1, 3, 20, { start }),
      { name: 'conformance test (macos-latest, 24, shard 1/3)', conclusion: 'success', started_at: start, completed_at: addMs(start, 20 * 60000) },
      { name: 'test (ubuntu-latest, 24, shard 1/3)', conclusion: 'success', started_at: start, completed_at: addMs(start, 20 * 60000) },
      { name: 'conformance test (windows-latest, 24)', conclusion: 'success', started_at: start, completed_at: addMs(start, 20 * 60000) },
    ])];

    const samples = extractShardSamples(runs, SHARD_BALANCE);

    assert.equal(samples.length, 1);
    assert.equal(samples[0].shard, '1/3');
    assert.equal(samples[0].index, 1);
    assert.equal(samples[0].total, 3);
  });

  await t.test('runs before the #5097 merge are excluded', () => {
    const before = runAt(1, '2026-09-28T14:17:50Z', [winJob(1, 3, 20, { start: '2026-09-28T14:17:50Z' })]);
    const atSince = runAt(2, SHARD_BALANCE.since, [winJob(1, 3, 20, { start: SHARD_BALANCE.since })]);

    const samples = extractShardSamples([before, atSince], SHARD_BALANCE);

    assert.equal(samples.length, 1);
    assert.equal(samples[0].runId, 2);
  });

  await t.test('a cancelled shard that ran still counts', () => {
    const start = '2026-09-29T10:00:00Z';
    const cancelledWithSpan = winJobFromMs(1, 3, 44 * 60000, { start, conclusion: 'cancelled' });
    const neverRan = {
      name: 'conformance test (windows-latest, 24, shard 2/3)',
      conclusion: 'skipped',
      started_at: start,
      completed_at: null,
    };
    const runs = [runAt(1, start, [cancelledWithSpan, neverRan])];

    const samples = extractShardSamples(runs, SHARD_BALANCE);

    assert.equal(samples.length, 1);
    assert.equal(samples[0].shard, '1/3');
  });

  await t.test('no samples reports insufficient-data', () => {
    const result = evaluateShardBalance([], SHARD_BALANCE);

    assert.equal(result.status, 'insufficient-data');
    assert.equal(result.runs, 0);
  });

  await t.test('run-count boundary 9, 10, 11', () => {
    const shardMs = [20 * 60000, 20.5 * 60000, 21 * 60000];

    const nine = evaluateShardBalance(extractShardSamples(constantRuns(9, shardMs), SHARD_BALANCE), SHARD_BALANCE);
    assert.equal(nine.status, 'insufficient-data');
    assert.equal(nine.runs, 9);

    const ten = evaluateShardBalance(extractShardSamples(constantRuns(10, shardMs), SHARD_BALANCE), SHARD_BALANCE);
    assert.equal(ten.status, 'ok');
    assert.equal(ten.runs, 10);

    const eleven = evaluateShardBalance(extractShardSamples(constantRuns(11, shardMs), SHARD_BALANCE), SHARD_BALANCE);
    assert.equal(eleven.status, 'ok');
    assert.equal(eleven.runs, 11);
  });

  await t.test('median gap boundary at 2 minutes', () => {
    const okRuns = constantRuns(10, [1200000, 1200000, 1200000 + 120000]);
    const okResult = evaluateShardBalance(extractShardSamples(okRuns, SHARD_BALANCE), SHARD_BALANCE);
    assert.equal(okResult.status, 'ok');
    assert.equal(okResult.gapMs, 120000);

    const breachRuns = constantRuns(10, [1200000, 1200000, 1200000 + 120001]);
    const breachResult = evaluateShardBalance(extractShardSamples(breachRuns, SHARD_BALANCE), SHARD_BALANCE);
    assert.equal(breachResult.status, 'breach');
    assert.equal(breachResult.gapMs, 120001);
    assert.deepEqual(breachResult.breaches.map((b) => [b.kind, b.slowest, b.fastest]), [['gap', '3/3', '1/3']]);
  });

  await t.test('p90 boundary at the shard baseline', () => {
    const shard1AtBaseline = [
      1740000, 1740000, 1740000, 1740000, 1740000,
      1740000, 1740000, 1740000, 1824000, 1824000,
    ];
    const shard1OverBaseline = [
      1740000, 1740000, 1740000, 1740000, 1740000,
      1740000, 1740000, 1740000, 1824001, 1824001,
    ];
    const steadyShard = new Array(10).fill(1740000);

    const okResult = evaluateShardBalance(
      extractShardSamples(buildRunsFromShardLists([shard1AtBaseline, steadyShard, steadyShard]), SHARD_BALANCE),
      SHARD_BALANCE,
    );
    assert.equal(okResult.status, 'ok');

    const breachResult = evaluateShardBalance(
      extractShardSamples(buildRunsFromShardLists([shard1OverBaseline, steadyShard, steadyShard]), SHARD_BALANCE),
      SHARD_BALANCE,
    );
    assert.equal(breachResult.status, 'breach');
    assert.deepEqual(breachResult.breaches.map((b) => [b.kind, b.shard]), [['p90', '1/3']]);
  });

  await t.test('a shard-layout change reports baseline-mismatch', () => {
    const runs = constantRuns(5, [1200000, 1200000, 1200000, 1200000]);

    const result = evaluateShardBalance(extractShardSamples(runs, SHARD_BALANCE), SHARD_BALANCE);

    assert.equal(result.status, 'baseline-mismatch');
  });

  await t.test('mixed layouts use only the newest layout', () => {
    const oldRuns = constantRuns(12, [1200000, 1200000, 1200000], { startId: 1, base: '2026-09-28T15:00:00Z' });
    const newRuns = constantRuns(10, [1200000, 1200000, 1200000, 1200000], { startId: 101, base: '2026-09-29T15:00:00Z' });

    const result = evaluateShardBalance(extractShardSamples([...oldRuns, ...newRuns], SHARD_BALANCE), SHARD_BALANCE);

    assert.equal(result.status, 'baseline-mismatch');
    assert.equal(result.runs, 10);
  });

  await t.test('only the newest windowRuns runs are evaluated', () => {
    const oldUnbalanced = constantRuns(5, [1200000, 1200000, 100 * 60000], { startId: 1, base: '2026-09-27T00:00:00Z' });
    const newBalanced = constantRuns(20, [1200000, 1200000, 1200000], { startId: 101, base: '2026-09-29T00:00:00Z' });

    const result = evaluateShardBalance(
      extractShardSamples([...oldUnbalanced, ...newBalanced], SHARD_BALANCE),
      SHARD_BALANCE,
    );

    assert.equal(result.status, 'ok');
    assert.equal(result.runs, 20);
  });

  await t.test('a run missing one shard still counts its others', () => {
    const runs = constantRuns(10, [1200000, 1200000, 1200000]);
    runs[4].jobs.splice(1, 1); // drop shard 2/3 from the 5th run

    const result = evaluateShardBalance(extractShardSamples(runs, SHARD_BALANCE), SHARD_BALANCE);

    assert.equal(result.runs, 10);
    const shard2 = result.perShard.find((s) => s.shard === '2/3');
    const shard1 = result.perShard.find((s) => s.shard === '1/3');
    const shard3 = result.perShard.find((s) => s.shard === '3/3');
    assert.equal(shard2.n, 9);
    assert.equal(shard1.n, 10);
    assert.equal(shard3.n, 10);
  });

  await t.test('fewer than two populated shards is insufficient-data', () => {
    const runs = [];
    for (let k = 0; k < 10; k += 1) {
      const createdAt = addMs('2026-09-29T00:00:00Z', k * 3600000);
      runs.push(runAt(k + 1, createdAt, [winJobFromMs(1, 3, 1200000, { start: createdAt })]));
    }

    const result = evaluateShardBalance(extractShardSamples(runs, SHARD_BALANCE), SHARD_BALANCE);

    assert.equal(result.status, 'insufficient-data');
  });

  await t.test('the #5071 baseline itself is a breach', () => {
    const runs = constantRuns(10, [25.2 * 60000, 29.0 * 60000, 31.6 * 60000]);

    const result = evaluateShardBalance(extractShardSamples(runs, SHARD_BALANCE), SHARD_BALANCE);

    assert.equal(result.status, 'breach');
    assert.equal(result.gapMs, 384000);
    assert.ok(result.breaches.length >= 1);

    const summary = formatShardBalanceSummary(result);
    assert.equal(typeof summary, 'string');
    assert.ok(summary.length > 0);
  });

  function makeGithub({ runs, jobsByRunId, existingIssues = [], failListRuns = false }) {
    const calls = { create: [], comment: [] };
    const github = {
      paginate: async (fn, params) => fn(params),
      rest: {
        actions: {
          listWorkflowRuns: async () => {
            if (failListRuns) throw new Error('simulated GitHub API failure');
            return runs;
          },
          listJobsForWorkflowRun: async (p) => jobsByRunId[p.run_id],
        },
        search: {
          issuesAndPullRequests: async () => ({ data: { items: existingIssues } }),
        },
        issues: {
          create: async (p) => {
            calls.create.push(p);
            return { data: { number: 999 } };
          },
          createComment: async (p) => {
            calls.comment.push(p);
            return { data: {} };
          },
        },
      },
    };
    return { github, calls };
  }

  function makeCore() {
    const warnings = [];
    const summaries = [];
    const core = {
      warning: (m) => warnings.push(m),
      info() {},
      summary: {
        addRaw(s) {
          summaries.push(s);
          return this;
        },
        write: async () => {},
      },
    };
    return { core, warnings, summaries };
  }

  const context = { repo: { owner: 'open-gsd', repo: 'gsd-core' } };

  function breachFixture() {
    const runs = [];
    const jobsByRunId = {};
    for (let k = 0; k < 10; k += 1) {
      const id = k + 1;
      const createdAt = addMs('2026-09-29T00:00:00Z', k * 3600000);
      runs.push({ id, created_at: createdAt, head_sha: `sha${id}`, event: 'push' });
      jobsByRunId[id] = [
        winJobFromMs(1, 3, 25.2 * 60000, { start: createdAt }),
        winJobFromMs(2, 3, 29.0 * 60000, { start: createdAt }),
        winJobFromMs(3, 3, 31.6 * 60000, { start: createdAt }),
      ];
    }
    return { runs, jobsByRunId };
  }

  await t.test('a breach opens one tracking issue', async () => {
    const { runs, jobsByRunId } = breachFixture();
    const { github, calls } = makeGithub({ runs, jobsByRunId, existingIssues: [] });
    const { core, warnings } = makeCore();

    const result = await checkShardBalance({ github, context, core, config: SHARD_BALANCE });

    assert.equal(result.status, 'breach');
    assert.equal(calls.create.length, 1);
    assert.equal(calls.create[0].title, SHARD_BALANCE.issueTitle);
    assert.ok(calls.create[0].body.length > 0);
    assert.equal(calls.comment.length, 0);
    assert.equal(result.issue.action, 'created');
    assert.equal(result.issue.number, 999);
    assert.equal(warnings.length >= 1, true);
  });

  await t.test('a breach comments on the open tracking issue', async () => {
    const { runs, jobsByRunId } = breachFixture();
    const existingIssues = [{ number: 555, title: SHARD_BALANCE.issueTitle }];
    const { github, calls } = makeGithub({ runs, jobsByRunId, existingIssues });
    const { core } = makeCore();

    const result = await checkShardBalance({ github, context, core, config: SHARD_BALANCE });

    assert.equal(calls.comment.length, 1);
    assert.equal(calls.comment[0].issue_number, 555);
    assert.equal(calls.create.length, 0);
    assert.equal(result.issue.action, 'commented');
    assert.equal(result.issue.number, 555);
  });

  await t.test('ok and insufficient-data write no issue', async () => {
    const okRuns = [];
    const okJobsByRunId = {};
    for (let k = 0; k < 10; k += 1) {
      const id = k + 1;
      const createdAt = addMs('2026-09-29T00:00:00Z', k * 3600000);
      okRuns.push({ id, created_at: createdAt, head_sha: `sha${id}`, event: 'push' });
      okJobsByRunId[id] = [
        winJobFromMs(1, 3, 1200000, { start: createdAt }),
        winJobFromMs(2, 3, 1200000, { start: createdAt }),
        winJobFromMs(3, 3, 1200000, { start: createdAt }),
      ];
    }
    const { github: okGithub, calls: okCalls } = makeGithub({ runs: okRuns, jobsByRunId: okJobsByRunId });
    const { core: okCore } = makeCore();
    const okResult = await checkShardBalance({ github: okGithub, context, core: okCore, config: SHARD_BALANCE });
    assert.equal(okResult.status, 'ok');
    assert.equal(okCalls.create.length, 0);
    assert.equal(okCalls.comment.length, 0);

    const insufficientRuns = okRuns.slice(0, 5);
    const { github: insufficientGithub, calls: insufficientCalls } = makeGithub({
      runs: insufficientRuns,
      jobsByRunId: okJobsByRunId,
    });
    const { core: insufficientCore } = makeCore();
    const insufficientResult = await checkShardBalance({
      github: insufficientGithub, context, core: insufficientCore, config: SHARD_BALANCE,
    });
    assert.equal(insufficientResult.status, 'insufficient-data');
    assert.equal(insufficientCalls.create.length, 0);
    assert.equal(insufficientCalls.comment.length, 0);
  });

  await t.test('an API failure is reported, not thrown', async () => {
    const { core, warnings } = makeCore();
    const { github } = makeGithub({ runs: [], jobsByRunId: {}, failListRuns: true });

    const result = await checkShardBalance({ github, context, core, config: SHARD_BALANCE });

    assert.equal(result.status, 'error');
    assert.equal(warnings.length >= 1, true);
  });
});
