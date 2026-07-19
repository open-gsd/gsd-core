// allow-test-rule: source-text-is-the-product
// .github/workflows/release.yml is the deployed CI contract; asserting that
// the finalize job wires in scripts/sync-next-version.cjs is only expressible
// against the workflow text. See regression #2423 — the finalize job shipped
// 1.7.0 to npm latest without bumping next, which sat stale at 1.7.0-rc.6 and
// leaked into every npm script banner (e.g. `lint:ci`).

'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const RELEASE_WORKFLOW = path.join(__dirname, '..', '.github', 'workflows', 'release.yml');

/**
 * Extract a top-level job block from a GitHub Actions workflow YAML file.
 *
 * Jobs sit at column 2 (`^  <job>:`). Returns the lines from the job header
 * through the line before the next top-level key (column 0) or the next job.
 * @param {string} text - workflow file text
 * @param {string} jobName - job key to extract
 * @returns {string[]} lines belonging to the job (including its header)
 */
function extractJobBlock(text, jobName) {
  const lines = text.split(/\r?\n/);
  const startIdx = lines.findIndex((l) => new RegExp(`^\\s{2}${jobName}:\\s*$`).test(l));
  assert.ok(startIdx >= 0, `job '${jobName}' not found in release.yml`);
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    // Next top-level key (column 0, non-blank, non-comment) ends the job block.
    if (/^\S/.test(lines[i])) {
      endIdx = i;
      break;
    }
  }
  return lines.slice(startIdx, endIdx);
}

/**
 * Extract the YAML step block (within a job) that contains `marker` text.
 *
 * Steps begin at `^      - name:` (6-space indent for a job at column 2).
 * Returns the lines from the step's `- name:` line through the line before
 * the next `- name:` at the same indent (or end of the job block).
 *
 * Used to assert invariants about a SPECIFIC step rather than the whole job,
 * so a test like "the sync step is gated on !inputs.dry_run" can't pass by
 * accident because some OTHER step in the same job happens to have that gate.
 * @param {string[]} jobBlock - lines of the containing job (from extractJobBlock)
 * @param {string} marker - substring identifying the target step
 * @returns {string[]} lines of the matching step (including its `- name:` header)
 */
function extractStepBlockContaining(jobBlock, marker) {
  const stepStarts = [];
  for (let i = 0; i < jobBlock.length; i++) {
    if (/^\s{6}- name:/.test(jobBlock[i])) {
      stepStarts.push(i);
    }
  }
  for (let s = 0; s < stepStarts.length; s++) {
    const start = stepStarts[s];
    const end = s + 1 < stepStarts.length ? stepStarts[s + 1] : jobBlock.length;
    const stepLines = jobBlock.slice(start, end);
    if (stepLines.some((l) => l.includes(marker))) {
      return stepLines;
    }
  }
  return [];
}

describe('release-finalize-syncs-next-version (regression #2423)', () => {
  const text = fs.readFileSync(RELEASE_WORKFLOW, 'utf8');

  test('the rc job still wires sync-next-version.cjs (control — must not regress)', () => {
    const rcBlock = extractJobBlock(text, 'rc');
    const hits = rcBlock.filter((l) => l.includes('scripts/sync-next-version.cjs'));
    assert.notStrictEqual(hits.length, 0,
      'rc job must call scripts/sync-next-version.cjs (lost during refactor?)');
  });

  test('the finalize job calls scripts/sync-next-version.cjs after publishing', () => {
    const finalizeBlock = extractJobBlock(text, 'finalize');
    const stepLines = finalizeBlock.filter((l) => l.includes('scripts/sync-next-version.cjs'));
    assert.notStrictEqual(stepLines.length, 0,
      [
        'finalize job must call scripts/sync-next-version.cjs to bump next after',
        'a final release (regression #2423). Without it, next drifts to whatever',
        'rc.N version the release branch started from, and every npm script banner',
        'on next (and feature branches cut from it) reports the stale rc version.',
      ].join(' '));
  });

  test('the finalize job gates sync-next-version on !inputs.dry_run', () => {
    // A dry-run finalize must not open a sync PR. We assert this against the
    // SPECIFIC step that runs sync-next-version.cjs (not the whole finalize
    // block) so the test cannot pass by accident if some OTHER step in the
    // finalize job happens to have a !inputs.dry_run gate. Regression of the
    // loose-invariant version of this test, caught during #2423 code review.
    const finalizeBlock = extractJobBlock(text, 'finalize');
    const syncStep = extractStepBlockContaining(finalizeBlock, 'scripts/sync-next-version.cjs');
    assert.notStrictEqual(syncStep.length, 0,
      'cannot locate the sync-next-version step within the finalize job — has the step shape changed?');
    const stepHasGate = syncStep.some((l) => l.includes('!inputs.dry_run'));
    assert.ok(stepHasGate,
      [
        'the sync-next-version step itself must be gated on !inputs.dry_run',
        '(regression of the loose-invariant test that passed when ANY step in',
        'finalize had the gate). Without this guard, a dry-run finalize would',
        'open a real chore: sync next package version PR against next.',
      ].join(' '));
  });
});
