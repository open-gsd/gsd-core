/**
 * Bug #500: `state planned-phase` corrupts STATE.md milestone progress.* counters.
 *
 * Two independent defects:
 *
 * RC1 — plan-phase resyncs progress it should not touch.
 *   cmdStatePlannedPhase wrote via writeStateMd, which unconditionally runs
 *   syncStateFrontmatter and rebuilds progress.* from a half-planned disk
 *   snapshot, trampling curated counters. It must route through
 *   readModifyWriteStateMd(..., { resync: false }) like other body-only writes.
 *
 * RC2 — isRootPlanFile double-counts legacy `<N>-PLAN-<NN>-SUMMARY.md` as a plan.
 *   The final `/PLAN/i` fallback matches the substring "PLAN" inside a legacy
 *   summary name, so a 4-plan/4-summary phase scans as planCount:8 / completed:false
 *   instead of planCount:4 / completed:true. A summary is never a plan.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');
const planScan = require('../gsd-core/bin/lib/plan-scan.cjs');
const { isRootPlanFile, scanPhasePlans } = planScan;

describe('isRootPlanFile does not count legacy summaries as plans (#500 RC2)', () => {
  test('legacy <N>-PLAN-<NN>-SUMMARY.md is not a root plan file', () => {
    assert.equal(isRootPlanFile('14-PLAN-01-SUMMARY.md'), false);
  });

  test('legacy <N>-PLAN-<NN>.md is still a root plan file', () => {
    assert.equal(isRootPlanFile('14-PLAN-01.md'), true);
  });

  test('canonical -PLAN.md is still a root plan file', () => {
    assert.equal(isRootPlanFile('01-PLAN.md'), true);
  });

  test('a 4-plan / 4-summary legacy phase scans as planCount:4 completed:true', () => {
    const tmp = createTempProject();
    const phaseDir = path.join(tmp, '.planning', 'phases', '14-legacy');
    fs.mkdirSync(phaseDir, { recursive: true });
    for (let i = 1; i <= 4; i++) {
      const nn = String(i).padStart(2, '0');
      fs.writeFileSync(path.join(phaseDir, `14-PLAN-${nn}.md`), '# Plan\n', 'utf-8');
      fs.writeFileSync(path.join(phaseDir, `14-PLAN-${nn}-SUMMARY.md`), '# Summary\n', 'utf-8');
    }
    try {
      const scan = scanPhasePlans(phaseDir);
      assert.equal(scan.planCount, 4, `expected 4 plans, got ${scan.planCount}`);
      assert.equal(scan.summaryCount, 4, `expected 4 summaries, got ${scan.summaryCount}`);
      assert.equal(scan.completed, true, 'a fully-summarized phase must scan as completed');
    } finally {
      cleanup(tmp);
    }
  });
});

describe('state planned-phase preserves curated milestone progress.* (#500 RC1)', () => {
  let tmpDir;

  // Curated progress counters that deliberately do NOT match what a disk scan
  // would derive (disk has only one near-empty phase dir). The bug rebuilds
  // progress.* from that disk snapshot, trampling these values.
  const STATE = `---
gsd_state_version: 1.0
milestone: v3.0
milestone_name: Active
status: in_progress
progress:
  total_phases: 7
  completed_phases: 5
  total_plans: 99
  completed_plans: 88
  percent: 88
---

# Project State

## Configuration
Current Phase: 2
Current Phase Name: builder
Total Plans in Phase: 0
Status: Not started
Last Activity: TBD
Last Activity Description: pending

## Current Position

Phase: 2 (builder)
Status: Not started
Last activity: TBD
`;

  beforeEach(() => {
    tmpDir = createTempProject();
    const planning = path.join(tmpDir, '.planning');
    fs.writeFileSync(path.join(planning, 'STATE.md'), STATE, 'utf-8');
    fs.writeFileSync(
      path.join(planning, 'ROADMAP.md'),
      '# Roadmap\n\n## 🚧 v3.0: Active\n\n### Phase 2: builder\n',
      'utf-8'
    );
    fs.writeFileSync(path.join(planning, 'config.json'), '{}', 'utf-8');
    // One sparse phase dir so a disk resync would derive small/zero counters.
    const dir = path.join(planning, 'phases', '02-builder');
    fs.mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  function readProgress() {
    const md = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    const block = md.split('---')[1] || '';
    const num = (key) => {
      const m = block.match(new RegExp(`${key}:\\s*(\\d+)`));
      return m ? Number(m[1]) : null;
    };
    return {
      total_plans: num('total_plans'),
      completed_plans: num('completed_plans'),
      total_phases: num('total_phases'),
      completed_phases: num('completed_phases'),
    };
  }

  test('planned-phase updates per-phase body fields but leaves milestone progress.* untouched', () => {
    const result = runGsdTools(['state', 'planned-phase', '--phase', '2', '--plans', '3'], tmpDir);
    assert.equal(result.success, true, result.error || result.output);

    // The command did its real job: per-phase "Total Plans in Phase" was set.
    const md = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.match(md, /Total Plans in Phase:\s*3/, 'per-phase Total Plans in Phase should be updated to 3');

    // ...but the curated milestone-wide progress block is preserved verbatim.
    assert.deepEqual(readProgress(), {
      total_plans: 99,
      completed_plans: 88,
      total_phases: 7,
      completed_phases: 5,
    }, 'curated milestone progress.* must survive a planned-phase write');
  });
});
