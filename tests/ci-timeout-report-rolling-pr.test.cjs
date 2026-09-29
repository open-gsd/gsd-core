'use strict';

/**
 * tests/ci-timeout-report-rolling-pr.test.cjs
 *
 * The ci-timeout-report bot keeps ONE rolling PR (branch
 * `automation/ci-timeout-report`) instead of opening a new, validator-failing,
 * sibling-conflicting PR per run, and approves it only when it is provably its
 * own tests-data-only PR. Covers the pure pieces the workflow calls:
 *   - historyRecordKey / mergeHistoryTexts (seed the rolling branch's pending
 *     rows so dedupe covers them; shared key with dedupeAgainstHistory)
 *   - evaluateRollingPrApproval (the approve-or-refuse gate)
 *   - ROLLING_PR title/body pass the real PR validators
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fc = require('./helpers/fast-check-setup.cjs');

const {
  HISTORY_PATH,
  historyRecordKey,
  mergeHistoryTexts,
  dedupeAgainstHistory,
  evaluateRollingPrApproval,
  ROLLING_PR,
} = require('../scripts/ci-timeout-report.cjs');
const { evaluatePrTitle } = require('../scripts/release-notes/conventional-title.cjs');
const { evaluateIssueLink } = require('../scripts/require-issue-link-policy.cjs');

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
