'use strict';
/**
 * Regression test for bug #1446:
 * total_phases must correct downward when re-derived; shouldPreserveExistingProgress
 * must NOT include total_phases in its ratchet check.
 *
 * Root cause:
 *   shouldPreserveExistingProgress (state-document.cts) returned true when
 *   existingProgress.total_phases > derivedProgress.total_phases, making the
 *   stored value sticky even when it was wrong (e.g. counted backlog phases).
 *
 * Fix:
 *   total_phases is removed from the "existing exceeds derived" check.
 *   Only completed_phases, total_plans, and completed_plans keep ratchet behaviour.
 *
 * Scenarios:
 *   A. shouldPreserveExistingProgress unit test — returns false when only total_phases differs.
 *   B. state sync re-derives a lower total_phases and writes the new value.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');
const { shouldPreserveExistingProgress } = require('../gsd-core/bin/lib/state-document.cjs');

// ─── Scenario A: unit test ───────────────────────────────────────────────────

describe('bug #1446 — shouldPreserveExistingProgress does not ratchet total_phases', () => {
  test('existing total_phases:10 > derived total_phases:7 → returns false (no ratchet)', () => {
    const existing = { total_phases: 10, completed_phases: 3, total_plans: 6, completed_plans: 3 };
    const derived  = { total_phases: 7,  completed_phases: 3, total_plans: 6, completed_plans: 3 };
    assert.equal(
      shouldPreserveExistingProgress(existing, derived),
      false,
      'total_phases downward correction must NOT trigger shouldPreserveExistingProgress',
    );
  });

  test('existing completed_phases:5 > derived completed_phases:2 → returns true (ratchet still active)', () => {
    const existing = { total_phases: 7, completed_phases: 5, total_plans: 6, completed_plans: 3 };
    const derived  = { total_phases: 7, completed_phases: 2, total_plans: 6, completed_plans: 3 };
    assert.equal(
      shouldPreserveExistingProgress(existing, derived),
      true,
      'completed_phases ratchet must still work',
    );
  });

  test('existing total_phases:10 > derived:7 AND completed_phases matches → false (total_phases alone does not preserve)', () => {
    const existing = { total_phases: 10, completed_phases: 3 };
    const derived  = { total_phases: 7,  completed_phases: 3 };
    assert.equal(
      shouldPreserveExistingProgress(existing, derived),
      false,
      'only-total_phases discrepancy must not trigger preservation',
    );
  });

  test('all derived values equal existing → returns false', () => {
    const existing = { total_phases: 7, completed_phases: 3, total_plans: 6, completed_plans: 3 };
    const derived  = { total_phases: 7, completed_phases: 3, total_plans: 6, completed_plans: 3 };
    assert.equal(shouldPreserveExistingProgress(existing, derived), false);
  });
});

// ─── Scenario B: end-to-end state sync overwrites inflated total_phases ──────

describe('bug #1446 — state sync writes corrected (lower) total_phases', () => {
  let tmpDir;

  // ROADMAP has 3 real phases only (no 999.x).
  const ROADMAP = [
    '## Milestone v1.0: Test',
    '',
    '### Phase 01: Alpha',
    '**Goal:** alpha',
    '',
    '### Phase 02: Beta',
    '**Goal:** beta',
    '',
    '### Phase 03: Gamma',
    '**Goal:** gamma',
  ].join('\n');

  beforeEach(() => {
    tmpDir = createTempProject('bug-1446-');
    const planning = path.join(tmpDir, '.planning');
    fs.writeFileSync(path.join(planning, 'ROADMAP.md'), ROADMAP, 'utf-8');

    // STATE.md has a stale inflated total_phases:10 in frontmatter.
    fs.writeFileSync(
      path.join(planning, 'STATE.md'),
      [
        '---',
        'gsd_state_version: 1.0',
        'milestone: v1.0',
        'status: executing',
        'progress:',
        '  total_phases: 10',
        '  completed_phases: 2',
        '  total_plans: 6',
        '  completed_plans: 4',
        '  percent: 40',
        '---',
        '',
        '# GSD State',
        '',
        '## Configuration',
        'Current Phase: 3',
        'Status: Executing Phase 3',
        'Last Activity: 2026-01-01',
        'Progress: [████░░░░░░] 40%',
      ].join('\n'),
      'utf-8',
    );
    fs.writeFileSync(path.join(planning, 'config.json'), '{}', 'utf-8');

    for (const d of ['01-alpha', '02-beta', '03-gamma']) {
      const dir = path.join(planning, 'phases', d);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'PLAN.md'), '# Plan\n', 'utf-8');
      // Mark 01 and 02 as complete (2 summaries)
      if (d !== '03-gamma') {
        fs.writeFileSync(path.join(dir, 'PLAN-SUMMARY.md'), '# Summary\n', 'utf-8');
      }
    }
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('state sync corrects total_phases from 10 to 3', () => {
    const syncResult = runGsdTools(['state', 'sync'], tmpDir);
    assert.ok(syncResult.success, `state sync failed: ${syncResult.error}`);

    const jsonResult = runGsdTools(['state', 'json'], tmpDir);
    assert.ok(jsonResult.success, `state json failed: ${jsonResult.error}`);
    const state = JSON.parse(jsonResult.output);

    assert.ok(state.progress, 'state json must return a progress block');
    assert.equal(
      state.progress.total_phases,
      3,
      `total_phases must be corrected to 3 (derived), not kept at 10 (stale). Got ${state.progress.total_phases}`,
    );
    // completed_phases ratchet still works: existing 2 ≥ disk-derived → keep 2
    assert.ok(
      state.progress.completed_phases >= 2,
      `completed_phases must be at least 2 (ratchet). Got ${state.progress.completed_phases}`,
    );
  });
});
