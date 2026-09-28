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
