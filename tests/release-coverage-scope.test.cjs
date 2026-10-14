// allow-test-rule: source-text-is-the-product
// .github/workflows/release.yml is the deployed CI contract; asserting
// the release-gate test command is only expressible against the workflow text.

'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const RELEASE_WORKFLOW = path.join(__dirname, '..', '.github', 'workflows', 'release.yml');

describe('release-coverage-scope', () => {
  // #4335: rc/finalize used to run one unsharded `npm run test:coverage:unit`
  // line each. Both now shard the unit suite (raw coverage only, one line per
  // *-test job) and gate on a separate merged-coverage job (one report line
  // per *-coverage-gate job) — see rc-test/finalize-test and
  // rc-coverage-gate/finalize-coverage-gate. This asserts the new surface is
  // still unit-scoped end to end: the unsharded single-shot invocation is
  // gone for good (not silently reintroduced), the raw/report scripts appear
  // exactly once per job pair, and no bare full-suite line ever appears.
  test('release.yml uses the sharded unit-coverage scripts (not the unsharded or full suite) in both rc and finalize gates', () => {
    // Normalize an optional leading `run: ` so a single-line `run: npm run
    // …` step (the style rc-coverage-gate/finalize-coverage-gate use) counts
    // the same as a bare command line inside a multi-line `run: |` block
    // (the style the raw-coverage and legacy unit steps use).
    const lines = fs.readFileSync(RELEASE_WORKFLOW, 'utf8').split(/\r?\n/)
      .map(l => l.trim().replace(/^run:\s*/, ''));
    const bareCount = lines.filter(l => l === 'npm run test:coverage').length;
    const unshardedUnitCount = lines.filter(l => l === 'npm run test:coverage:unit').length;
    const rawShardedCount = lines.filter(l => l === 'npm run test:coverage:unit:raw -- --shard ${{ matrix.shard }}').length;
    const reportCount = lines.filter(l => l === 'npm run test:coverage:report').length;

    assert.strictEqual(bareCount, 0,
      `release.yml still has ${bareCount} bare 'npm run test:coverage' line(s); expected 0`);
    assert.strictEqual(unshardedUnitCount, 0,
      `release.yml has ${unshardedUnitCount} unsharded 'npm run test:coverage:unit' line(s); ` +
      'expected 0 — the #4335 fix sharded rc/finalize onto test:coverage:unit:raw + test:coverage:report');
    assert.strictEqual(rawShardedCount, 2,
      `release.yml has ${rawShardedCount} sharded raw-coverage line(s) (one expected in each of ` +
      `rc-test and finalize-test); expected 2`);
    assert.strictEqual(reportCount, 2,
      `release.yml has ${reportCount} 'npm run test:coverage:report' line(s) (one expected in each ` +
      'of rc-coverage-gate and finalize-coverage-gate); expected 2');
  });
});

describe('release-audit-baseline-pin', () => {
  // The #3588/#4196 npm-audit gate runs inside the sharded unit suites. Unset,
  // resolveBaselineRef() falls back to the live origin/next tip, which can move
  // mid-run and flag an already-fixed advisory as "newly introduced" (release
  // run 38549271057). Every raw-coverage shard step must pin it, as test.yml does.
  test('every sharded unit-test step in release.yml pins AUDIT_BASELINE_REF', () => {
    const lines = fs.readFileSync(RELEASE_WORKFLOW, 'utf8').split(/\r?\n/);
    const runLines = lines.map((l, i) => (l.includes('npm run test:coverage:unit:raw -- --shard') ? i : -1))
      .filter(i => i >= 0);
    assert.strictEqual(runLines.length, 2, 'expected rc-test and finalize-test shard steps');
    for (const i of runLines) {
      // The step's env block sits within a few lines above its `run:` script.
      const stepHead = lines.slice(Math.max(0, i - 12), i).join('\n');
      assert.ok(stepHead.includes('AUDIT_BASELINE_REF: ${{ github.sha }}'),
        `shard step at line ${i + 1} must pin AUDIT_BASELINE_REF to github.sha`);
    }
  });
});

describe('release-test-shard-timeout', () => {
  // #5421: shard 1/3 of the sharded unit suites measured ~18.5m of tests plus
  // the coverage upload; a 20m job cap cancelled it mid-upload (run
  // 38609859394). Both *-test shard jobs must keep at least 30m of headroom.
  test('rc-test and finalize-test shard jobs keep timeout-minutes >= 30', () => {
    const lines = fs.readFileSync(RELEASE_WORKFLOW, 'utf8').split(/\r?\n/);
    for (const job of ['rc-test', 'finalize-test']) {
      const start = lines.findIndex(l => l === `  ${job}:`);
      assert.ok(start >= 0, `${job} job not found`);
      const end = lines.findIndex((l, i) => i > start && /^ {2}\S/.test(l));
      const body = lines.slice(start, end < 0 ? undefined : end);
      const m = body.map(l => /^ {4}timeout-minutes:\s*(\d+)\s*$/.exec(l)).find(Boolean);
      assert.ok(m, `${job} must set timeout-minutes`);
      assert.ok(Number(m[1]) >= 30, `${job} timeout-minutes must be >= 30 (was ${m[1]})`);
    }
  });
});
