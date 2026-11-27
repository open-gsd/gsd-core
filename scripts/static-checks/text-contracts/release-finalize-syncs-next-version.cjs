'use strict';

// release.yml wires scripts/sync-next-version.cjs into both the rc job (control) and the finalize job after
// publishing, and the step that runs it in finalize is itself gated on !inputs.dry_run (#2423): the finalize job once
// shipped 1.7.0 to npm latest without bumping next, which sat stale at 1.7.0-rc.6 and leaked into every npm script
// banner, and a dry-run finalize must not open a sync PR. The gate is asserted on the specific step, not the whole
// job, so another step's gate cannot satisfy it. Was tests/release-finalize-syncs-next-version.test.cjs.

const SYNC_SCRIPT = 'scripts/sync-next-version.cjs';

// The lines of one top-level job (header to the next job header or column-0 key), or [] when there is no such job.
// The test ended a block only at a column-0 key, so the `rc` block ran on through every later job (jobs sit at column 2)
// and the rc control could be satisfied by the finalize job's own call; here it stops at the next job.
function jobBlock(lines, job) {
  const start = lines.findIndex((line) => line.trimEnd() === `  ${job}:`);
  if (start < 0) return [];
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^ {0,2}[^\s#]/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end);
}

// The lines of the step (`      - name:` to the next one) inside a job that contains `marker`, or [].
function stepContaining(block, marker) {
  const starts = [];
  block.forEach((line, i) => { if (/^\s{6}- name:/.test(line)) starts.push(i); });
  for (let s = 0; s < starts.length; s++) {
    const lines = block.slice(starts[s], s + 1 < starts.length ? starts[s + 1] : block.length);
    if (lines.some((line) => line.includes(marker))) return lines;
  }
  return [];
}

module.exports = {
  id: 'release-finalize-syncs-next-version',
  issue: '#2423',
  check(ctx) {
    ctx.doc('.github/workflows/release.yml')
      .satisfies((text) => {
        const block = jobBlock(text.split('\n'), 'rc');
        return block.length > 0 || "job 'rc' not found in release.yml";
      }, 'the rc job must exist')
      .satisfies((text) => jobBlock(text.split('\n'), 'rc').some((line) => line.includes(SYNC_SCRIPT)), 'the rc job must call scripts/sync-next-version.cjs (control: lost during a refactor?)')
      .satisfies((text) => {
        const block = jobBlock(text.split('\n'), 'finalize');
        return block.length > 0 || "job 'finalize' not found in release.yml";
      }, 'the finalize job must exist')
      .satisfies((text) => jobBlock(text.split('\n'), 'finalize').some((line) => line.includes(SYNC_SCRIPT)), 'the finalize job must call scripts/sync-next-version.cjs after a final release, or next drifts to the rc version the release branch started from')
      .satisfies((text) => {
        const step = stepContaining(jobBlock(text.split('\n'), 'finalize'), SYNC_SCRIPT);
        if (step.length === 0) return 'cannot locate the sync-next-version step within the finalize job: has the step shape changed?';
        return step.some((line) => line.includes('!inputs.dry_run')) || 'the step has no !inputs.dry_run gate';
      }, 'the sync-next-version step itself must be gated on !inputs.dry_run, or a dry-run finalize opens a real sync PR against next');
  },
};
