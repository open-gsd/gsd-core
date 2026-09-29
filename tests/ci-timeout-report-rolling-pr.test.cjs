'use strict';

/**
 * tests/ci-timeout-report-rolling-pr.test.cjs
 *
 * The ci-timeout-report bot keeps ONE rolling PR (branch
 * `chore/4036-ci-timeout-budget-history`) instead of opening a new, validator-failing,
 * sibling-conflicting PR per run, and approves it only when it is provably its
 * own tests-data-only PR. Covers the pure pieces the workflow calls:
 *   - historyRecordKey / mergeHistoryTexts (seed the rolling branch's pending
 *     rows so dedupe covers them; shared key with dedupeAgainstHistory)
 *   - evaluateRollingPrApproval (the approve-or-refuse gate)
 *   - recordKey / isValidHistoryRecord / sanitizeHistoryText (the rolling branch
 *     is untrusted input; only in-schema, bounded rows are seeded)
 *   - subtractHistoryText / matchesApiJob / seedFromRollingPr (a pending row is
 *     seeded only when the Actions API confirms it)
 *   - ROLLING_PR title/body/branch pass the real PR validators
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fc = require('./helpers/fast-check-setup.cjs');

const {
  HISTORY_PATH,
  historyRecordKey,
  recordKey,
  mergeHistoryTexts,
  isValidHistoryRecord,
  sanitizeHistoryText,
  HISTORY_RECORD_LIMITS,
  dedupeAgainstHistory,
  evaluateRollingPrApproval,
  subtractHistoryText,
  matchesApiJob,
  seedFromRollingPr,
  ROLLING_PR,
} = require('../scripts/ci-timeout-report.cjs');
const { evaluatePrTitle } = require('../scripts/release-notes/conventional-title.cjs');
const { evaluateIssueLink } = require('../scripts/require-issue-link-policy.cjs');
const { evaluatePrTemplate } = require('../scripts/pr-template-policy.cjs');

const line = (rec) => `${JSON.stringify(rec)}\n`;
const recA = { runId: 1, jobName: 'test (ubuntu-latest, 24)', pct: 40 };
const recB = { runId: 2, jobName: 'test (ubuntu-latest, 24)', pct: 55 };
const recC = { runId: 2, jobName: 'smoke (macos-latest, 24)', pct: 12 };

describe('historyRecordKey', () => {
  test('complete record → runId::jobName', () => {
    assert.equal(historyRecordKey(JSON.stringify(recA)), '1::test (ubuntu-latest, 24)');
  });

  test('CRLF-terminated line keys the same as LF', () => {
    assert.equal(historyRecordKey(`${JSON.stringify(recA)}\r`), historyRecordKey(JSON.stringify(recA)));
  });

  test('valid JSON that is not an object → null', () => {
    for (const text of ['0', '"str"', '[]', 'null', 'true', '[1,2]']) {
      assert.equal(historyRecordKey(text), null, text);
    }
  });

  test('object missing runId or jobName → null', () => {
    assert.equal(historyRecordKey(JSON.stringify({ jobName: 'x' })), null);
    assert.equal(historyRecordKey(JSON.stringify({ runId: 1 })), null);
    assert.equal(historyRecordKey(JSON.stringify({})), null);
  });

  test('unparseable or blank → null', () => {
    assert.equal(historyRecordKey('{not json'), null);
    assert.equal(historyRecordKey(''), null);
    assert.equal(historyRecordKey('   '), null);
    assert.equal(historyRecordKey(undefined), null);
  });
});

describe('mergeHistoryTexts', () => {
  test('no inputs, empty and non-string inputs → empty string', () => {
    assert.equal(mergeHistoryTexts(), '');
    assert.equal(mergeHistoryTexts('', undefined, null), '');
    assert.equal(mergeHistoryTexts('\n\n  \n'), '');
  });

  test('single input is returned unchanged', () => {
    const text = line(recA) + line(recB);
    assert.equal(mergeHistoryTexts(text), text);
  });

  test('overlap keeps the first occurrence and preserves order', () => {
    const base = line(recA) + line(recB);
    const pending = line(recB) + line(recC);
    assert.equal(mergeHistoryTexts(base, pending), line(recA) + line(recB) + line(recC));
  });

  test('a later duplicate with different fields does not replace the first', () => {
    const changed = { ...recB, pct: 99 };
    assert.equal(mergeHistoryTexts(line(recB), line(changed)), line(recB));
  });

  test('malformed line present in both inputs is kept exactly once', () => {
    const bad = '{"runId":3,"jobName"\n';
    assert.equal(mergeHistoryTexts(line(recA) + bad, bad + line(recB)), line(recA) + bad + line(recB));
  });

  test('two different incomplete records are both kept', () => {
    const i1 = line({ jobName: 'only-name' });
    const i2 = line({ runId: 7 });
    assert.equal(mergeHistoryTexts(i1, i2), i1 + i2);
  });

  test('CRLF input is emitted as LF and deduped against its LF twin', () => {
    const crlf = `${JSON.stringify(recA)}\r\n${JSON.stringify(recB)}\r\n`;
    assert.equal(mergeHistoryTexts(crlf, line(recA)), line(recA) + line(recB));
  });

  test('missing trailing newline on the last line is normalized', () => {
    assert.equal(mergeHistoryTexts(JSON.stringify(recA)), line(recA));
  });

  test('property: idempotent, contains every input key, no duplicate keys', () => {
    const recordArb = fc.record({
      runId: fc.integer({ min: 1, max: 5 }),
      jobName: fc.constantFrom('a', 'b', 'c'),
      pct: fc.integer({ min: 0, max: 100 }),
    });
    const textArb = fc.array(recordArb, { maxLength: 8 }).map((recs) => recs.map(line).join(''));
    fc.assert(
      fc.property(textArb, textArb, (x, y) => {
        const merged = mergeHistoryTexts(x, y);
        assert.equal(mergeHistoryTexts(merged), merged);
        assert.equal(mergeHistoryTexts(merged, x, y), merged);
        const keys = merged.split('\n').filter(Boolean).map(historyRecordKey);
        assert.equal(new Set(keys).size, keys.length);
        for (const l of `${x}${y}`.split('\n').filter(Boolean)) {
          assert.ok(keys.includes(historyRecordKey(l)));
        }
      }),
    );
  });

  test('parity: dedupeAgainstHistory drops exactly the records whose key is already in the merged seed', () => {
    const seed = mergeHistoryTexts(line(recA), line(recB));
    const fresh = [recA, recB, recC, { runId: 9, jobName: 'new' }];
    assert.deepEqual(dedupeAgainstHistory(fresh, seed), [recC, { runId: 9, jobName: 'new' }]);
  });
});

describe('recordKey', () => {
  test('complete object → runId::jobName', () => {
    assert.equal(recordKey(recA), '1::test (ubuntu-latest, 24)');
  });

  test('null, array, primitive, or missing fields → null', () => {
    for (const v of [null, undefined, [], [1, 2], 0, 'str', true, {}, { runId: 1 }, { jobName: 'x' }, { runId: null, jobName: 'x' }]) {
      assert.equal(recordKey(v), null, JSON.stringify(v));
    }
  });

  test('parity with historyRecordKey on the serialized record', () => {
    for (const r of [recA, recB, recC]) {
      assert.equal(historyRecordKey(JSON.stringify(r)), recordKey(r));
    }
  });
});

describe('isValidHistoryRecord', () => {
  const full = () => ({
    runId: 36492786585,
    jobName: 'conformance test (windows-latest, 24, shard 1/3)',
    workflowFile: 'test.yml',
    sha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
    runEvent: 'push',
    completedAt: '2026-09-28T22:00:00Z',
    elapsedMs: 1800000,
    timeoutMinutes: 45,
    pct: 66.7,
  });
  const minimal = () => ({
    runId: 5, jobName: 'j', workflowFile: 'test.yml', elapsedMs: 0, timeoutMinutes: 1, pct: 0,
  });

  test('full and minimal valid records → true', () => {
    assert.equal(isValidHistoryRecord(full()), true);
    assert.equal(isValidHistoryRecord(minimal()), true);
    assert.equal(isValidHistoryRecord({ ...full(), sha: null, runEvent: null, completedAt: null }), true);
  });

  test('non-objects → false', () => {
    for (const v of [null, undefined, [], 'x', 1, true]) {
      assert.equal(isValidHistoryRecord(v), false, String(v));
    }
  });

  test('each out-of-schema field value → false', () => {
    const bad = [
      { evil: 1 },
      { runId: 0 }, { runId: -1 }, { runId: 1.5 }, { runId: '1' }, { runId: 2 ** 53 },
      { jobName: '' }, { jobName: 'a'.repeat(201) }, { jobName: 'a\nb' },
      { workflowFile: '../x.yml' }, { workflowFile: 'x.sh' },
      { sha: 'abc' },
      { runEvent: 'Push!' },
      { completedAt: 'not a date' },
      { elapsedMs: -1 }, { elapsedMs: Infinity }, { elapsedMs: '5' },
      { timeoutMinutes: 0 },
      { pct: NaN },
    ];
    for (const override of bad) {
      assert.equal(isValidHistoryRecord({ ...full(), ...override }), false, JSON.stringify(override));
    }
  });

  test('jobName length boundary: 199 and 200 valid, 201 invalid', () => {
    assert.equal(isValidHistoryRecord({ ...full(), jobName: 'a'.repeat(199) }), true);
    assert.equal(isValidHistoryRecord({ ...full(), jobName: 'a'.repeat(200) }), true);
    assert.equal(isValidHistoryRecord({ ...full(), jobName: 'a'.repeat(201) }), false);
  });
});

describe('sanitizeHistoryText', () => {
  const valid = (runId, jobName = 'j') => ({
    runId, jobName, workflowFile: 'test.yml', elapsedMs: 10, timeoutMinutes: 5, pct: 3,
  });

  test('mix of valid, invalid, blank, and CRLF lines keeps only valid ones', () => {
    const text = [
      JSON.stringify(valid(1)),
      '',
      '{not json',
      JSON.stringify({ ...valid(2), evil: true }),
      JSON.stringify(valid(3)),
      '   ',
      JSON.stringify([1, 2]),
    ].join('\r\n');
    assert.deepEqual(sanitizeHistoryText(text), {
      text: line(valid(1)) + line(valid(3)),
      kept: 2,
      dropped: 3,
    });
  });

  test('line length boundary: length-1 and length kept, length+1 dropped', () => {
    const base = valid(1);
    const len = JSON.stringify(base).length;
    const opts = { maxLineLength: len, maxLines: 10 };
    const minusOne = { ...base, elapsedMs: 1 };
    const plusOne = { ...base, jobName: 'jj' };
    assert.equal(JSON.stringify(minusOne).length, len - 1);
    assert.equal(JSON.stringify(plusOne).length, len + 1);
    assert.deepEqual(sanitizeHistoryText(JSON.stringify(minusOne), opts), { text: line(minusOne), kept: 1, dropped: 0 });
    assert.deepEqual(sanitizeHistoryText(JSON.stringify(base), opts), { text: line(base), kept: 1, dropped: 0 });
    assert.deepEqual(sanitizeHistoryText(JSON.stringify(plusOne), opts), { text: '', kept: 0, dropped: 1 });
  });

  test('maxLines boundary: 1 and 2 valid records kept, the 3rd dropped', () => {
    const opts = { maxLineLength: 1024, maxLines: 2 };
    const recs = [valid(1), valid(2), valid(3)];
    const run = (n) => sanitizeHistoryText(recs.slice(0, n).map(line).join(''), opts);
    assert.deepEqual([run(1).kept, run(1).dropped], [1, 0]);
    assert.deepEqual([run(2).kept, run(2).dropped], [2, 0]);
    assert.deepEqual([run(3).kept, run(3).dropped], [2, 1]);
    assert.equal(run(3).text, line(recs[0]) + line(recs[1]));
  });

  test('duplicate valid records are deduped and kept counts the deduped output', () => {
    const result = sanitizeHistoryText(line(valid(1)) + line(valid(1)) + line(valid(2)));
    assert.deepEqual(result, { text: line(valid(1)) + line(valid(2)), kept: 2, dropped: 0 });
  });

  test('non-string input → empty result', () => {
    for (const v of [undefined, null, 5, {}, []]) {
      assert.deepEqual(sanitizeHistoryText(v), { text: '', kept: 0, dropped: 0 });
    }
  });

  test('default limits are the exported frozen HISTORY_RECORD_LIMITS', () => {
    assert.deepEqual({ ...HISTORY_RECORD_LIMITS }, { maxLineLength: 1024, maxLines: 20000 });
    assert.equal(Object.isFrozen(HISTORY_RECORD_LIMITS), true);
  });

  test('property: valid rows mixed with junk keep exactly the distinct valid keys, all valid, idempotent', () => {
    const validRecordLineArb = fc.record({
      runId: fc.integer({ min: 1, max: 6 }),
      jobName: fc.constantFrom('a', 'b', 'c'),
      workflowFile: fc.constantFrom('test.yml', 'mutation.yml'),
      elapsedMs: fc.integer({ min: 0, max: 100000 }),
      timeoutMinutes: fc.integer({ min: 1, max: 60 }),
      pct: fc.integer({ min: 0, max: 100 }),
    }).map((rec) => JSON.stringify(rec));
    const linesArb = fc.array(fc.oneof(validRecordLineArb, fc.string()), { maxLength: 12 });
    fc.assert(
      fc.property(linesArb, (lines) => {
        const input = lines.join('\n');
        const out = sanitizeHistoryText(input).text;
        const outLines = out.split('\n').filter(Boolean);
        for (const l of outLines) {
          assert.equal(isValidHistoryRecord(JSON.parse(l)), true);
        }
        const validKeys = new Set();
        for (const raw of input.split(/\r?\n/)) {
          let rec;
          try {
            rec = JSON.parse(raw);
          } catch {
            continue;
          }
          if (isValidHistoryRecord(rec)) validKeys.add(recordKey(rec));
        }
        assert.ok(lines.length < HISTORY_RECORD_LIMITS.maxLines);
        assert.equal(outLines.length, validKeys.size);
        assert.equal(sanitizeHistoryText(out).text, out);
      }),
    );
  });

  test('property: same invariants over texts mixing valid rows and junk', () => {
    const lineArb = fc.oneof(
      fc.integer({ min: 1, max: 5 }).map((n) => JSON.stringify(valid(n))),
      fc.string(),
    );
    fc.assert(
      fc.property(fc.array(lineArb, { maxLength: 8 }), (lines) => {
        const out = sanitizeHistoryText(lines.join('\n')).text;
        assert.equal(sanitizeHistoryText(out).text, out);
        for (const l of out.split('\n').filter(Boolean)) {
          assert.equal(isValidHistoryRecord(JSON.parse(l)), true);
        }
      }),
    );
  });
});

describe('subtractHistoryText', () => {
  test('removes rows present in the base, keeps the rest in order', () => {
    assert.equal(subtractHistoryText(line(recA) + line(recB) + line(recC), line(recB)), line(recA) + line(recC));
  });

  test('identity is the record key, not the exact text', () => {
    assert.equal(subtractHistoryText(line({ ...recA, pct: 99 }), line(recA)), '');
  });

  test('CRLF input is normalized and matched against an LF base', () => {
    const crlf = `${JSON.stringify(recA)}\r\n${JSON.stringify(recB)}\r\n`;
    assert.equal(subtractHistoryText(crlf, line(recA)), line(recB));
  });

  test('malformed lines are identified by exact text', () => {
    const bad = '{"runId":3,"jobName"';
    const other = '{"runId":4,"jobName"';
    assert.equal(subtractHistoryText(`${bad}\n${other}\n`, `${bad}\n`), `${other}\n`);
  });

  test('empty and non-string inputs → empty string or the deduped text', () => {
    assert.equal(subtractHistoryText('', line(recA)), '');
    assert.equal(subtractHistoryText(undefined, undefined), '');
    assert.equal(subtractHistoryText(null, 5), '');
    assert.equal(subtractHistoryText(line(recA), undefined), line(recA));
    assert.equal(subtractHistoryText(line(recA), {}), line(recA));
  });

  test('duplicates within the text are emitted once', () => {
    assert.equal(subtractHistoryText(line(recA) + line(recA) + line(recB), ''), line(recA) + line(recB));
  });

  test('everything already in the base → empty string', () => {
    assert.equal(subtractHistoryText(line(recA) + line(recB), line(recB) + line(recA)), '');
  });
});

const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const apiRec = (overrides = {}) => ({
  runId: 900,
  jobName: 'test (ubuntu-latest, 24)',
  workflowFile: 'test.yml',
  sha: SHA,
  runEvent: 'push',
  completedAt: '2026-09-28T22:00:00Z',
  elapsedMs: 60000,
  timeoutMinutes: 45,
  pct: 60000 / 2700000,
  ...overrides,
});
const apiRun = (overrides = {}) => ({ id: 900, path: '.github/workflows/test.yml', head_sha: SHA, ...overrides });
const apiJob = (overrides = {}) => ({
  name: 'test (ubuntu-latest, 24)',
  conclusion: 'success',
  started_at: '2026-09-28T21:59:00Z',
  completed_at: '2026-09-28T22:00:00Z',
  ...overrides,
});

describe('matchesApiJob', () => {
  test('exact match → true', () => {
    assert.equal(matchesApiJob(apiRec(), { run: apiRun(), job: apiJob() }), true);
  });

  test('each single-field mismatch → false', () => {
    const rec = apiRec();
    assert.equal(matchesApiJob(rec, { run: apiRun({ id: 901 }), job: apiJob() }), false, 'run.id');
    assert.equal(matchesApiJob(rec, { run: apiRun({ path: '.github/workflows/mutation.yml' }), job: apiJob() }), false, 'run.path');
    assert.equal(matchesApiJob(rec, { run: apiRun(), job: apiJob({ name: 'other' }) }), false, 'job.name');
    assert.equal(matchesApiJob(rec, { run: apiRun(), job: apiJob({ completed_at: '2026-09-28T22:00:01Z' }) }), false, 'completed_at');
    assert.equal(matchesApiJob(rec, { run: apiRun(), job: apiJob({ started_at: '2026-09-28T21:59:00.001Z' }) }), false, 'span -1ms');
    assert.equal(matchesApiJob(rec, { run: apiRun(), job: apiJob({ started_at: '2026-09-28T21:58:59.999Z' }) }), false, 'span +1ms');
    assert.equal(matchesApiJob(rec, { run: apiRun({ head_sha: 'b'.repeat(40) }), job: apiJob() }), false, 'head_sha');
  });

  test('a record without a sha ignores head_sha', () => {
    const noSha = apiRec({ sha: null });
    assert.equal(matchesApiJob(noSha, { run: apiRun({ head_sha: 'b'.repeat(40) }), job: apiJob() }), true);
    const absent = apiRec();
    delete absent.sha;
    assert.equal(matchesApiJob(absent, { run: apiRun({ head_sha: undefined }), job: apiJob() }), true);
  });

  test('run.path is compared by basename (nested or bare)', () => {
    assert.equal(matchesApiJob(apiRec(), { run: apiRun({ path: '.github/workflows/test.yml' }), job: apiJob() }), true);
    assert.equal(matchesApiJob(apiRec(), { run: apiRun({ path: 'test.yml' }), job: apiJob() }), true);
    assert.equal(matchesApiJob(apiRec(), { run: apiRun({ path: undefined }), job: apiJob() }), false);
  });

  test('a skipped or never-executed API job cannot confirm a row', () => {
    assert.equal(matchesApiJob(apiRec(), { run: apiRun(), job: apiJob({ conclusion: 'skipped' }) }), false);
  });

  test('missing run or job → false', () => {
    assert.equal(matchesApiJob(apiRec(), { job: apiJob() }), false);
    assert.equal(matchesApiJob(apiRec(), { run: apiRun() }), false);
    assert.equal(matchesApiJob(apiRec(), {}), false);
    assert.equal(matchesApiJob(apiRec()), false);
    assert.equal(matchesApiJob(apiRec(), { run: null, job: null }), false);
  });
});

describe('seedFromRollingPr', () => {
  const OWNER = 'open-gsd';
  const REPO = 'gsd-core';
  const PR_HEAD_SHA = 'c'.repeat(40);
  const context = { repo: { owner: OWNER, repo: REPO } };
  const historyPath = '/virtual/ci-timeout-budget-history.jsonl';

  const ownPr = (overrides = {}) => ({
    number: 77,
    head: { ref: ROLLING_PR.branch, sha: PR_HEAD_SHA, repo: { full_name: `${OWNER}/${REPO}` } },
    ...overrides,
  });

  // apis: Map<runId, { run, jobs } | 404 | Error>
  function makeEnv({
    prs = [ownPr()], branchText = '', baseText = null, apis = new Map(), contentError = null,
  }) {
    const files = new Map();
    if (baseText !== null) files.set(historyPath, baseText);
    const calls = { getWorkflowRun: [], listJobs: [], writes: 0 };
    const httpError = (status) => Object.assign(new Error(`HTTP ${status}`), { status });
    const listJobsForWorkflowRun = async (params) => {
      calls.listJobs.push(params.run_id);
      const api = apis.get(params.run_id);
      if (typeof api === 'number') throw httpError(api);
      return { data: { jobs: api.jobs } };
    };
    const github = {
      rest: {
        pulls: { list: async () => ({ data: prs }) },
        repos: {
          getContent: async (params) => {
            assert.equal(params.ref, PR_HEAD_SHA);
            assert.equal(params.path, ROLLING_PR.historyFile);
            if (contentError) throw contentError;
            return { data: branchText };
          },
        },
        actions: {
          getWorkflowRun: async (params) => {
            calls.getWorkflowRun.push(params.run_id);
            const api = apis.get(params.run_id);
            if (typeof api === 'number') throw httpError(api);
            if (api instanceof Error) throw api;
            return { data: api.run };
          },
          listJobsForWorkflowRun,
        },
      },
      paginate: async (fn, params) => {
        const res = await fn(params);
        return res.data.jobs || res.data;
      },
    };
    const logged = { info: [], warning: [] };
    const core = {
      info: (m) => logged.info.push(m),
      warning: (m) => logged.warning.push(m),
    };
    const fsStub = {
      readFileSync: (p) => {
        if (!files.has(p)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return files.get(p);
      },
      writeFileSync: (p, text) => {
        calls.writes += 1;
        files.set(p, text);
      },
    };
    const run = (extra = {}) => seedFromRollingPr({
      github, context, core, historyPath, fs: fsStub, ...extra,
    });
    return {
      run, files, calls, logged,
    };
  }

  const baseRows = line(recA) + line(recB);
  const apiFor = (...recs) => new Map(recs.map((r) => [r.runId, {
    run: apiRun({ id: r.runId }),
    jobs: [apiJob({ name: r.jobName })],
  }]));

  test('no open PR → no-pr, nothing written', async () => {
    const env = makeEnv({ prs: [], baseText: baseRows });
    assert.deepEqual(await env.run(), { status: 'no-pr', candidate: 0, verified: 0, dropped: 0 });
    assert.equal(env.calls.writes, 0);
  });

  test('PR from a fork (head.repo differs) or another branch → no-pr', async () => {
    const fork = ownPr({ head: { ref: ROLLING_PR.branch, sha: PR_HEAD_SHA, repo: { full_name: 'evil/gsd-core' } } });
    const other = ownPr({ head: { ref: 'other', sha: PR_HEAD_SHA, repo: { full_name: `${OWNER}/${REPO}` } } });
    const gone = ownPr({ head: { ref: ROLLING_PR.branch, sha: PR_HEAD_SHA, repo: null } });
    for (const pr of [fork, other, gone]) {
      const env = makeEnv({ prs: [pr] });
      assert.equal((await env.run()).status, 'no-pr');
      assert.equal(env.calls.writes, 0);
    }
  });

  test('history file missing at the PR head (404) → no-file', async () => {
    const env = makeEnv({ contentError: Object.assign(new Error('nf'), { status: 404 }) });
    assert.deepEqual(await env.run(), {
      status: 'no-file', pr: 77, candidate: 0, verified: 0, dropped: 0,
    });
    assert.equal(env.calls.writes, 0);
  });

  test('any other getContent failure rejects so the step fails', async () => {
    const env = makeEnv({ contentError: Object.assign(new Error('boom'), { status: 500 }) });
    await assert.rejects(env.run(), /boom/);
    assert.equal(env.calls.writes, 0);
  });

  test('two pending rows both confirmed by the API are seeded after the base', async () => {
    const p1 = apiRec({ runId: 901 });
    const p2 = apiRec({ runId: 902, jobName: 'smoke (ubuntu-latest, 24)', workflowFile: 'test.yml' });
    const env = makeEnv({
      baseText: baseRows, branchText: baseRows + line(p1) + line(p2), apis: apiFor(p1, p2),
    });
    assert.deepEqual(await env.run(), {
      status: 'seeded', pr: 77, candidate: 2, verified: 2, dropped: 0,
    });
    assert.equal(env.files.get(historyPath), baseRows + line(p1) + line(p2));
    assert.deepEqual(env.logged.warning, []);
  });

  test('a forged row (span differs from the API job) is dropped, the real one seeded, one warning', async () => {
    const real = apiRec({ runId: 901 });
    const forged = apiRec({ runId: 902, elapsedMs: 61000 });
    const env = makeEnv({
      baseText: baseRows, branchText: baseRows + line(real) + line(forged), apis: apiFor(real, apiRec({ runId: 902 })),
    });
    assert.deepEqual(await env.run(), {
      status: 'seeded', pr: 77, candidate: 2, verified: 1, dropped: 1,
    });
    assert.equal(env.files.get(historyPath), baseRows + line(real));
    assert.equal(env.logged.warning.length, 1);
    assert.match(env.logged.warning[0], /dropped 1 pending row/);
  });

  test('a pending row whose run 404s is dropped with a warning', async () => {
    const real = apiRec({ runId: 901 });
    const ghost = apiRec({ runId: 902 });
    const apis = apiFor(real);
    apis.set(902, 404);
    const env = makeEnv({ baseText: baseRows, branchText: baseRows + line(real) + line(ghost), apis });
    assert.deepEqual(await env.run(), {
      status: 'seeded', pr: 77, candidate: 2, verified: 1, dropped: 1,
    });
    assert.equal(env.files.get(historyPath), baseRows + line(real));
    assert.equal(env.logged.warning.length, 1);
  });

  test('a non-404 API failure while verifying rejects', async () => {
    const real = apiRec({ runId: 901 });
    const apis = new Map([[901, Object.assign(new Error('rate limited'), { status: 403 })]]);
    const env = makeEnv({ baseText: baseRows, branchText: baseRows + line(real), apis });
    await assert.rejects(env.run(), /rate limited/);
    assert.equal(env.calls.writes, 0);
  });

  test('an out-of-schema pending row is dropped without ever reaching the API', async () => {
    const real = apiRec({ runId: 901 });
    const evil = { ...apiRec({ runId: 903 }), evil: true };
    const env = makeEnv({ baseText: baseRows, branchText: baseRows + line(evil) + line(real), apis: apiFor(real) });
    assert.deepEqual(await env.run(), {
      status: 'seeded', pr: 77, candidate: 1, verified: 1, dropped: 1,
    });
    assert.deepEqual(env.calls.getWorkflowRun, [901]);
    assert.equal(env.logged.warning.length, 1);
  });

  test('maxRuns boundary: 3 pending runs with maxRuns 2 drop the 3rd; maxRuns 3 verifies all', async () => {
    const recs = [901, 902, 903].map((runId) => apiRec({ runId }));
    const branchText = baseRows + recs.map(line).join('');

    const limited = makeEnv({ baseText: baseRows, branchText, apis: apiFor(...recs) });
    assert.deepEqual(await limited.run({ maxRuns: 2 }), {
      status: 'seeded', pr: 77, candidate: 3, verified: 2, dropped: 1,
    });
    assert.deepEqual(limited.calls.getWorkflowRun, [901, 902]);
    assert.equal(limited.files.get(historyPath), baseRows + line(recs[0]) + line(recs[1]));
    assert.equal(limited.logged.warning.length, 1);

    const exact = makeEnv({ baseText: baseRows, branchText, apis: apiFor(...recs) });
    assert.deepEqual(await exact.run({ maxRuns: 3 }), {
      status: 'seeded', pr: 77, candidate: 3, verified: 3, dropped: 0,
    });
    assert.equal(exact.files.get(historyPath), baseRows + recs.map(line).join(''));
    assert.deepEqual(exact.logged.warning, []);
  });

  test('base rows in the branch file are never re-verified; only pending runs hit the API', async () => {
    const p1 = apiRec({ runId: 901 });
    const p2 = apiRec({ runId: 902 });
    const env = makeEnv({ baseText: baseRows, branchText: baseRows + line(p1) + line(p2), apis: apiFor(p1, p2) });
    await env.run();
    assert.deepEqual(env.calls.getWorkflowRun, [901, 902]);
    assert.deepEqual(env.calls.listJobs, [901, 902]);
  });

  test('newest pending rows survive a large next history (cap applies to pending rows only)', async () => {
    const pending = apiRec({ runId: 901 });
    const bigBase = Array.from({ length: 50 }, (_, i) => line({ ...recA, runId: 1000 + i })).join('');
    const env = makeEnv({ baseText: bigBase, branchText: bigBase + line(pending), apis: apiFor(pending) });
    const result = await env.run();
    assert.equal(result.verified, 1);
    assert.equal(env.files.get(historyPath), bigBase + line(pending));
  });

  test('nothing verified → history file untouched', async () => {
    const forged = apiRec({ runId: 901, jobName: 'not-a-real-job' });
    const env = makeEnv({ baseText: baseRows, branchText: baseRows + line(forged), apis: apiFor(apiRec({ runId: 901 })) });
    const result = await env.run();
    assert.deepEqual([result.verified, result.dropped], [0, 1]);
    assert.equal(env.calls.writes, 0);
    assert.equal(env.files.get(historyPath), baseRows);
  });

  test('a missing local history file is treated as empty', async () => {
    const p1 = apiRec({ runId: 901 });
    const env = makeEnv({ baseText: null, branchText: line(p1), apis: apiFor(p1) });
    assert.equal((await env.run()).verified, 1);
    assert.equal(env.files.get(historyPath), line(p1));
  });
});

describe('evaluateRollingPrApproval', () => {
  const OID = 'a'.repeat(40);
  const goodPr = () => ({
    state: 'OPEN',
    baseRefName: 'next',
    headRefName: ROLLING_PR.branch,
    headRefOid: OID,
    isCrossRepository: false,
    files: [{ path: ROLLING_PR.historyFile }],
  });
  const decide = (pr, expectedHeadOid = OID) => evaluateRollingPrApproval({ pr, expectedHeadOid });

  test('our own rolling PR with exactly the history file → approve', () => {
    assert.deepEqual(decide(goodPr()), { approve: true, reason: 'ok' });
  });

  test('fork PR with the same branch name → refuse', () => {
    assert.deepEqual(decide({ ...goodPr(), isCrossRepository: true }), { approve: false, reason: 'cross-repository' });
  });

  test('isCrossRepository absent is treated as untrusted → refuse', () => {
    const pr = goodPr();
    delete pr.isCrossRepository;
    assert.deepEqual(decide(pr), { approve: false, reason: 'cross-repository' });
  });

  test('different head branch → refuse', () => {
    assert.deepEqual(
      decide({ ...goodPr(), headRefName: `${ROLLING_PR.branch}-2` }),
      { approve: false, reason: 'wrong-branch' },
    );
  });

  test('base is not next → refuse', () => {
    assert.deepEqual(decide({ ...goodPr(), baseRefName: 'main' }), { approve: false, reason: 'wrong-base' });
  });

  test('head moved after our push → refuse', () => {
    assert.deepEqual(decide({ ...goodPr(), headRefOid: 'b'.repeat(40) }), { approve: false, reason: 'head-moved' });
  });

  test('PR not open → refuse', () => {
    for (const state of ['CLOSED', 'MERGED']) {
      assert.deepEqual(decide({ ...goodPr(), state }), { approve: false, reason: 'not-open' });
    }
  });

  test('file count boundary: 0 and 2 refuse, 1 approves', () => {
    assert.deepEqual(decide({ ...goodPr(), files: [] }), { approve: false, reason: 'unexpected-files' });
    assert.deepEqual(decide(goodPr()), { approve: true, reason: 'ok' });
    assert.deepEqual(
      decide({ ...goodPr(), files: [{ path: ROLLING_PR.historyFile }, { path: 'scripts/x.cjs' }] }),
      { approve: false, reason: 'unexpected-files' },
    );
  });

  test('one file that is not the history file → refuse', () => {
    assert.deepEqual(
      decide({ ...goodPr(), files: [{ path: '.github/workflows/test.yml' }] }),
      { approve: false, reason: 'unexpected-files' },
    );
  });

  test('backslash-separated history path is normalized → approve', () => {
    const pr = { ...goodPr(), files: [{ path: ROLLING_PR.historyFile.replace(/\//g, '\\') }] };
    assert.deepEqual(decide(pr), { approve: true, reason: 'ok' });
  });

  test('missing pr or expected oid → missing-input; missing files → unexpected-files', () => {
    assert.deepEqual(decide(null), { approve: false, reason: 'missing-input' });
    assert.deepEqual(decide(goodPr(), ''), { approve: false, reason: 'missing-input' });
    assert.deepEqual(evaluateRollingPrApproval(), { approve: false, reason: 'missing-input' });
    const pr = goodPr();
    delete pr.files;
    assert.deepEqual(decide(pr), { approve: false, reason: 'unexpected-files' });
  });
});

describe('ROLLING_PR title and body pass the real PR validators', () => {
  test('title satisfies the conventional-title gate', () => {
    assert.deepEqual(evaluatePrTitle({ title: ROLLING_PR.title }), { valid: true, reason: 'valid' });
  });

  test('body satisfies require-issue-link for a tests-only diff', () => {
    const result = evaluateIssueLink({
      prBody: ROLLING_PR.body,
      headRef: ROLLING_PR.branch,
      sameRepo: true,
      authorLogin: 'trek-e',
      changedFiles: [ROLLING_PR.historyFile],
      changedFilesTotal: 1,
    });
    assert.equal(result.ok, true, JSON.stringify(result));
  });

  test('body passes the PR template check via the exempt marker for any author association', () => {
    for (const assoc of ['MEMBER', 'NONE']) {
      const result = evaluatePrTemplate(ROLLING_PR.body, assoc, [ROLLING_PR.historyFile], 1);
      assert.equal(result.valid, true, assoc);
      assert.equal(result.action, 'pass', assoc);
      assert.equal(result.skipped, 'exempt-marker', assoc);
    }
  });

  test('branch uses an allowed chore/ prefix', () => {
    assert.ok(ROLLING_PR.branch.startsWith('chore/'));
    assert.match(ROLLING_PR.branch, /^chore\/\d+-[a-z0-9-]+$/);
  });

  test('history file is the same path main() writes', () => {
    assert.equal(
      path.relative(path.join(__dirname, '..'), HISTORY_PATH).replace(/\\/g, '/'),
      ROLLING_PR.historyFile,
    );
  });

  test('base is next', () => {
    assert.equal(ROLLING_PR.base, 'next');
  });
});
