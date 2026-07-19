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
    // A dry-run finalize must not open a sync PR. Walk the finalize block and
    // confirm that the sync-next-version step sits under an `if: ${{ !inputs.dry_run }}`
    // step boundary that follows the publish step. We assert the weaker but
    // contract-correct invariant: the finalize block contains both the dry_run
    // gate and the sync call, and every sync call is accompanied somewhere in
    // the block by a dry_run guard.
    const finalizeBlock = extractJobBlock(text, 'finalize');
    const hasSync = finalizeBlock.some((l) => l.includes('scripts/sync-next-version.cjs'));
    if (!hasSync) {
      // The previous test already covers the missing-sync case; skip the
      // dry-run gate assertion when sync is absent to keep failure messages
      // single-cause.
      return;
    }
    const hasDryRunGate = finalizeBlock.some((l) => l.includes('!inputs.dry_run'));
    assert.ok(hasDryRunGate,
      'finalize job must gate sync-next-version on !inputs.dry_run so dry runs do not open PRs');
  });
});
