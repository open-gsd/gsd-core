'use strict';

/**
 * Regression test for bug #978: `gsd-tools milestone complete --force` was a
 * dead flag.  The milestone source (src/milestone.cts) has a guard that checks
 * `options.force` and tells users to "Re-run with --force to override", but the
 * CLI dispatcher (gsd-core/bin/gsd-tools.cjs) never parsed `--force` and never
 * passed it into the options object.  So `options.force` was always `undefined`
 * and the guard could never be overridden regardless of what the user typed.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

/**
 * Build a fixture where the guard will fire:
 *  - STATE.md has `milestone: <version>` so the guard's version-match check is
 *    satisfied.
 *  - ROADMAP.md lists a `### Phase 999.1: Backlog Work` heading for that
 *    milestone, but there is NO on-disk phase directory for it.
 *
 * This guarantees "unstarted phase" detection without touching any real phases.
 */
function makeGuardFixture(tmpDir, version) {
  // STATE.md with frontmatter milestone field matching the version
  fs.writeFileSync(
    path.join(tmpDir, '.planning', 'STATE.md'),
    `---\nmilestone: ${version}\n---\n# State\n\n**Status:** In progress\n**Last Activity:** 2025-01-01\n**Last Activity Description:** Working\n`,
  );

  // ROADMAP.md — the heading must include the version so getMilestonePhaseFilter
  // does not return missingExplicitVersion.  Phase 999.1 has no on-disk dir.
  fs.writeFileSync(
    path.join(tmpDir, '.planning', 'ROADMAP.md'),
    `# Roadmap ${version}\n\n### Phase 999.1: Backlog Work\n**Goal:** Not started\n`,
  );
}

describe('bug-978: milestone complete --force overrides unstarted-phase guard', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject('gsd-bug-978-');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('without --force the guard fires and emits the documented error message', () => {
    makeGuardFixture(tmpDir, 'v1.0');

    const result = runGsdTools(
      ['milestone', 'complete', 'v1.0', '--name', 'Regression Test'],
      tmpDir,
    );

    assert.strictEqual(result.success, false, 'command should fail without --force');
    assert.ok(
      result.error.includes('Re-run with --force to override'),
      `expected guard error message; got: ${result.error}`,
    );
  });

  test('with --force the guard is bypassed and the command succeeds', () => {
    makeGuardFixture(tmpDir, 'v1.0');

    const result = runGsdTools(
      ['milestone', 'complete', 'v1.0', '--name', 'Regression Test', '--force'],
      tmpDir,
    );

    assert.ok(
      result.success,
      `command should succeed with --force but failed: ${result.error}`,
    );

    const output = JSON.parse(result.output);
    assert.strictEqual(output.version, 'v1.0');
    // Milestone entry should have been created even though phase 999.1 has no dir
    assert.ok(
      fs.existsSync(path.join(tmpDir, '.planning', 'MILESTONES.md')),
      'MILESTONES.md should have been created',
    );
  });
});
