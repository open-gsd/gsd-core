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

  test('property: every output line is a valid record and sanitizing is idempotent', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const out = sanitizeHistoryText(s).text;
        for (const l of out.split('\n').filter(Boolean)) {
          assert.equal(isValidHistoryRecord(JSON.parse(l)), true);
        }
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
