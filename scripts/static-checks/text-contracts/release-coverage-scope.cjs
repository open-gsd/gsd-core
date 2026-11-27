'use strict';

// release.yml gates the release on the sharded unit-coverage scripts (#4335): no bare full-suite line, no
// unsharded unit line, the raw and report scripts exactly once per job pair; every raw-coverage shard step
// pins AUDIT_BASELINE_REF (#3588/#4196); rc-test and finalize-test keep a job-cap floor of 30 minutes (#5421).
// The floor is the test's own `>= 30`, carried over unchanged: this contract reads a workflow file and
// puts no time limit on any process. Was tests/release-coverage-scope.test.cjs.

const RAW_SHARD = 'npm run test:coverage:unit:raw -- --shard';
const RAW_SHARD_LINE = 'npm run test:coverage:unit:raw -- --shard ${{ matrix.shard }}';
const SHARD_JOB_CAP_FLOOR = 30;

// A line with an optional leading `- ` and `run: ` removed, so a one-line `run: npm run …` step, the same
// step as the first key of a list item (`- run: …`), and a bare command line inside a multi-line `run: |`
// block all count alike. The original stripped only `run: `, so a `- run: …` step escaped it.
const commandLines = (text) => text.split('\n').map((line) => line.trim().replace(/^(?:-[ \t]{1,50})?run:[ \t]{0,50}/, ''));
const countOf = (lines, command) => lines.filter((line) => line === command).length;

module.exports = {
  id: 'release-coverage-scope',
  issue: '#4335',
  check(ctx) {
    ctx.doc('.github/workflows/release.yml')
      .satisfies((text) => {
        const bare = countOf(commandLines(text), 'npm run test:coverage');
        return bare === 0 || `${bare} bare 'npm run test:coverage' line(s), expected 0`;
      }, 'release.yml must not run the bare full-suite coverage command')
      .satisfies((text) => {
        const unsharded = countOf(commandLines(text), 'npm run test:coverage:unit');
        return unsharded === 0 || `${unsharded} unsharded 'npm run test:coverage:unit' line(s), expected 0: rc and finalize shard onto test:coverage:unit:raw + test:coverage:report`;
      }, 'release.yml must not run the unsharded unit-coverage command')
      .satisfies((text) => {
        const raw = countOf(commandLines(text), RAW_SHARD_LINE);
        return raw === 2 || `${raw} sharded raw-coverage line(s), expected 2 (one in rc-test, one in finalize-test)`;
      }, 'release.yml must run the sharded raw-coverage script once in each of rc-test and finalize-test')
      .satisfies((text) => {
        const report = countOf(commandLines(text), 'npm run test:coverage:report');
        return report === 2 || `${report} 'npm run test:coverage:report' line(s), expected 2 (one in rc-coverage-gate, one in finalize-coverage-gate)`;
      }, 'release.yml must run the merged-coverage report once in each of rc-coverage-gate and finalize-coverage-gate')
      .satisfies((text) => {
        const lines = text.split('\n');
        const shardSteps = lines.map((line, i) => (line.includes(RAW_SHARD) ? i : -1)).filter((i) => i >= 0);
        if (shardSteps.length !== 2) return `${shardSteps.length} shard step(s), expected the rc-test and finalize-test steps`;
        for (const i of shardSteps) {
          // The step's env block sits within a few lines above its `run:` script.
          const stepHead = lines.slice(Math.max(0, i - 12), i).join('\n');
          if (!stepHead.includes('AUDIT_BASELINE_REF: ${{ github.sha }}')) return `the shard step at line ${i + 1} must pin AUDIT_BASELINE_REF to github.sha`;
        }
        return true;
      }, 'every sharded unit-test step in release.yml must pin AUDIT_BASELINE_REF')
      .satisfies((text) => {
        const lines = text.split('\n');
        for (const job of ['rc-test', 'finalize-test']) {
          const start = lines.findIndex((line) => line === `  ${job}:`);
          if (start < 0) return `${job} job not found`;
          const end = lines.findIndex((line, i) => i > start && /^ {2}\S/.test(line));
          const body = lines.slice(start, end < 0 ? undefined : end);
          const found = body.map((line) => /^ {4}timeout-minutes:[ \t]{0,50}(\d{1,6})[ \t]{0,50}$/.exec(line)).find(Boolean);
          if (!found) return `${job} must set the job cap`;
          if (Number(found[1]) < SHARD_JOB_CAP_FLOOR) return `${job} job cap must be at least ${SHARD_JOB_CAP_FLOOR} (was ${found[1]})`;
        }
        return true;
      }, 'rc-test and finalize-test shard jobs must keep their job cap at 30 minutes or more');
  },
};
